/**
 * src/storage/repositories/jobs.ts
 * -----------------------------------------------------------------------------
 * Jobs repository — scheduled posts + approval state machine.
 *
 * The `jobs` table holds two kinds of records:
 *   - type='scheduled_post' status='pending' scheduled_for=<epoch_ms>
 *       Cron picks these up when scheduled_for <= now and enqueues a
 *       publish_scheduled queue message for each.
 *   - type='approval' status='pending'
 *       Created by the pipeline when approvalMode is on. The admin's
 *       callback (Publish/Reject button) transitions the state machine.
 *       Cron expires stale ones after APPROVAL_TTL_MS.
 *
 * All status transitions are atomic SQL UPDATEs with `WHERE id = ? AND
 * status = 'pending'` — this is the V2 fix for V1's double-callback bug
 * (#13: "Approval has no real state machine"): a callback firing twice
 * cannot flip a job from published → published (or → rejected) because the
 * second UPDATE matches zero rows.
 * -----------------------------------------------------------------------------
 */

import type { Env, JobRecord, JobStatus, JobType } from "../../types";
import { exec, execAll, genId, nowMs } from "../d1";

// ============================================================
// Row mapping
// ============================================================

interface JobRow {
  id: string;
  type: string;
  status: string;
  user_id: number;
  chat_id: number;
  message_id: number;
  payload: string;
  scheduled_for: number | null;
  created_at: number;
  updated_at: number;
  published_message_id: number | null;
  published_chat_id: number | null;
  error_message: string | null;
  attempts: number;
}

function rowToJob(r: JobRow): JobRecord {
  return {
    id: r.id,
    type: r.type as JobType,
    status: r.status as JobStatus,
    userId: r.user_id,
    chatId: r.chat_id,
    messageId: r.message_id,
    payload: r.payload,
    scheduledFor: r.scheduled_for,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    publishedMessageId: r.published_message_id,
    publishedChatId: r.published_chat_id,
    errorMessage: r.error_message ?? undefined,
    attempts: r.attempts,
  };
}

// ============================================================
// Create / read
// ============================================================

/**
 * Insert a new job. `id`, `createdAt`, `updatedAt`, `attempts` are auto-filled.
 * Returns the generated id.
 */
