/**
 * src/storage/repositories/seen-updates.ts
 * -----------------------------------------------------------------------------
 * Update-id idempotency.
 *
 * V1 bug #15: "Webhook secret optional + no update_id idempotency" — Telegram
 * retries webhook deliveries and the same update_id can arrive multiple times.
 * V2 dedupes by `update_id` against the `seen_updates` table BEFORE enqueuing
 * the work to the queue. The retention window is 7 days; the cron prunes
 * older rows so the table stays small (cheap PRIMARY KEY lookups).
 * -----------------------------------------------------------------------------
 */

import type { Env } from "../../types";
import { exec, execAll, nowMs } from "../d1";

/**
 * True iff `updateId` has already been processed (or is in-flight).
 * Cheap PRIMARY KEY lookup.
 */
export async function isSeen(env: Env, updateId: number): Promise<boolean> {
  const rows = await execAll<{ update_id: number }>(
    env.DB,
    "SELECT update_id FROM seen_updates WHERE update_id = ?",
    updateId,
  );
  return rows.length > 0;
}

/**
 * Mark an update_id as seen. `INSERT OR IGNORE` is safe against duplicate
 * marks (Telegram retries).
 */
export async function markSeen(env: Env, updateId: number): Promise<void> {
  await exec(
    env.DB,
    "INSERT OR IGNORE INTO seen_updates (update_id, received_at) VALUES (?, ?)",
    updateId,
    nowMs(),
  );
}

/**
 * Delete seen_updates rows older than `olderThanMs` (i.e. with received_at <
 * now - olderThanMs). Returns the number of deleted rows.
 *
 * Called from the cron with olderThanMs = 7 * 24 * 3600 * 1000.
 */
export async function pruneOld(env: Env, olderThanMs: number): Promise<number> {
  const cutoff = nowMs() - olderThanMs;
  const result = await exec(
    env.DB,
    "DELETE FROM seen_updates WHERE received_at < ?",
    cutoff,
  );
  return result.meta?.changes ?? 0;
}
