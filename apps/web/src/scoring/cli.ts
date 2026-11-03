import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import type { Queryable } from "../db/migrate";
import { TYPESAFE_URL } from "../jev/client";
import { postSystemOne } from "../jev/http";
import { scoreUnscoredMentions } from "./run";

export type CliConnection = Queryable & { end(): Promise<void> };

const DEFAULT_INTERVAL_MS = 20_000;
const MIN_INTERVAL_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 3600;

export function scoreIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env.SCORE_INTERVAL_SECONDS;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS || seconds > MAX_INTERVAL_SECONDS) {
    return DEFAULT_INTERVAL_MS;
  }
  return Math.round(seconds * 1000);
}

export function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function noteStopSignal(state: { stops: number; abort: () => void; exit: (code: number) => void }): void {
  state.stops += 1;
  state.abort();
  if (state.stops >= 2) state.exit(1);
}

const SECRET_ENV_NAMES = [
  "WORKER_DATABASE_URL",
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "TYPESAFE_API_KEY",
  "OPENROUTER_API_KEY",
] as const;

function batchFailureMessage(error: unknown, env: Record<string, string | undefined>): string {
  const raw = error instanceof Error ? error.message : String(error);
  let redacted = raw;
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value !== "") redacted = redacted.split(value).join("[redacted]");
  }
  redacted = redacted.replace(/\/\/([^:\s/]+):([^@\s/]+)@/g, "//$1:[redacted]@");
  return `scoring batch failed: ${redacted}`;
}

type BatchInput = {
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  connect?: (url: string) => Promise<CliConnection>;
  post?: (body: unknown, apiKey: string) => Promise<unknown>;
  limit?: number;
  random?: () => number;
};

type BatchOutcome =
  | { kind: "skipped" }
  | { kind: "ran"; scored: number; failed: number };

async function runOneBatch(input: BatchInput): Promise<BatchOutcome> {
  const databaseUrl = input.env.WORKER_DATABASE_URL?.trim();
  if (!databaseUrl) {
    input.log("scoring skipped: WORKER_DATABASE_URL is not set");
    return { kind: "skipped" };
  }
  const apiKey = input.env.TYPESAFE_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    input.log("scoring skipped: TYPESAFE_API_KEY is not set");
    return { kind: "skipped" };
  }
  const connect = input.connect ?? connectWorker;
  const db = await connect(databaseUrl);
  try {
    const result = await scoreUnscoredMentions(db, {
      env: input.env,
      log: input.log,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: input.random ?? Math.random,
      post: input.post ?? ((body, key) => postSystemOne(TYPESAFE_URL, body, key)),
      role: "worker",
      limit: input.limit,
    });
    return { kind: "ran", scored: result.scored, failed: result.failed };
  } finally {
    await db.end();
  }
}

export async function main(input: {
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  connect?: (url: string) => Promise<CliConnection>;
}): Promise<number> {
  await runOneBatch(input);
  return 0;
}

export async function runScoreLoop(input: BatchInput & {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  intervalMs?: number;
}): Promise<number> {
  const sleep = input.sleep ?? interruptibleSleep;
  const intervalMs = input.intervalMs ?? scoreIntervalMs(input.env);
  const signal = input.signal ?? new AbortController().signal;
  while (!signal.aborted) {
    try {
      const outcome = await runOneBatch(input);
      if (outcome.kind === "skipped") return 0;
      if (signal.aborted) return 0;
      if (outcome.scored === 0 && outcome.failed === 0) {
        await sleep(intervalMs, signal);
      }
    } catch (error) {
      if (signal.aborted) return 0;
      input.log(batchFailureMessage(error, input.env));
      await sleep(intervalMs, signal);
    }
  }
  return 0;
}

async function connectWorker(url: string): Promise<CliConnection> {
  const client = new Client({ connectionString: url });
  await client.connect();
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    end: () => client.end(),
  };
}

function isProgramEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

function isLoopArg(): boolean {
  return process.argv.includes("--loop");
}

if (isProgramEntry()) {
  const controller = new AbortController();
  const stopState = {
    stops: 0,
    abort: () => controller.abort(),
    exit: (code: number) => process.exit(code),
  };
  const onStop = () => noteStopSignal(stopState);
  process.on("SIGTERM", onStop);
  process.on("SIGINT", onStop);
  const log = (message: string) => console.log(message);
  const task = isLoopArg()
    ? runScoreLoop({ env: process.env, log, signal: controller.signal })
    : main({ env: process.env, log });
  task.then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      console.error(batchFailureMessage(error, process.env));
      process.exit(1);
    },
  );
}
