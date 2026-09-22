import { closeDb } from "../client";
import { migrateToLatest } from "../migrate";
import { findPartitionGaps, listPartitions } from "../partitions";

function coverageWindow(now = new Date()): Date[] {
  return [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))];
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  await migrateToLatest({
    onStep: (step, durationMs) => console.log(`✓ ${step} (${durationMs}ms)`),
  });

  const partitions = await listPartitions();
  console.log(`✓ checks partitions: ${partitions.join(", ")}`);

  const gaps = await findPartitionGaps(coverageWindow());
  if (gaps.length > 0) {
    throw new Error(`checks has no partition covering: ${gaps.join(", ")}`);
  }

  console.log(`✓ migrations applied in ${Date.now() - startedAt}ms`);
}

main()
  .then(async () => {
    await closeDb();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    console.error("✗ migration failed:", error);
    await closeDb().catch(() => {});
    process.exit(1);
  });
