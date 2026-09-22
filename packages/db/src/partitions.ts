import type postgres from "postgres";
import { sql as rawSql } from "./client";

/**
 * Monthly range partitions for the `checks` time series.
 *
 * Postgres will reject an insert that falls outside every partition, so the
 * scheduler calls `ensurePartitions` at boot and once an hour. There is
 * deliberately no DEFAULT partition: a silent catch-all makes later
 * `ATTACH PARTITION` calls fail and hides clock/retention bugs.
 *
 * Every mutating entry point takes a transaction so the caller can fence the
 * DDL against its leadership token in the same transaction.
 */

export type PartitionSql = postgres.TransactionSql;

/** Structurally satisfied by a pino logger; defaults to console. */
export interface PartitionLogger {
  warn(payload: Record<string, unknown>, message: string): void;
  error(payload: Record<string, unknown>, message: string): void;
}

const consoleLogger: PartitionLogger = {
  warn: (payload, message) => console.warn(message, payload),
  error: (payload, message) => console.error(message, payload),
};

function partitionName(year: number, month: number): string {
  return `checks_${year}_${String(month + 1).padStart(2, "0")}`;
}

function monthBounds(base: Date, offsetMonths: number): { start: Date; end: Date } {
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + offsetMonths, 1));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { start, end };
}

/**
 * Partition bounds and relation names are DDL — Postgres accepts no bind
 * parameter there, so both must be inlined. These values are computed
 * internally and re-validated here so the inlining can never carry input.
 */
function toDateLiteral(date: Date): string {
  const literal = date.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(literal)) {
    throw new Error(`refusing to inline malformed partition bound: ${literal}`);
  }
  return `'${literal}'`;
}

function toIdentifier(name: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to inline malformed partition name: ${name}`);
  }
  return `"${name}"`;
}

export interface EnsurePartitionsOptions {
  /** How many months of history to guarantee. Seeding needs several. */
  readonly monthsBack?: number;
  /** How many months ahead to pre-create. */
  readonly monthsForward?: number;
  readonly now?: Date;
}

export async function ensurePartitions(
  tx: PartitionSql,
  options: EnsurePartitionsOptions = {},
): Promise<string[]> {
  const { monthsBack = 3, monthsForward = 1, now = new Date() } = options;
  const created: string[] = [];

  for (let offset = -monthsBack; offset <= monthsForward; offset += 1) {
    const { start, end } = monthBounds(now, offset);
    const name = partitionName(start.getUTCFullYear(), start.getUTCMonth());
    await tx.unsafe(
      `CREATE TABLE IF NOT EXISTS ${toIdentifier(name)} PARTITION OF checks ` +
        `FOR VALUES FROM (${toDateLiteral(start)}) TO (${toDateLiteral(end)})`,
    );
    created.push(name);
  }

  return created;
}

interface PartitionBound {
  child: string;
  upper_bound: string | null;
}

export interface DropExpiredOptions {
  readonly now?: Date;
  readonly logger?: PartitionLogger;
}

export interface DropExpiredResult {
  readonly dropped: string[];
  /** Partitions whose bound could not be read — they can never age out. */
  readonly unparseable: string[];
}

/**
 * Retention: drop whole partitions rather than issuing DELETEs. Dropping a
 * partition is O(1) and never bloats the table.
 *
 * A bound that will not parse is reported rather than skipped. Skipping it
 * silently is how a cluster ends up carrying every partition it ever created
 * with nothing in the logs to say why.
 */
export async function dropExpiredPartitions(
  tx: PartitionSql,
  retentionDays: number,
  options: DropExpiredOptions = {},
): Promise<DropExpiredResult> {
  const { now = new Date(), logger = consoleLogger } = options;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  const rows = await tx<PartitionBound[]>`
    SELECT
      child.relname AS child,
      (regexp_match(pg_get_expr(child.relpartbound, child.oid), 'TO \\(''([^'']+)''\\)'))[1] AS upper_bound
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'checks'
  `;

  const dropped: string[] = [];
  const unparseable: string[] = [];

  for (const row of rows) {
    const upperBound = row.upper_bound === null ? null : new Date(row.upper_bound);
    if (upperBound === null || Number.isNaN(upperBound.getTime())) {
      unparseable.push(row.child);
      logger.error(
        { partition: row.child, upperBound: row.upper_bound },
        "check partition has an unreadable upper bound and will never be aged out",
      );
      continue;
    }
    if (upperBound > cutoff) continue;
    await tx.unsafe(`DROP TABLE IF EXISTS ${toIdentifier(row.child)}`);
    dropped.push(row.child);
  }

  return { dropped, unparseable };
}

export async function listPartitions(): Promise<string[]> {
  const rows = await rawSql<{ child: string }[]>`
    SELECT child.relname AS child
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    WHERE parent.relname = 'checks'
    ORDER BY child.relname
  `;
  return rows.map((row) => row.child);
}

/**
 * Names the partitions that should exist to cover `instants` but do not.
 *
 * There is no DEFAULT partition, so a gap is not a degradation — every insert
 * landing in it fails outright and the region stops reporting. Callers log this
 * at error level.
 */
export async function findPartitionGaps(instants: readonly Date[]): Promise<string[]> {
  const existing = new Set(await listPartitions());
  const missing = new Set<string>();
  for (const instant of instants) {
    const name = partitionName(instant.getUTCFullYear(), instant.getUTCMonth());
    if (!existing.has(name)) missing.add(name);
  }
  return [...missing];
}
