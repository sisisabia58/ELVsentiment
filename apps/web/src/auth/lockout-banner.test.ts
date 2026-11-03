import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable, type Queryable } from "../db/migrate";
import { lockoutRefreshPlan, signInLockoutBanner, visibleAuthBanner } from "./lockout-banner";
import { authThrottleLockExpiresAt } from "./throttle";

const now = new Date("2026-11-02T04:00:00.000Z");
const stale = "Terlalu banyak percobaan. Coba lagi dalam 15 menit.";

describe("sign-in lockout banner", () => {
  it("shows the banner while the server lock expiry is later than now", () => {
    const lockExpiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    expect(
      signInLockoutBanner({
        now,
        lockExpiresAt,
        searchParams: null,
        cookie: null,
      }),
    ).toBe(stale);
  });

  it("hides the banner when the lock expiry is not later than now, even with a stale query or cookie", () => {
    expect(
      signInLockoutBanner({
        now,
        lockExpiresAt: new Date(now.getTime() - 1000),
        searchParams: { error: stale },
        cookie: stale,
      }),
    ).toBeNull();
    expect(
      signInLockoutBanner({
        now,
        lockExpiresAt: now,
        searchParams: { error: stale },
        cookie: "lockout=1",
      }),
    ).toBeNull();
  });

  it("waits while the expiry is still ahead and refreshes once that moment has passed", () => {
    const now = Date.parse("2026-11-02T04:00:00.000Z");
    expect(lockoutRefreshPlan("2026-11-02T04:00:05.000Z", now)).toEqual({ action: "wait", ms: 5_000 });
    expect(lockoutRefreshPlan("2026-11-02T04:00:00.100Z", now + 50)).toEqual({ action: "wait", ms: 50 });
    expect(lockoutRefreshPlan("2026-11-02T04:00:00.000Z", now)).toEqual({ action: "refresh" });
    expect(lockoutRefreshPlan("2026-11-02T03:59:00.000Z", now)).toEqual({ action: "refresh" });
    expect(lockoutRefreshPlan(null, now)).toBeNull();
    expect(lockoutRefreshPlan("not-a-date", now)).toBeNull();
  });

  it("shows the server lock message even when the browser clock is past the expiry", () => {
    expect(
      visibleAuthBanner({
        now: new Date("2026-11-02T05:00:00.000Z"),
        error: null,
        serverLockExpiresAt: "2026-11-02T04:01:00.000Z",
        lockMessage: "Terlalu banyak percobaan. Coba lagi dalam 4 menit.",
      }),
    ).toBe("Terlalu banyak percobaan. Coba lagi dalam 4 menit.");
  });

  it("shows the action's server message instead of minutes recomputed from the client clock", () => {
    expect(
      visibleAuthBanner({
        now: new Date("2026-11-02T04:00:00.000Z"),
        error: "Terlalu banyak percobaan. Coba lagi dalam 4 menit.",
        actionLockExpiresAt: "2026-11-02T04:15:00.000Z",
      }),
    ).toBe("Terlalu banyak percobaan. Coba lagi dalam 4 menit.");
  });

  it("hides the banner when there is no lock, even with a stale query or cookie", () => {
    expect(
      signInLockoutBanner({
        now,
        lockExpiresAt: null,
        searchParams: { error: stale },
        cookie: stale,
      }),
    ).toBeNull();
  });
});

async function freshDb(): Promise<Queryable> {
  const db = pgliteQueryable(new PGlite());
  await applyMigration(db);
  return db;
}

function ipKey(ip: string): string {
  return createHash("sha256").update(`ip:${ip}`).digest("hex");
}

describe("auth throttle lock expiry", () => {
  it("returns an expiry only while the stored window is still later than now", async () => {
    const db = await freshDb();
    const key = ipKey("203.0.113.8");
    expect(await authThrottleLockExpiresAt(db, [key])).toBeNull();

    await db.exec("begin");
    await db.query("select set_config('app.throttle_key', $1, true)", [key]);
    await db.exec("set local role app_user");
    await db.query(
      `insert into auth_throttle (attempt_key, failures, window_started_at)
       values (current_setting('app.throttle_key', true), 5, now())`,
    );
    await db.exec("commit");

    const active = await authThrottleLockExpiresAt(db, [key]);
    expect(active).not.toBeNull();
    expect(active!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(active!.retryMinutes).toBeGreaterThanOrEqual(1);

    await db.query("update auth_throttle set window_started_at = now() - interval '16 minutes'");
    expect(await authThrottleLockExpiresAt(db, [key])).toBeNull();
  });
});
