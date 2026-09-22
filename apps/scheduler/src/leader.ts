import { randomBytes } from "node:crypto";
import { hostname } from "node:os";

import { createDedicatedClient } from "@sentinel/db";

import type { LeaderFence } from "./fencing";
import { logger } from "./logger";

/**
 * Arbitrary but fixed 64-bit key. Postgres advisory locks live in a single
 * global namespace, so the constant must never be reused by another feature.
 */
const LEADER_LOCK_KEY = 0x53_45_4e_54_49_4e_45_00n;

/** Written to `scheduler_leadership.holder_id`; unique per process, stable for its life. */
export const INSTANCE_ID = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;

export class LeaderElection {
  private readonly client = createDedicatedClient();
  private fence: LeaderFence | null = null;
  private sessionPid: number | null = null;

  get isLeader(): boolean {
    return this.fence !== null;
  }

  get currentFence(): LeaderFence | null {
    return this.fence;
  }

  /**
   * Re-proves leadership every tick and returns the fence to write under.
   *
   * Advisory locks are session-scoped, so a connection that drops silently
   * hands the lock to the next acquirer while this process still believes it
   * holds one. Ownership is therefore read back out of `pg_locks` against this
   * session's own backend pid rather than cached. Any failure to prove it is
   * treated as loss: standing down costs one tick of maintenance, whereas
   * failing open means two schedulers run housekeeping at once.
   */
  async tryAcquire(): Promise<LeaderFence | null> {
    try {
      const fence = this.fence === null ? await this.acquire() : await this.reverify(this.fence);
      this.fence = fence;
      return fence;
    } catch (error) {
      logger.error(
        { err: error, holderId: INSTANCE_ID, wasLeader: this.fence !== null },
        "leadership could not be verified; standing down",
      );
      this.fence = null;
      this.sessionPid = null;
      return null;
    }
  }

  private async acquire(): Promise<LeaderFence | null> {
    const [row] = await this.client<{ locked: boolean; pid: number }[]>`
      SELECT pg_try_advisory_lock(${LEADER_LOCK_KEY.toString()}::bigint) AS locked,
             pg_backend_pid() AS pid
    `;
    if (row?.locked !== true) return null;

    this.sessionPid = row.pid;
    try {
      const token = await this.bumpFencingToken();
      logger.info({ holderId: INSTANCE_ID, pid: row.pid, token }, "acquired scheduler leadership");
      return { token, holderId: INSTANCE_ID };
    } catch (error) {
      // The advisory lock is already ours at this point. Handing it straight
      // back lets a healthy peer lead now instead of waiting for this session
      // to end, and keeps re-entrant acquisitions from stacking on the counter.
      await this.client`
        SELECT pg_advisory_unlock(${LEADER_LOCK_KEY.toString()}::bigint)
      `.catch(() => undefined);
      throw error;
    }
  }

  /**
   * A fresh acquisition always bumps the token, so any writer still carrying
   * the previous one is rejected by `withFence` from this moment on.
   */
  private async bumpFencingToken(): Promise<number> {
    const [row] = await this.client<{ token: string }[]>`
      INSERT INTO scheduler_leadership (id, fencing_token, holder_id, acquired_at, heartbeat_at)
      VALUES ('global', 1, ${INSTANCE_ID}, now(), now())
      ON CONFLICT (id) DO UPDATE SET
        fencing_token = scheduler_leadership.fencing_token + 1,
        holder_id = ${INSTANCE_ID},
        acquired_at = now(),
        heartbeat_at = now()
      RETURNING fencing_token::text AS token
    `;
    if (!row) throw new Error("scheduler_leadership returned no fencing token");
    const token = Number.parseInt(row.token, 10);
    if (!Number.isSafeInteger(token)) {
      throw new Error(`fencing token is not a safe integer: ${row.token}`);
    }
    return token;
  }

  private async reverify(fence: LeaderFence): Promise<LeaderFence | null> {
    const [ownership] = await this.client<{ pid: number; holds: boolean }[]>`
      SELECT
        pg_backend_pid() AS pid,
        EXISTS (
          SELECT 1
          FROM pg_locks l
          WHERE l.locktype = 'advisory'
            AND l.pid = pg_backend_pid()
            AND l.granted
            AND l.objsubid = 1
            AND ((l.classid::bigint << 32) | l.objid::bigint) = ${LEADER_LOCK_KEY.toString()}::bigint
        ) AS holds
    `;

    if (ownership?.holds !== true) {
      logger.warn(
        {
          holderId: INSTANCE_ID,
          token: fence.token,
          acquiredOnPid: this.sessionPid,
          currentPid: ownership?.pid ?? null,
        },
        "advisory lock is not held by this session; leadership lost",
      );
      this.sessionPid = null;
      return null;
    }

    const beat = await this.client`
      UPDATE scheduler_leadership
      SET heartbeat_at = now()
      WHERE id = 'global'
        AND fencing_token = ${fence.token}::bigint
        AND holder_id = ${INSTANCE_ID}
    `;
    if (beat.count === 0) {
      logger.warn(
        { holderId: INSTANCE_ID, token: fence.token },
        "fencing register no longer names this instance; leadership lost",
      );
      return null;
    }

    return fence;
  }

  async release(): Promise<void> {
    if (this.fence !== null) {
      this.fence = null;
      await this.client`
        SELECT pg_advisory_unlock(${LEADER_LOCK_KEY.toString()}::bigint)
      `.catch((error: unknown) => {
        logger.warn({ err: error }, "advisory unlock failed; the lock clears when the session ends");
      });
    }
    await this.client.end({ timeout: 5 });
  }
}
