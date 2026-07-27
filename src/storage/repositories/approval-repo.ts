/**
 * src/storage/repositories/approval-repo.ts
 * -----------------------------------------------------------------------------
 * Approval-specific helpers layered on top of jobs.ts.
 *
 * CRITICAL (V1 bug #13 "Approval has no real state machine"):
 *   - setApprovalPublished / setApprovalRejected / setApprovalExpired /
 *     setApprovalFailed all use conditional UPDATEs:
 *         UPDATE jobs SET status=... WHERE id=? AND status='pending'
 *     A second callback firing on an already-published job matches zero rows
 *     and is a silent no-op. This is THE fix for V1's double-callback bug
 *     where a published post could be re-published or, worse, flipped to
 *     rejected by a stale callback.
 *
 * Pipeline contract (task 2-b):
 *   The content pipeline calls `createApprovalJob(env, { userId, chatId,
 *   messageId, html, parts, media?, footer })` and expects a Promise<string>
 *   (the job id). That exact signature is exported below — DO NOT change it
 *   without coordinating with the pipeline owner.
 * -----------------------------------------------------------------------------
 */

import type { Env, ExtractedContent, JobRecord } from "../../types";
import { exec, nowMs } from "../d1";
import { createJob, getJob } from "./jobs";

// ============================================================
// Payload type
// ============================================================

export interface ApprovalPayload {
  html: string;
  parts: string[];
  media?: ExtractedContent["media"];
  footer: string;
}

// ============================================================
// Create
// ============================================================

/**
 * Create a pending approval job. The pipeline calls this when approvalMode
 * is on; the returned id is later attached to the inline keyboard as the
 * callback_data so the admin's Publish/Reject tap can address this exact job.
 *
 * `payload` is JSON of { html, parts, media, footer } — everything the
 * publisher needs to actually emit the post when the admin approves.
 */
export async function createApprovalJob(
  env: Env,
  opts: {
    userId: number;
    chatId: number;
    messageId: number;
    html: string;
    parts: string[];
    media?: ExtractedContent["media"];
    footer: string;
  },
): Promise<string> {
  const payload: ApprovalPayload = {
    html: opts.html,
    parts: opts.parts,
    media: opts.media,
    footer: opts.footer,
  };
  return createJob(env, {
    type: "approval",
    status: "pending",
    userId: opts.userId,
    chatId: opts.chatId,
    messageId: opts.messageId,
    payload: JSON.stringify(payload),
    scheduledFor: null,
    publishedMessageId: null,
    publishedChatId: null,
  });
}

export async function getApprovalJob(
  env: Env,
  id: string,
): Promise<JobRecord | null> {
  return getJob(env, id);
}

// ============================================================
// Idempotent state transitions
// ============================================================

/**
 * Mark an approval as published. IDEMPOTENT: only transitions from 'pending'.
 * If the job is already published / rejected / expired / failed, this is a
 * silent no-op (UPDATE matches zero rows).
 *
 * Records the published message id + chat id so the dashboard / editing
 * flow can locate the channel post later.
 */
export async function setApprovalPublished(
  env: Env,
  id: string,
  publishedMessageId: number,
  publishedChatId: number,
): Promise<void> {
  await exec(
    env.DB,
    `UPDATE jobs
        SET status               = 'published',
            published_message_id = ?,
            published_chat_id    = ?,
            updated_at           = ?
      WHERE id = ? AND status = 'pending'`,
    publishedMessageId,
    publishedChatId,
    nowMs(),
    id,
  );
}

/**
 * Mark an approval as rejected (admin tapped "Reject"). IDEMPOTENT.
 */
export async function setApprovalRejected(env: Env, id: string): Promise<void> {
  await exec(
    env.DB,
    `UPDATE jobs SET status = 'rejected', updated_at = ?
      WHERE id = ? AND status = 'pending'`,
    nowMs(),
    id,
  );
}

/**
 * Mark an approval as expired (cron detected it was pending for > TTL).
 * IDEMPOTENT.
 */
export async function setApprovalExpired(env: Env, id: string): Promise<void> {
  await exec(
    env.DB,
    `UPDATE jobs SET status = 'expired', updated_at = ?
      WHERE id = ? AND status = 'pending'`,
    nowMs(),
    id,
  );
}

/**
 * Mark an approval as failed (publish attempt errored out). IDEMPOTENT —
 * only transitions from 'pending'. We don't want a published job to be
 * flipped to 'failed' by a late error.
 */
export async function setApprovalFailed(
  env: Env,
  id: string,
  errorMessage: string,
): Promise<void> {
  await exec(
    env.DB,
    `UPDATE jobs SET status = 'failed', error_message = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'`,
    errorMessage,
    nowMs(),
    id,
  );
}
