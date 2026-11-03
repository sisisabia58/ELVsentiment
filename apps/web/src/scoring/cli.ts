import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import type { Queryable } from "../db/migrate";
import { TYPESAFE_URL } from "../jev/client";
import { postSystemOne } from "../jev/http";
import { scoreUnscoredMentions } from "./run";

export type CliConnection = Queryable & { end(): Promise<void> };

export async function main(input: {
  env: Record<string, string | undefined>;
  log: (message: string) => void;
  connect?: (url: string) => Promise<CliConnection>;
}): Promise<number> {
  const databaseUrl = input.env.WORKER_DATABASE_URL?.trim();
  if (!databaseUrl) {
    input.log("scoring skipped: WORKER_DATABASE_URL is not set");
    return 0;
  }
  const apiKey = input.env.TYPESAFE_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    input.log("scoring skipped: TYPESAFE_API_KEY is not set");
    return 0;
  }
  const connect = input.connect ?? connectWorker;
  const db = await connect(databaseUrl);
  try {
    await scoreUnscoredMentions(db, {
      env: input.env,
      log: input.log,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      random: Math.random,
      post: (body, apiKey) => postSystemOne(TYPESAFE_URL, body, apiKey),
      role: "worker",
    });
    return 0;
  } finally {
    await db.end();
  }
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

if (isProgramEntry()) {
  main({ env: process.env, log: (message) => console.log(message) }).then(
    (code) => {
      process.exit(code);
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      process.exit(1);
    },
  );
}
