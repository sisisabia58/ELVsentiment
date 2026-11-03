import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(import.meta.dirname, "../..");
const entry = "dist/scoring/cli.js";

function envWithoutSecrets(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.TYPESAFE_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.WORKER_DATABASE_URL;
  delete env.DATABASE_URL;
  delete env.MIGRATION_DATABASE_URL;
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function runBuilt(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: webRoot,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("built scoring entry", () => {
  it("exposes one-batch and loop npm scripts for the emitted file", () => {
    const scripts = JSON.parse(readFileSync(path.join(webRoot, "package.json"), "utf8")).scripts;
    expect(scripts.score).toBe("node dist/scoring/cli.js");
    expect(scripts["score:loop"]).toBe("exec node dist/scoring/cli.js --loop");
    expect(scripts.build).toBe("next build && node scripts/emit-score.mjs");
    expect(scripts.start).toBe("next start");
  });

  it("keeps the web service start command and gives scoring its own Railway file", () => {
    const web = readFileSync(path.join(webRoot, "railway.toml"), "utf8");
    const scoring = readFileSync(path.join(webRoot, "../../deploy/scoring.railway.toml"), "utf8");
    expect(web).toContain('startCommand = "npm run start"');
    expect(web).not.toContain("score:loop");
    expect(web).not.toContain("cronSchedule");
    expect(scoring).toContain('startCommand = "exec node dist/scoring/cli.js --loop"');
    expect(scoring).toContain("numReplicas = 1");
    expect(scoring).toContain('restartPolicyType = "ON_FAILURE"');
    expect(scoring).toContain('dockerfilePath = "deploy/web.Dockerfile"');
    expect(scoring).not.toContain("cronSchedule");
    expect(scoring).not.toContain("preDeployCommand");
    const operator = readFileSync(path.join(webRoot, "../../docs/operator-scoring.md"), "utf8");
    expect(operator).toContain("exec node dist/scoring/cli.js --loop");
    expect(operator).not.toContain("starts `npm run score:loop`");
  });

  it("emits a file that plain node can run", () => {
    const emit = spawnSync(process.execPath, ["scripts/emit-score.mjs"], {
      cwd: webRoot,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(emit.status, emit.stderr).toBe(0);

    const skipped = runBuilt([], envWithoutSecrets());
    expect(skipped.status, skipped.stderr).toBe(0);
    expect(skipped.stdout.trim()).toBe("scoring skipped: WORKER_DATABASE_URL is not set");

    const secret = "postgresql://worker:secret-do-not-log@127.0.0.1:1/sentiment";
    const missingKey = runBuilt([], envWithoutSecrets({ WORKER_DATABASE_URL: secret }));
    expect(missingKey.status, missingKey.stderr).toBe(0);
    expect(missingKey.stdout.trim()).toBe("scoring skipped: TYPESAFE_API_KEY is not set");
    expect(`${missingKey.stdout}\n${missingKey.stderr}`).not.toContain("secret-do-not-log");

    const loop = runBuilt(["--loop"], envWithoutSecrets({ TYPESAFE_API_KEY: "sk-live-do-not-log" }));
    expect(loop.status, loop.stderr).toBe(0);
    expect(loop.stdout.trim()).toBe("scoring skipped: WORKER_DATABASE_URL is not set");
    expect(`${loop.stdout}\n${loop.stderr}`).not.toContain("sk-live-do-not-log");
  });

  it("keeps node alive on the first SIGTERM to npm and exits 1 on the second", async () => {
    await expectSigtermTwice((env) =>
      spawn("npm", ["run", "score:loop"], {
        cwd: webRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  }, 20_000);

  it("keeps node alive on the first SIGTERM to the Railway start shell and exits 1 on the second", async () => {
    const scoring = readFileSync(path.join(webRoot, "../../deploy/scoring.railway.toml"), "utf8");
    const start = scoring.match(/startCommand = "([^"]+)"/)?.[1];
    expect(start).toBe("exec node dist/scoring/cli.js --loop");
    await expectSigtermTwice((env) =>
      spawn("sh", ["-c", start ?? ""], {
        cwd: webRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  }, 20_000);
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cmdline(pid: number): string {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
  } catch {
    return "";
  }
}

function childPids(pid: number): number[] {
  try {
    const text = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim();
    if (!text) return [];
    return text.split(/\s+/).map((value) => Number(value)).filter((value) => value > 0);
  } catch {
    return [];
  }
}

function walkPids(pid: number): number[] {
  return childPids(pid).flatMap((child) => [child, ...walkPids(child)]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

async function waitForNode(rootPid: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < 5_000) {
    if (cmdline(rootPid).includes("dist/scoring/cli.js")) return rootPid;
    for (const pid of walkPids(rootPid)) {
      if (cmdline(pid).includes("dist/scoring/cli.js")) return pid;
    }
    await delay(50);
  }
  throw new Error(`scoring process did not start under ${rootPid} (${cmdline(rootPid)})`);
}

function listenBlackhole(): Promise<{
  port: number;
  connected: Promise<void>;
  close: () => Promise<void>;
}> {
  const sockets: net.Socket[] = [];
  let markConnected = () => {};
  const connected = new Promise<void>((resolve) => {
    markConnected = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => {});
    markConnected();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected a tcp port"));
        return;
      }
      resolve({
        port: address.port,
        connected,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    });
  });
}

async function expectSigtermTwice(start: (env: NodeJS.ProcessEnv) => ChildProcess): Promise<void> {
  const emit = spawnSync(process.execPath, ["scripts/emit-score.mjs"], {
    cwd: webRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(emit.status, emit.stderr).toBe(0);

  const hole = await listenBlackhole();
  const secret = `postgresql://worker:secret-do-not-log@127.0.0.1:${hole.port}/sentiment`;
  const child = start(
    envWithoutSecrets({
      WORKER_DATABASE_URL: secret,
      TYPESAFE_API_KEY: "sk-live-do-not-log",
    }),
  );
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const rootPid = child.pid;
  if (!rootPid) throw new Error("spawn did not return a pid");
  let nodePid = 0;
  try {
    nodePid = await waitForNode(rootPid);
    const connected = await Promise.race([
      hole.connected.then(() => true),
      delay(5_000).then(() => false),
    ]);
    expect(connected, "batch never opened a database connection").toBe(true);
    process.kill(rootPid, "SIGTERM");
    await delay(1_000);
    expect(isAlive(rootPid), "root exited on the first SIGTERM").toBe(true);
    expect(isAlive(nodePid), "node exited on the first SIGTERM").toBe(true);
    process.kill(rootPid, "SIGTERM");
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      if (child.exitCode !== null) {
        resolve(child.exitCode);
        return;
      }
      const timer = setTimeout(() => reject(new Error("process stayed up after the second SIGTERM")), 5_000);
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exitCode).toBe(1);
    expect(isAlive(nodePid)).toBe(false);
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).not.toContain("secret-do-not-log");
    expect(text).not.toContain("sk-live-do-not-log");
  } finally {
    killPid(nodePid);
    for (const pid of [rootPid, ...walkPids(rootPid)]) killPid(pid);
    await hole.close();
  }
}
