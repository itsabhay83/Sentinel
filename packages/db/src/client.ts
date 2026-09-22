import { getServerEnv } from "@sentinel/shared/env";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index";

/**
 * Shared Postgres connection.
 *
 * Cached on globalThis so Next.js dev HMR and repeated module loads reuse one
 * pool instead of exhausting Postgres connections.
 */

type DbGlobal = typeof globalThis & {
  __sentinelSql?: ReturnType<typeof postgres>;
  __sentinelDrizzleSql?: ReturnType<typeof postgres>;
  __sentinelDb?: ReturnType<typeof buildDb>;
};

function buildDb(client: ReturnType<typeof postgres>) {
  return drizzle(client, { schema });
}

const globalRef = globalThis as DbGlobal;

/**
 * Applied per connection so a pathological query can never pin a backend
 * indefinitely, and an abandoned transaction can never hold row locks that
 * stall the scheduler's `FOR UPDATE SKIP LOCKED` claims.
 */
function connectionTimeouts(env: ReturnType<typeof getServerEnv>): Record<string, string> {
  return {
    statement_timeout: String(env.DB_STATEMENT_TIMEOUT_MS),
    lock_timeout: String(env.DB_LOCK_TIMEOUT_MS),
    idle_in_transaction_session_timeout: String(env.DB_IDLE_TX_TIMEOUT_MS),
  };
}

function createClient(max: number): ReturnType<typeof postgres> {
  const env = getServerEnv();
  return postgres(env.DATABASE_URL, {
    max,
    idle_timeout: 30,
    connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
    connection: connectionTimeouts(env),
    onnotice: () => {},
  });
}

/**
 * `drizzle()` mutates the client it is handed: it replaces the postgres-js
 * parsers AND serializers for every date/time OID (1184, 1082, 1083, 1114, and
 * the array variants) with an identity function, because drizzle maps those
 * values itself from the column definition. That is correct for drizzle and
 * silently wrong for everyone else -- a shared client would hand every raw
 * `sql` query an ISO *string* where the row types in apps/web say `Date`, so
 * `checkedAt.getTime()` throws at render time rather than failing a typecheck.
 *
 * So each library gets its own client, configured the way it expects. The pool
 * is split rather than doubled: DB_POOL_MAX is a budget against the server's
 * max_connections, and quietly opening twice the advertised number of
 * connections is how a deploy discovers that limit in production.
 */
function splitPool(total: number): number {
  return Math.max(2, Math.ceil(total / 2));
}

const totalPoolMax = (() => {
  const env = getServerEnv();
  return env.DB_POOL_MAX > 0 ? env.DB_POOL_MAX : env.NODE_ENV === "production" ? 20 : 8;
})();

export const sql = globalRef.__sentinelSql ?? createClient(splitPool(totalPoolMax));
const drizzleClient = globalRef.__sentinelDrizzleSql ?? createClient(splitPool(totalPoolMax));
export const db = globalRef.__sentinelDb ?? buildDb(drizzleClient);

if (process.env.NODE_ENV !== "production") {
  globalRef.__sentinelSql = sql;
  globalRef.__sentinelDrizzleSql = drizzleClient;
  globalRef.__sentinelDb = db;
}

export type Database = typeof db;

/** Opens a dedicated connection — used by the scheduler's advisory-lock session. */
export function createDedicatedClient(): ReturnType<typeof postgres> {
  const env = getServerEnv();
  return postgres(env.DATABASE_URL, {
    max: 1,
    idle_timeout: 0,
    connect_timeout: env.DB_CONNECT_TIMEOUT_SECONDS,
    connection: connectionTimeouts(env),
    onnotice: () => {},
  });
}

export async function closeDb(): Promise<void> {
  // Both pools, or graceful shutdown leaves the drizzle connections open and
  // the process hangs on a handle nothing is tracking.
  await Promise.all([sql.end({ timeout: 5 }), drizzleClient.end({ timeout: 5 })]);
}

/**
 * Re-exported so every `import { withDbRetry } from "@sentinel/db"` keeps working.
 * It lives in ./retry because this module builds the pool at import time, and the
 * retry ladder is pure control flow that deserves a test without a database.
 */
export { withDbRetry } from "./retry";