export async function createJob(
  env: Env,
  job: Omit<JobRecord, "id" | "createdAt" | "updatedAt" | "attempts" | "publishedMessageId" | "publishedChatId" | "errorMessage"> & {
    publishedMessageId?: number | null;
    publishedChatId?: number | null;
    errorMessage?: string | null;
  },
): Promise<string> {
  const id = genId();
  const ts = nowMs();
  await exec(
    env.DB,
    `INSERT INTO jobs
       (id, type, status, user_id, chat_id, message_id, payload,
        scheduled_for, created_at, updated_at,
        published_message_id, published_chat_id, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    id,
    job.type,
    job.status,
    job.userId,
    job.chatId,
    job.messageId,
    job.payload,
    job.scheduledFor,
    ts,
    ts,
    job.publishedMessageId,
    job.publishedChatId,
  );
  return id;
}

export async function getJob(env: Env, id: string): Promise<JobRecord | null> {
  const rows = await execAll<JobRow>(
    env.DB,
    "SELECT * FROM jobs WHERE id = ?",
    id,
  );
  return rows.length > 0 ? rowToJob(rows[0]) : null;
}

/**
 * Atomically claim a scheduled-post job for publishing.
 *
 * Uses a conditional UPDATE that goes `pending → publishing` on databases
 * whose CHECK constraint includes 'publishing' (new schema). On legacy
 * databases created before 'publishing' was added, the UPDATE will fail with
 * a CHECK constraint violation — we catch that and fall back to the legacy
 * `pending → published` transition so old deployments keep working.
 *
 * Returns true if THIS call claimed it (caller may publish), false if
 * another handler already claimed/published it (caller must back off).
 *
 * Race-condition-safe: the `WHERE status = 'pending'` clause ensures only
 * one concurrent handler can flip the status. If two handlers race, the
 * second gets 0 rows-changed and backs off.
 *
 * IMPORTANT: the caller MUST publish the post AFTER this returns true. If
 * the publish fails with a retryable error, the caller MUST reset the status
 * back to 'pending' (via updateJobStatus) so a subsequent retry can re-claim.
 * If the publish fails permanently, set status to 'failed'.
 */
export async function claimForPublish(env: Env, id: string): Promise<boolean> {
  // Try the 'publishing' transition first (new schema).
  try {
    const r = await exec(
      env.DB,
      "UPDATE jobs SET status = 'publishing', updated_at = ? WHERE id = ? AND status = 'pending'",
      nowMs(),
      id,
    );
    if ((r.meta?.changes ?? 0) > 0) return true;
    // 0 rows changed — either already claimed or doesn't exist.
    return false;
  } catch {
    // Legacy database without 'publishing' in the CHECK constraint.
    // Fall back to the old pending → published transition.
    const r = await exec(
      env.DB,
      "UPDATE jobs SET status = 'published', updated_at = ? WHERE id = ? AND status = 'pending'",
      nowMs(),
      id,
    );
    return (r.meta?.changes ?? 0) > 0;
  }
}

// ============================================================
// Status transitions
// ============================================================

/**
 * Update a job's status. Optionally record published_message_id /
 * published_chat_id (on publish) or an error_message (on failure).
 *
 * NOTE: this function performs an UNCONDITIONAL update (matches any status).
 * For approval state-machine transitions that must be idempotent, use the
 * helpers in approval-repo.ts (which add `AND status = 'pending'`).
 */
export async function updateJobStatus(
  env: Env,
  id: string,
  status: JobStatus,
  extra?: {
    publishedMessageId?: number;
    publishedChatId?: number;
    errorMessage?: string;
  },
): Promise<void> {
  const ts = nowMs();
  if (extra?.publishedMessageId !== undefined || extra?.publishedChatId !== undefined) {
    await exec(
      env.DB,
      `UPDATE jobs
          SET status = ?,
              published_message_id = ?,
              published_chat_id    = ?,
              error_message        = ?,
              updated_at           = ?
        WHERE id = ?`,
      status,
      extra.publishedMessageId ?? null,
      extra.publishedChatId ?? null,
      extra.errorMessage ?? null,
      ts,
      id,
    );
    return;
  }
  if (extra?.errorMessage !== undefined) {
    await exec(
      env.DB,
      `UPDATE jobs SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      status,
      extra.errorMessage,
      ts,
      id,
    );
    return;
  }
  await exec(
    env.DB,
    "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?",
    status,
    ts,
    id,
  );
}

/**
 * Atomically increment the attempts counter and return the new value.
 * Uses `RETURNING` so we don't need a separate read.
 */
export async function incrementAttempts(env: Env, id: string): Promise<number> {
  const rows = await execAll<{ attempts: number }>(
    env.DB,
    "UPDATE jobs SET attempts = attempts + 1, updated_at = ? WHERE id = ? RETURNING attempts",
    nowMs(),
    id,
  );
  return rows.length > 0 ? rows[0].attempts : 0;
}

// ============================================================
// Cron / dashboard queries
// ============================================================

/**
 * Scheduled posts due now: type='scheduled_post', status='pending',
 * scheduled_for <= `before`, ordered by scheduled_for ASC, capped at `limit`.
 */
export async function listPendingScheduledDue(
  env: Env,
  before: number,
  limit: number,
): Promise<JobRecord[]> {
  const rows = await execAll<JobRow>(
    env.DB,
    `SELECT * FROM jobs
      WHERE type = 'scheduled_post'
        AND status = 'pending'
        AND scheduled_for <= ?
      ORDER BY scheduled_for ASC
      LIMIT ?`,
    before,
    limit,
  );
  return rows.map(rowToJob);
}

/**
 * Stale approval jobs: type='approval', status='pending', created_at < `before`.
 * Used by the cron to expire approvals that the admin never acted on.
 */
export async function listStaleApprovals(
  env: Env,
  before: number,
): Promise<JobRecord[]> {
  const rows = await execAll<JobRow>(
    env.DB,
    `SELECT * FROM jobs
      WHERE type = 'approval'
        AND status = 'pending'
        AND created_at < ?
      ORDER BY created_at ASC`,
    before,
  );
  return rows.map(rowToJob);
}

/**
 * Stale 'publishing' jobs: status='publishing', updated_at < `before`.
 *
 * A job enters 'publishing' when claimed for publish. If the worker crashes
 * mid-publish (between claimForPublish and the actual Telegram API call), the
 * job is stuck in 'publishing' forever — the queue retry may have been
 * exhausted, or the crash happened before the retry could fire.
 *
 * The cron picks these up and resets them to 'pending' so they can be
 * re-claimed on the next tick. On legacy databases that don't have the
 * 'publishing' status (CHECK constraint without it), this query returns 0
 * rows — which is correct because legacy DBs use 'published' as the claim
 * state and those jobs are handled by the 'failed' path instead.
 */
