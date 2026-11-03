import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { enableRoleLogin, migrate } from "./production-migrate.mjs";

const sqlDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "sql");

/** @param {string} url */
function urlSecrets(url) {
  try {
    const parsed = new URL(url);
    return [parsed.password, decodeURIComponent(parsed.password)];
  } catch {
    return [];
  }
}

/** @param {string} message */
function redact(message) {
  const url = process.env.MIGRATION_DATABASE_URL ?? "";
  const secrets = [url, ...urlSecrets(url), process.env.APP_DB_PASSWORD, process.env.WORKER_DB_PASSWORD]
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((a, b) => b.length - a.length);
  return secrets.reduce((text, secret) => text.split(secret).join("[redacted]"), message);
}

async function main() {
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error("MIGRATION_DATABASE_URL is required");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(client, { sqlDir });
    await enableRoleLogin(client, {
      appPassword: process.env.APP_DB_PASSWORD,
      workerPassword: process.env.WORKER_DB_PASSWORD,
    });
  } finally {
    await client.end();
  }
}

main().then(
  () => {
    console.log("migrations applied");
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${redact(message)}\n`);
    process.exitCode = 1;
  },
);
