import type postgres from "postgres";

import { sql as rawSql } from "@sentinel/db";

import { logger } from "./logger";

export type Sql = postgres.TransactionSql;

/** The token a scheduler was elected with, and the instance that holds it. */
export interface LeaderFence {
  readonly token: number;
  readonly holderId: string;
}

type FencedOutcome<T> = { readonly fenced: false } | { readonly fenced: true; readonly value: T };

/**
 * Runs `task` only while `fence.token` is still the live leadership token.
 *
 * `FOR SHARE` on the single `scheduler_leadership` row is what makes this a
 * fence rather than a hopeful comparison: a rival taking over must bump
 * `fencing_token` on that same row, so its UPDATE waits until this transaction
 * commits and cannot interleave with a destructive write already in flight.
 * Once the token has moved, every later call here reads the new value and
 * declines — a scheduler that lost its session can no longer write at all.
 */
export async function withFence<T>(
  fence: LeaderFence,
  task: string,
  run: (tx: Sql) => Promise<T>,
): Promise<T | null> {
  const outcome: FencedOutcome<T> = await rawSql.begin(async (tx) => {
    const [live] = await tx<{ token: string; holder_id: string | null }[]>`
      SELECT fencing_token::text AS token, holder_id
      FROM scheduler_leadership
      WHERE id = 'global'
      FOR SHARE
    `;
    if (!live || Number.parseInt(live.token, 10) !== fence.token) {
      return { fenced: false } satisfies FencedOutcome<T>;
    }
    return { fenced: true, value: await run(tx) } satisfies FencedOutcome<T>;
  });

  if (!outcome.fenced) {
    logger.warn(
      { task, token: fence.token, holderId: fence.holderId },
      "fencing token superseded; skipping leader-only write",
    );
    return null;
  }
  return outcome.value;
}