export async function listStalePublishing(
  env: Env,
  before: number,
): Promise<JobRecord[]> {
  try {
    const rows = await execAll<JobRow>(
      env.DB,
      `SELECT * FROM jobs
        WHERE status = 'publishing'
          AND updated_at < ?
        ORDER BY updated_at ASC`,
      before,
    );
    return rows.map(rowToJob);
  } catch {
    // Legacy DB without 'publishing' in the schema — return empty.
    return [];
  }
}

/**
 * Recent jobs for a user — used by the dashboard / stats display.
 */
export async function listRecentJobs(
  env: Env,
  userId: number,
  limit: number,
): Promise<JobRecord[]> {
  const rows = await execAll<JobRow>(
    env.DB,
    "SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
    userId,
    limit,
  );
  return rows.map(rowToJob);
}

/**
 * Pending scheduled posts for one user, ordered by `scheduled_for` ASC.
 *
 * Used by the schedule system (task 26) to compute the next free slot when a
 * new post arrives. We only care about pending posts (the cron will publish
 * past ones soon), and we sort by `scheduled_for` so the scheduler can walk
 * them in order to find the first cycle with an available slot.
 *
 * Returns an empty array on error / no rows.
 */
export async function listPendingScheduledForUser(
  env: Env,
  userId: number,
  limit: number = 200,
): Promise<JobRecord[]> {
  const rows = await execAll<JobRow>(
    env.DB,
    `SELECT * FROM jobs
      WHERE type = 'scheduled_post'
        AND status = 'pending'
        AND user_id = ?
      ORDER BY scheduled_for ASC
      LIMIT ?`,
    userId,
    limit,
  );
  return rows.map(rowToJob);
}

// ============================================================
// Published posts mapping (P1-CE2 — enables channel editing)
// ============================================================

interface PublishedPostRow {
  source_chat_id: number;
  source_message_id: number;
  published_chat_id: string; // TEXT — may be numeric id or @username
  published_message_id: number;
  published_at: number;
}

export interface PublishedPost {
  sourceChatId: number;
  sourceMessageId: number;
  publishedChatId: string; // TEXT — numeric id or @username
  publishedMessageId: number;
  publishedAt: number;
}

function rowToPublishedPost(r: PublishedPostRow): PublishedPost {
  return {
    sourceChatId: r.source_chat_id,
    sourceMessageId: r.source_message_id,
    publishedChatId: r.published_chat_id,
    publishedMessageId: r.published_message_id,
    publishedAt: r.published_at,
  };
}

/**
 * Record (or update) the mapping from an admin's source message to the
 * channel message it produced. Called after every successful direct publish
 * so that a later edit of the source message can edit the channel post
 * in place (P1-CE2).
 *
 * Uses INSERT OR REPLACE so re-publishing the same source message updates
 * the mapping (e.g. after a delete + re-publish).
 *
 * `publishedChatId` is a STRING: either a numeric id ("-1001234567890") or
 * a @username ("@ILIVIR3"). Stored as TEXT in D1 so the edit path can pass
 * it directly to editChannelPost which accepts number | string.
 */
export async function recordPublishedPost(
  env: Env,
  sourceChatId: number,
  sourceMessageId: number,
  publishedChatId: string,
  publishedMessageId: number,
): Promise<void> {
  await exec(
    env.DB,
    `INSERT OR REPLACE INTO published_posts
       (source_chat_id, source_message_id, published_chat_id, published_message_id, published_at)
     VALUES (?, ?, ?, ?, ?)`,
    sourceChatId,
    sourceMessageId,
    publishedChatId,
    publishedMessageId,
    nowMs(),
  );
}

/**
 * Look up the channel message_id that a given source message produced.
 * Returns null if no mapping exists (new post, mapping expired, or the
 * source was never published directly).
 */
export async function getPublishedPost(
  env: Env,
  sourceChatId: number,
  sourceMessageId: number,
): Promise<PublishedPost | null> {
  const rows = await execAll<PublishedPostRow>(
    env.DB,
    "SELECT * FROM published_posts WHERE source_chat_id = ? AND source_message_id = ?",
    sourceChatId,
    sourceMessageId,
  );
  return rows.length > 0 ? rowToPublishedPost(rows[0]) : null;
}
