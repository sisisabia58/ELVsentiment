import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { it, expect } from "vitest";

it("migrates legacy routes while preserving off, historical audit, and unchanged rows", async () => {
  const db = new PGlite();
  try {
    const dir = new URL("./sql/", import.meta.url);
    const files = readdirSync(dir).sort();
    for (const file of files.filter((name) => name < "015")) {
      await db.exec(readFileSync(new URL(file, dir), "utf8"));
    }
    await db.exec(`
      update provider_settings set provider='off' where platform='threads';
      update provider_settings set updated_at='2026-01-01' where platform='youtube';
      insert into provider_settings_audit(id, platform, new_provider, actor_email)
      values(gen_random_uuid(), 'threads', 'scrapecreators', 'historical');
    `);
    const migration = files.find((name) => name.startsWith("015"));
    expect(migration).toBeTruthy();
    await db.exec(readFileSync(new URL(migration!, dir), "utf8"));
    const {rows} = await db.query("select * from provider_settings order by platform");
    for (const row of rows as Record<string, unknown>[]) {
      expect(row.provider).toBe(["web", "threads"].includes(String(row.platform)) ? "off" : "scrapeatlas");
      expect(row.fallback_provider).toBe(null);
      expect(row.fallback_on_failure).toBe(false);
      if (row.platform === "youtube") expect(row.updated_at).toEqual(new Date("2026-01-01"));
    }
    expect((await db.query("select new_provider from provider_settings_audit")).rows)
      .toEqual([{ new_provider: "scrapecreators" }]);
    for (const assignment of ["provider='scrapecreators'", "provider='official_x'", "fallback_provider='scrapecreators'"]) {
      await expect(db.exec(`update provider_settings set ${assignment} where platform='x'`)).rejects.toThrow();
    }
    expect((await db.query("select relforcerowsecurity from pg_class where oid='provider_settings'::regclass")).rows)
      .toEqual([{ relforcerowsecurity: true }]);
  } finally {
    await db.close();
  }
}, 30000);
