/**
 * src/storage/repositories/debug-events.ts
 * -----------------------------------------------------------------------------
 * Bounded debug-events log.
 *
 * The logger writes here when DEBUG_MODE === "true" (see
 * observability/logger.ts). Without pruning the table would grow unbounded;
 * the cron calls `pruneOld(env, 500)` once a minute to keep only the most
 * recent 500 rows.
 *
 * `pruneOld` uses a `DELETE ... WHERE id NOT IN (SELECT id ... LIMIT N)`
 * pattern. SQLite handles this efficiently thanks to the
 * `idx_debug_created` index on `created_at`.
 * -----------------------------------------------------------------------------
 */

import type { Env } from "../../types";
import { exec, execAll, nowMs } from "../d1";

export interface DebugEventRow {
  id: number;
  kind: string;
  summary: string;
  detail: string;
  created_at: number;
}

/**
 * Insert a debug event row. `detail` is JSON-stringified if it isn't already
 * a string.
 */
export async function insertEvent(
  env: Env,
  kind: string,
  summary: string,
  detail: unknown,
): Promise<void> {
  const detailStr =
    typeof detail === "string" ? detail : JSON.stringify(detail);
  await exec(
    env.DB,
    "INSERT INTO debug_events (kind, summary, detail, created_at) VALUES (?, ?, ?, ?)",
    kind,
    summary,
    detailStr,
    nowMs(),
  );
}

/**
 * List recent debug events, newest first. Optional `kind` filter.
 */
export async function listEvents(
  env: Env,
  limit: number,
  kind?: string,
): Promise<DebugEventRow[]> {
  if (kind) {
    return execAll<DebugEventRow>(
      env.DB,
      "SELECT id, kind, summary, detail, created_at FROM debug_events WHERE kind = ? ORDER BY created_at DESC LIMIT ?",
      kind,
      limit,
    );
  }
  return execAll<DebugEventRow>(
    env.DB,
    "SELECT id, kind, summary, detail, created_at FROM debug_events ORDER BY created_at DESC LIMIT ?",
    limit,
  );
}

/**
 * Delete all but the last `keepLast` rows (by created_at DESC). Returns the
 * number of deleted rows.
 *
 * Pattern: `DELETE FROM debug_events WHERE id NOT IN (SELECT id FROM
 * debug_events ORDER BY created_at DESC LIMIT ?)`.
 */
export async function pruneOld(env: Env, keepLast: number): Promise<number> {
  const result = await exec(
    env.DB,
    `DELETE FROM debug_events
      WHERE id NOT IN (
        SELECT id FROM debug_events ORDER BY created_at DESC LIMIT ?
      )`,
    keepLast,
  );
  return result.meta?.changes ?? 0;
}
