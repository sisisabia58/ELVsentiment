import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { Pool, roleRows, query } = vi.hoisted(() => {
  const roleRows: { value: Record<string, unknown>[] } = { value: [] };
  const query = vi.fn(async (sql: string) =>
    sql.includes("rolbypassrls") ? { rows: roleRows.value } : { rows: [] },
  );
  const client = { query, release: vi.fn() };
  const Pool = vi.fn(function (this: Record<string, unknown>) {
    this.connect = vi.fn(async () => client);
    this.on = vi.fn();
    this.end = vi.fn(async () => undefined);
  });
  return { Pool, roleRows, query };
});

vi.mock("pg", () => ({ Pool, default: { Pool } }));

const SAFE_ROLE = {
  current_user: "app_user",
  session_user: "app_user",
  rolsuper: false,
  rolbypassrls: false,
  session_super: false,
  session_bypass: false,
  owns_projects: false,
};

describe("web pool", () => {
  const previous = process.env.DATABASE_URL;

  beforeEach(() => {
    vi.resetModules();
    Pool.mockClear();
    query.mockClear();
    roleRows.value = [SAFE_ROLE];
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  });

  it("does not build a pool at import time", async () => {
    delete process.env.DATABASE_URL;
    await import("./pg");
    expect(Pool).not.toHaveBeenCalled();
  });

  it("does not fall back to MIGRATION_DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    process.env.MIGRATION_DATABASE_URL = "postgresql://postgres:owner-secret@127.0.0.1:5432/app";
    try {
      const { withClient } = await import("./pg");
      await expect(withClient(async () => "no")).rejects.toThrow("DATABASE_URL");
      expect(Pool).not.toHaveBeenCalled();
    } finally {
      delete process.env.MIGRATION_DATABASE_URL;
    }
  });

  it.each([undefined, "", "   "])("throws a DATABASE_URL error before connecting when it is %j", async (value) => {
    if (value === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = value;
    const { withClient } = await import("./pg");
    const fn = vi.fn();
    await expect(withClient(fn)).rejects.toThrow("DATABASE_URL");
    expect(Pool).not.toHaveBeenCalled();
    expect(fn).not.toHaveBeenCalled();
  });

  it.each([
    { rolsuper: true },
    { rolbypassrls: true },
    { owns_projects: true },
    { current_user: "worker_role", session_user: "worker_role" },
    { session_user: "postgres", session_super: true },
    { session_user: "postgres", session_bypass: true },
  ])("refuses to serve when the role has %j", async (flag) => {
    process.env.DATABASE_URL = "postgresql://app_user:x@127.0.0.1:5432/app";
    roleRows.value = [{ ...SAFE_ROLE, ...flag }];
    const { withClient } = await import("./pg");
    const fn = vi.fn();
    await expect(withClient(fn)).rejects.toThrow("refusing to serve");
    expect(fn).not.toHaveBeenCalled();
  });

  it("checks the role once and then serves", async () => {
    process.env.DATABASE_URL = "postgresql://app_user:x@127.0.0.1:5432/app";
    const { withClient } = await import("./pg");
    expect(await withClient(async () => "first")).toBe("first");
    expect(await withClient(async () => "second")).toBe("second");
    expect(Pool).toHaveBeenCalledTimes(1);
    expect(Pool).toHaveBeenCalledWith({ connectionString: "postgresql://app_user:x@127.0.0.1:5432/app" });
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("rolbypassrls"))).toHaveLength(1);
  });
});
