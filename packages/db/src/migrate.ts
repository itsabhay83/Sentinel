import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDedicatedClient } from "./client";
import { ensurePartitions } from "./partitions";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, "..", "migrations");

export interface MigrateOptions {
  /** Ceiling on how long a migration may wait behind a conflicting lock. */
  readonly lockTimeoutMs?: number;
  readonly onStep?: (step: string, durationMs: number) => void;
}

/**
 * Runs migrations on a dedicated connection.
 *
 * `set_config` is session-scoped, so raising `lock_timeout` through the pool
 * would land on whichever backend happened to answer and leave the migration
 * itself running on the pool default. A migration that blocks indefinitely
 * behind a long-running reader is indistinguishable from a hung deploy, so the
 * timeout has to apply to the session the DDL actually runs on.
 */
export async function migrateToLatest(options: MigrateOptions = {}): Promise<void> {
  const { lockTimeoutMs = 30_000, onStep } = options;
  const client = createDedicatedClient();

  const step = async (name: string, run: () => PromiseLike<unknown>): Promise<void> => {
    const startedAt = Date.now();
    await run();
    onStep?.(name, Date.now() - startedAt);
  };

  try {
    await step(
      "lock_timeout",
      () => client`SELECT set_config('lock_timeout', ${String(lockTimeoutMs)}, false)`,
    );
    await step("migrations", () => migrate(drizzle(client), { migrationsFolder }));
    // Partitions are data, not schema — they must exist before any insert lands.
    await step("partitions", () =>
      client.begin((tx) => ensurePartitions(tx, { monthsBack: 4, monthsForward: 1 })),
    );
  } finally {
    await client.end({ timeout: 5 });
  }
}
