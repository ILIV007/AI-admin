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
