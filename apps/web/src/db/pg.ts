import { Pool, type PoolClient } from "pg";
import type { Queryable } from "./migrate";

const ROLE_CHECK_SQL = `
  select current_user, session_user,
    r.rolsuper, r.rolbypassrls,
    s.rolsuper as session_super, s.rolbypassrls as session_bypass,
    coalesce((
      select c.relowner = r.oid or c.relowner = s.oid
      from pg_class c where c.oid = to_regclass('public.projects')
    ), false) as owns_projects
  from pg_roles r
  join pg_roles s on s.rolname = session_user
  where r.rolname = current_user
`;

let pool: Pool | null = null;
let roleAccepted = false;

// Built on first use: `next build` imports this module without a database.
function getPool(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL?.trim();
  // Without a connection string pg would fall back to the PG* variables.
  if (!connectionString) throw new Error("DATABASE_URL is required");
  pool = new Pool({ connectionString });
  // An idle client can be cut off by the server (restart, failover). Without a
  // listener the pool's "error" event would crash the process.
  pool.on("error", (error) => {
    console.error("postgres pool client error", error.message);
  });
  return pool;
}

// RLS is the tenant boundary, so a role that skips it must not serve requests.
async function assertRuntimeRole(client: PoolClient): Promise<void> {
  const result = await client.query<{
    current_user: string;
    session_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    session_super: boolean;
    session_bypass: boolean;
    owns_projects: boolean;
  }>(ROLE_CHECK_SQL);
  const role = result.rows[0];
  const loginIsAppUser = role?.current_user === "app_user" && role.session_user === "app_user";
  if (
    !role ||
    !loginIsAppUser ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.session_super ||
    role.session_bypass ||
    role.owns_projects
  ) {
    throw new Error(
      `refusing to serve as database role ${role?.current_user ?? "unknown"} (session ${role?.session_user ?? "unknown"}): the web pool only accepts app_user, and that login must not be a superuser, bypass RLS, or own public.projects`,
    );
  }
}

function clientQueryable(client: PoolClient): Queryable {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(sql, params);
      return { rows: result.rows as T[] };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

// One checked-out client per call keeps BEGIN, SET LOCAL, and COMMIT on the
// same connection. Do not route withCustomer through a pool-level query.
export async function withClient<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    if (!roleAccepted) {
      await assertRuntimeRole(client);
      roleAccepted = true;
    }
    return await fn(clientQueryable(client));
  } finally {
    client.release();
  }
}

export async function endPool(): Promise<void> {
  const current = pool;
  pool = null;
  roleAccepted = false;
  await current?.end();
}
