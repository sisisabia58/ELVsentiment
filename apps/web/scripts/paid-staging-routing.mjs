import { spawn } from "node:child_process";
import pg from "pg";

const stagingId = "21ed6a58-5ece-4499-a657-3e814ba65767";
const serve = process.argv[2] === "restore-and-serve";
const mode = serve ? "restore" : process.argv[2];
if (process.env.RAILWAY_ENVIRONMENT_ID !== stagingId || !["snapshot", "restore", "audit"].includes(mode)) {
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
  if (mode === "audit" || mode === "restore") {
    const searchIds = process.argv.slice(3);
    if (searchIds.some((id) => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
      throw new Error("Expected only staging search UUIDs.");
    }
    if (searchIds.length) {
      const tables = ["instant_searches", "search_credit_ledger", "instant_search_ai", "instant_search_questions"];
      for (const table of tables) await db.query(`alter table ${table} no force row level security`);
      const audit = await db.query(`
        select s.id, s.query_text, s.status, s.summary_status, s.user_credits,
          s.credits_used, a.model as summary_model, a.cost_usd as summary_cost_usd,
          (select coalesce(jsonb_agg(jsonb_build_object(
            'provider', l.provider, 'platform', l.platform, 'route', l.route,
            'credits', l.credits_charged, 'status', l.http_status, 'detail', l.safe_detail
          ) order by l.created_at), '[]'::jsonb)
          from search_credit_ledger l where l.search_id = s.id) as calls,
          (select coalesce(jsonb_agg(jsonb_build_object(
            'status', q.status, 'user_credits', q.user_credits
          )), '[]'::jsonb)
          from instant_search_questions q where q.search_id = s.id) as questions
        from instant_searches s
        left join instant_search_ai a on a.search_id = s.id
        where s.id = any($1::uuid[])
        order by s.created_at
      `, [searchIds]);
      for (const table of tables) await db.query(`alter table ${table} force row level security`);
      for (const row of audit.rows) console.log("Paid staging audit", JSON.stringify(row));
    }
  }

  if (mode !== "audit") await db.query("alter table provider_settings no force row level security");
  if (mode === "snapshot") {
    await db.query("create table if not exists cari_staging_routing_backup_91b547b as table provider_settings");
    await db.query("revoke all on cari_staging_routing_backup_91b547b from public, app_user, worker_role");
  } else if (mode === "restore") {
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
  if (mode !== "audit") await db.query("alter table provider_settings force row level security");
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

if (serve && !process.exitCode) {
  const web = spawn("npm", ["run", "start"], {stdio: "inherit"});
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => web.kill(signal));
  }
  web.on("exit", (code) => { process.exitCode = code ?? 1; });
}
