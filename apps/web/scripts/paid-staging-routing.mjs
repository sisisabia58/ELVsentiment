import pg from "pg";

const stagingId = "21ed6a58-5ece-4499-a657-3e814ba65767";
const mode = process.argv[2];
if (process.env.RAILWAY_ENVIRONMENT_ID !== stagingId || !["snapshot", "restore"].includes(mode)) {
  throw new Error("The paid search routing helper only runs on the approved staging environment.");
}
const migrationUrl = new URL(process.env.MIGRATION_DATABASE_URL);
if (migrationUrl.hostname !== "postgres.railway.internal") {
  throw new Error("Staging must use the environment-private Postgres endpoint.");
}
const db = new pg.Client({connectionString: migrationUrl.href});

try {
  await db.connect();
  await db.query("begin");
  await db.query("alter table provider_settings no force row level security");
  if (mode === "snapshot") {
    await db.query("create table if not exists cari_staging_routing_backup_91b547b as table provider_settings");
    await db.query("revoke all on cari_staging_routing_backup_91b547b from public, app_user, worker_role");
  } else {
    const {rows} = await db.query("select count(*)::int as count from cari_staging_routing_backup_91b547b");
    if (!rows[0].count) throw new Error("Staging routing backup is empty.");
    await db.query(`
      alter table provider_settings
        drop constraint provider_settings_provider_check,
        drop constraint provider_settings_fallback_check,
        add constraint provider_settings_provider_check check (provider in ('scrapecreators','scrapeatlas','official_x','off')),
        add constraint provider_settings_fallback_check check (fallback_provider is null or fallback_provider in ('scrapecreators','scrapeatlas','official_x'));
      insert into provider_settings (platform, provider, fallback_provider, fallback_on_failure, updated_by, updated_at)
      select platform, provider, fallback_provider, fallback_on_failure, updated_by, updated_at
      from cari_staging_routing_backup_91b547b
      on conflict (platform) do update set
        provider = excluded.provider,
        fallback_provider = excluded.fallback_provider,
        fallback_on_failure = excluded.fallback_on_failure,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;
    `);
  }
  await db.query("alter table provider_settings force row level security");
  await db.query("commit");
  console.log(`Staging routing ${mode} complete`);
} catch (error) {
  await db.query("rollback").catch(() => {});
  console.error("Staging routing helper failed", error.code ?? "guard");
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}

if (mode === "snapshot" && !process.exitCode) {
  await import("../src/db/migrate-cli.mjs");
}
