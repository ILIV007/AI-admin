/**
 * src/storage/repositories/stats.ts
 * -----------------------------------------------------------------------------
 * Counters with ATOMIC increments — THE fix for V1 bug #14
 * ("flushAllStats runs every webhook → batching useless") and the
 * lost-update race that came with it.
 *
 * V2 strategy:
 *   - Every event that should bump a counter calls `incrementStat(env, key,
 *     field, by)` which executes a single atomic SQL UPDATE:
 *         UPDATE stats SET <field> = <field> + ?, last_updated = ? WHERE key = ?
 *     SQLite/D1 guarantees the read-modify-write inside this UPDATE is atomic
 *     w.r.t. concurrent writers — there is no window in which two concurrent
 *     increments can clobber each other.
 *   - We do NOT batch in memory and flush — there is no flush step. Every
 *     increment is persisted immediately and survives worker restarts.
 *   - The cron's "aggregate stats" step (cron.ts) just ensures the global
 *     row exists; it does NOT batch (nothing to batch).
 *
 * Per-user rows use key `u:<userId>`; the global row uses key `global`.
 * Helper `recordX` functions update BOTH the global row and the user row in
 * parallel — fire-and-forget from the caller (use ctx.waitUntil).
 * -----------------------------------------------------------------------------
 */

import type { Env, Stats } from "../../types";
import { exec, execAll, nowMs } from "../d1";

// ============================================================
// Keys
// ============================================================

export const GLOBAL_KEY = "global";

function userKey(userId: number): string {
  return `u:${userId}`;
}

// ============================================================
// Field → column map
// ============================================================

/**
 * Map of camelCase Stats field → snake_case D1 column.
 *
 * `lastUpdated` is excluded — it's set by the UPDATE itself, not incremented.
 * The map is also used as a whitelist: incrementStat refuses to touch any
 * field not listed here, so we never accidentally build SQL with an
 * untrusted field name.
 */
const FIELD_TO_COLUMN: Record<keyof Stats, string> = {
  totalReceived: "total_received",
  totalPublished: "total_published",
  totalRewritten: "total_rewritten",
  totalFailed: "total_failed",
  totalApprovals: "total_approvals",
  totalRejected: "total_rejected",
  totalScheduled: "total_scheduled",
  aiCalls: "ai_calls",
  aiFailures: "ai_failures",
  lastUpdated: "last_updated",
};

const INCREMENTABLE_FIELDS: ReadonlyArray<keyof Stats> = [
  "totalReceived",
  "totalPublished",
  "totalRewritten",
  "totalFailed",
  "totalApprovals",
  "totalRejected",
  "totalScheduled",
  "aiCalls",
  "aiFailures",
];

function isIncrementable(field: keyof Stats): boolean {
  return INCREMENTABLE_FIELDS.includes(field);
}

// ============================================================
// Core ops
// ============================================================

/**
 * INSERT OR IGNORE a stats row with all-zero defaults. Idempotent — safe to
 * call before every increment. (We do this defensively so incrementStat's
 * UPDATE always matches a row.)
 */
export async function ensureStatsRow(env: Env, key: string): Promise<void> {
  await exec(
    env.DB,
    "INSERT OR IGNORE INTO stats (key, last_updated) VALUES (?, 0)",
    key,
  );
}

/**
 * Atomically increment a stats field by `by` (default 1).
 *
 * The SQL is `UPDATE stats SET <col> = <col> + ?, last_updated = ? WHERE key = ?`.
 * The column name is resolved from a hard-coded map (never user input), so
 * string interpolation of the column is safe here.
 */
export async function incrementStat(
  env: Env,
  key: string,
  field: keyof Stats,
  by: number = 1,
): Promise<void> {
  if (!isIncrementable(field)) {
    throw new Error(
      `stats.incrementStat: field '${String(field)}' is not incrementable`,
    );
  }
  const column = FIELD_TO_COLUMN[field];
  await ensureStatsRow(env, key);
  await exec(
    env.DB,
    `UPDATE stats SET ${column} = ${column} + ?, last_updated = ? WHERE key = ?`,
    by,
    nowMs(),
    key,
  );
}

/**
 * Read stats for a key. Returns a zero-initialized Stats if no row exists.
 */
export async function getStats(env: Env, key: string = GLOBAL_KEY): Promise<Stats> {
  const rows = await execAll<{
    total_received: number;
    total_published: number;
    total_rewritten: number;
    total_failed: number;
    total_approvals: number;
    total_rejected: number;
    total_scheduled: number;
    ai_calls: number;
    ai_failures: number;
    last_updated: number;
  }>(env.DB, "SELECT * FROM stats WHERE key = ?", key);

  if (rows.length === 0) {
    return {
      totalReceived: 0,
      totalPublished: 0,
      totalRewritten: 0,
      totalFailed: 0,
      totalApprovals: 0,
      totalRejected: 0,
      totalScheduled: 0,
      aiCalls: 0,
      aiFailures: 0,
      lastUpdated: 0,
    };
  }
  const r = rows[0];
  return {
    totalReceived: r.total_received,
    totalPublished: r.total_published,
    totalRewritten: r.total_rewritten,
    totalFailed: r.total_failed,
    totalApprovals: r.total_approvals,
    totalRejected: r.total_rejected,
    totalScheduled: r.total_scheduled,
    aiCalls: r.ai_calls,
    aiFailures: r.ai_failures,
    lastUpdated: r.last_updated,
  };
}

/** Per-admin stats row. */
export async function getAdminStats(env: Env, userId: number): Promise<Stats> {
  return getStats(env, userKey(userId));
}

// ============================================================
// Helper increments — update BOTH global and per-user.
// ============================================================

/**
 * Bump a field on both the global stats row and the user's row.
 * The two UPDATEs run in parallel; both are individually atomic.
 */
async function bumpBoth(
  env: Env,
  userId: number,
  field: keyof Stats,
  by: number = 1,
): Promise<void> {
  await Promise.all([
    incrementStat(env, GLOBAL_KEY, field, by),
    incrementStat(env, userKey(userId), field, by),
  ]);
}

export async function recordReceived(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "totalReceived");
}

export async function recordPublished(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "totalPublished");
}

export async function recordRewritten(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "totalRewritten");
}

export async function recordFailed(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "totalFailed");
}

export async function recordApproval(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "totalApprovals");
}

export async function recordRejected(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "totalRejected");
}

export async function recordScheduled(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "totalScheduled");
}

export async function recordAiCall(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "aiCalls");
}

export async function recordAiFailure(env: Env, userId: number): Promise<void> {
  await bumpBoth(env, userId, "aiFailures");
}
