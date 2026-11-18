import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigration, pgliteQueryable } from "@/db/migrate";
import { loadProviderSettings, saveProviderSetting } from "./provider-settings";

describe("provider settings", () => {
  it("saves an admin change and appends an audit row", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const result = await saveProviderSetting(db, {
      actorEmail: "owner@example.com",
      customerId: "00000000-0000-0000-0000-000000000000",
      sessionTokenHash: "synthetic-token-hash",
      platform: "youtube",
      provider: "scrapeatlas",
      fallbackProvider: null,
      fallbackOnFailure: false,
    });
    expect(result.ok).toBe(true);
    const saved = await loadProviderSettings(db);
    expect(saved.youtube.provider).toBe("scrapeatlas");
    const audit = await db.query<{ n: number }>("select count(*)::int as n from provider_settings_audit");
    expect(audit.rows[0]?.n).toBe(1);
  });

  it("rejects Instagram on ScrapeCreators without writing", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const result = await saveProviderSetting(db, {
      actorEmail: "owner@example.com",
      customerId: "00000000-0000-0000-0000-000000000000",
      sessionTokenHash: "synthetic-token-hash",
      platform: "instagram",
      provider: "scrapecreators",
      fallbackProvider: null,
      fallbackOnFailure: false,
    });
    expect(result).toEqual({ ok: false, error: "unsupported_provider" });
    const audit = await db.query<{ n: number }>("select count(*)::int as n from provider_settings_audit");
    expect(audit.rows[0]?.n).toBe(0);
  });

  it("records the old values, supports fallback and off, and rejects a missing fallback", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    await saveProviderSetting(db, {
      actorEmail: "owner@example.com",
      customerId: "00000000-0000-0000-0000-000000000000",
      sessionTokenHash: "synthetic-token-hash",
      platform: "threads",
      provider: "off",
      fallbackProvider: null,
      fallbackOnFailure: false,
    });
    const saved = await loadProviderSettings(db);
    expect(saved.threads).toEqual({
      provider: "off",
      fallbackProvider: null,
      fallbackOnFailure: false,
    });
    const audit = await db.query<{
      old_provider: string | null;
      new_provider: string;
      old_fallback_provider: string | null;
      new_fallback_provider: string | null;
      old_fallback_on_failure: boolean | null;
      new_fallback_on_failure: boolean;
      actor_email: string;
    }>("select * from provider_settings_audit order by created_at");

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      old_provider: "scrapeatlas",
      new_provider: "off",
      old_fallback_provider: null,
      new_fallback_provider: null,
      old_fallback_on_failure: false,
      new_fallback_on_failure: false,
    });

    const rejected = await saveProviderSetting(db, {
      actorEmail: "owner@example.com",
      customerId: "00000000-0000-0000-0000-000000000000",
      sessionTokenHash: "synthetic-token-hash",
      platform: "youtube",
      provider: "scrapeatlas",
      fallbackProvider: null,
      fallbackOnFailure: true,
    });
    expect(rejected).toEqual({ ok: false, error: "unsupported_provider" });
  });

  it("rejects unknown targets and unsupported fallbacks without writing", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    expect(
      await saveProviderSetting(db, {
        actorEmail: "owner@example.com",
      customerId: "00000000-0000-0000-0000-000000000000",
      sessionTokenHash: "synthetic-token-hash",
        platform: "myspace",
        provider: "scrapeatlas",
        fallbackProvider: null,
        fallbackOnFailure: false,
      }),
    ).toEqual({ ok: false, error: "unknown_platform" });
    expect(
      await saveProviderSetting(db, {
        actorEmail: "owner@example.com",
      customerId: "00000000-0000-0000-0000-000000000000",
      sessionTokenHash: "synthetic-token-hash",
        platform: "youtube",
        provider: "scrapeatlas",
        fallbackProvider: "scrapecreators",
        fallbackOnFailure: true,
      }),
    ).toEqual({ ok: false, error: "unsupported_provider" });
    const audit = await db.query<{ n: number }>("select count(*)::int as n from provider_settings_audit");
    expect(audit.rows[0]?.n).toBe(0);
  });

  it("loads the comments routing row and merges defaults", async () => {
    const db = pgliteQueryable(new PGlite());
    await applyMigration(db);
    const initial = await loadProviderSettings(db);
    expect(initial.comments.provider).toBe("scrapeatlas");
    expect(initial.web.provider).toBe("off");
    await db.query("delete from provider_settings where platform = 'reddit'");
    const merged = await loadProviderSettings(db);
    expect(merged.reddit.provider).toBe("scrapeatlas");
  });
});
