import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Queryable } from "../db/migrate";
import { withCustomer } from "../db/migrate";
import type { SourceCredentials } from "../monitor/onboarding-draft";
import { ALL_SOURCES, sourceCredentials, type SourceId } from "../monitor/policy";
import { nextDailyInstant } from "../monitor/schedule-choice";

export type ScheduleLimits = {
  scheduleMinIntervalHours: number;
  manualMinIntervalSeconds: number;
  workerHeartbeatStaleSeconds: number;
};

function fromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) throw new Error(`invalid_${name}`);
  return parsed;
}

// Same names as the worker's load_limits and .env.example. The file is the
// shared default; an env override applies in both processes.
export function readLimits(file?: string): ScheduleLimits {
  const configDir = process.env.CONFIG_DIR?.trim();
  const resolved =
    file ??
    (configDir
      ? path.join(configDir, "limits.json")
      : path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../config/limits.json"));
  const parsed = JSON.parse(readFileSync(resolved, "utf8")) as {
    schedule_min_interval_hours: number;
    manual_min_interval_seconds: number;
    worker_heartbeat_stale_seconds: number;
  };
  return {
    scheduleMinIntervalHours: fromEnv("SCHEDULE_MIN_INTERVAL_HOURS", parsed.schedule_min_interval_hours),
    manualMinIntervalSeconds: fromEnv("MANUAL_MIN_INTERVAL_SECONDS", parsed.manual_min_interval_seconds),
    workerHeartbeatStaleSeconds: fromEnv("WORKER_HEARTBEAT_STALE_SECONDS", parsed.worker_heartbeat_stale_seconds),
  };
}

export type ScheduleWrite = {
  enabled: boolean;
  intervalHours: number;
  cadence: "interval" | "daily";
  dailyMinute: number | null;
  now: Date;
};

export function normalizeSchedule(
  input: {
    enabled: boolean;
    intervalHours: number;
    cadence?: "interval" | "daily";
    dailyMinute?: number | null;
    now?: Date;
  },
  limits: ScheduleLimits = readLimits(),
): { ok: true; value: ScheduleWrite } | { ok: false; reason: "interval_too_short" } {
  const cadence = input.cadence ?? "interval";
  const intervalHours = cadence === "daily" ? 24 : input.intervalHours;
  if (intervalHours < limits.scheduleMinIntervalHours) return { ok: false, reason: "interval_too_short" };
  const dailyMinute =
    cadence === "daily" && input.dailyMinute != null ? Math.min(1439, Math.max(0, Math.floor(input.dailyMinute))) : null;
  return { ok: true, value: { enabled: input.enabled, intervalHours, cadence, dailyMinute, now: input.now ?? new Date() } };
}

// Caller already holds the customer transaction. Opening another one would commit early.
export async function applySchedule(
  db: Queryable,
  customerId: string,
  projectId: string,
  input: ScheduleWrite,
): Promise<{ ok: true; nextRunAt: string | null }> {
  const existing = await db.query<{ last_collected_at: string | null }>(
    "select last_collected_at from project_schedules where project_id = $1 and customer_id = $2",
    [projectId, customerId],
  );
  const last = existing.rows[0]?.last_collected_at ?? null;
  let nextRunAt: string | null = null;
  if (input.enabled) {
    if (input.cadence === "daily" && input.dailyMinute != null) {
      nextRunAt = nextDailyInstant(input.dailyMinute, input.now).toISOString();
    } else {
      const base = last ? new Date(last) : new Date();
      if (last) base.setTime(base.getTime() + input.intervalHours * 60 * 60 * 1000);
      nextRunAt = base.toISOString();
    }
  }
  await db.query(
    `insert into project_schedules
       (project_id, customer_id, enabled, interval_hours, time_zone, next_run_at, cadence, daily_minute)
     values ($1, $2, $3, $4, 'Asia/Jakarta', $5, $6, $7)
     on conflict (project_id) do update
       set enabled = excluded.enabled,
           interval_hours = excluded.interval_hours,
           time_zone = 'Asia/Jakarta',
           next_run_at = excluded.next_run_at,
           cadence = excluded.cadence,
           daily_minute = excluded.daily_minute`,
    [projectId, customerId, input.enabled, input.intervalHours, nextRunAt, input.cadence, input.dailyMinute],
  );
  return { ok: true, nextRunAt };
}

export async function saveSchedule(
  db: Queryable,
  customerId: string,
  projectId: string,
  input: {
    enabled: boolean;
    intervalHours: number;
    cadence?: "interval" | "daily";
    dailyMinute?: number | null;
    now?: Date;
  },
  limits: ScheduleLimits = readLimits(),
): Promise<{ ok: true; nextRunAt: string | null } | { ok: false; reason: "interval_too_short" }> {
  const normalized = normalizeSchedule(input, limits);
  if (!normalized.ok) return normalized;
  return withCustomer(db, customerId, () => applySchedule(db, customerId, projectId, normalized.value));
}

function enabledSources(value: unknown): SourceId[] {
  if (value == null) return [...ALL_SOURCES];
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.replace(/^\{|\}$/g, "").split(",").map((item) => item.trim()).filter(Boolean)
      : [];
  return items.filter(
    (item): item is SourceId =>
      item === "x" || item === "threads" || item === "instagram" || item === "tiktok",
  );
}

export async function requestManualRun(
  db: Queryable,
  customerId: string,
  projectId: string,
  now: Date,
  limits: ScheduleLimits = readLimits(),
  credentials: SourceCredentials = sourceCredentials(),
): Promise<
  | { ok: true; jobId: string }
  | { ok: false; reason: "manual_rate_limited"; retryAt: string }
  | { ok: false; reason: "run_in_progress"; jobId: string }
  | { ok: false; reason: "sources_unavailable" }
> {
  return withCustomer(db, customerId, async () => {
    await db.query("select pg_advisory_xact_lock(hashtext($1::text))", [customerId]);
    const settings = await db.query<{ enabled_sources: unknown }>(
      "select enabled_sources from project_settings where project_id = $1",
      [projectId],
    );
    const selected = enabledSources(settings.rows.length === 0 ? null : settings.rows[0]?.enabled_sources);
    if (!selected.some((source) => Boolean(credentials[source]))) {
      return { ok: false as const, reason: "sources_unavailable" as const };
    }
    const recent = await db.query<{ created_at: string }>(
      `select created_at from jobs
       where customer_id = $1 and project_id = $2 and kind = 'manual' and status <> 'deferred'
       order by created_at desc
       limit 1`,
      [customerId, projectId],
    );
    const last = recent.rows[0]?.created_at;
    if (last) {
      const retryAt = new Date(new Date(last).getTime() + limits.manualMinIntervalSeconds * 1000);
      if (retryAt > now) return { ok: false as const, reason: "manual_rate_limited" as const, retryAt: retryAt.toISOString() };
    }
    const active = await db.query<{ id: string }>(
      `select id from jobs
       where customer_id = $1 and project_id = $2 and status in ('queued', 'claimed')
       limit 1`,
      [customerId, projectId],
    );
    if (active.rows.length > 0) {
      const jobId = randomUUID();
      await db.query(
        `insert into jobs (id, customer_id, project_id, kind, status, run_after, status_detail, created_at)
         values ($1, $2, $3, 'manual', 'deferred', $4, 'skipped_overlap', $4)`,
        [jobId, customerId, projectId, now.toISOString()],
      );
      return { ok: false as const, reason: "run_in_progress" as const, jobId };
    }
    const jobId = randomUUID();
    await db.query(
      `insert into jobs (id, customer_id, project_id, kind, status, run_after, status_detail, created_at)
       values ($1, $2, $3, 'manual', 'queued', $4, null, $4)`,
      [jobId, customerId, projectId, now.toISOString()],
    );
    return { ok: true as const, jobId };
  });
}

export async function collectionControlState(
  db: Queryable,
  customerId: string,
  now: Date,
  limits: ScheduleLimits = readLimits(),
): Promise<{ manualBlocked: boolean; retryAt: string | null; lastSeenAt: string | null }> {
  return withCustomer(db, customerId, async () => {
    const recent = await db.query<{ created_at: string }>(
      `select created_at from jobs
       where customer_id = $1 and kind = 'manual' and status <> 'deferred'
       order by created_at desc
       limit 1`,
      [customerId],
    );
    const beat = await db.query<{ last_seen_at: string | Date }>(
      "select last_seen_at from worker_heartbeat where id = 1",
    );
    const last = recent.rows[0]?.created_at;
    const rawSeen = beat.rows[0]?.last_seen_at ?? null;
    const lastSeenAt = rawSeen instanceof Date ? rawSeen.toISOString() : rawSeen;
    if (!last) return { manualBlocked: false, retryAt: null, lastSeenAt };
    const retryAt = new Date(new Date(last).getTime() + limits.manualMinIntervalSeconds * 1000);
    if (retryAt > now) {
      return { manualBlocked: true, retryAt: retryAt.toISOString(), lastSeenAt };
    }
    return { manualBlocked: false, retryAt: null, lastSeenAt };
  });
}
