/**
 * src/admin/approval.ts
 * -----------------------------------------------------------------------------
 * Approval state machine — handles `pub:{jobId}` and `rej:{jobId}` callbacks.
 *
 * State machine (single source of truth is the D1 `jobs` table; the code here
 * is the ONLY writer of transitions out of "pending"):
 *
 *                  createApprovalJob
 *                         │
 *                         ▼
 *                     ┌────────┐
 *      ┌──────────────│pending │
 *      │              └────────┘
 *      │              │       │
 *      │       pub:   │       │  rej:
 *      │              ▼       ▼
 *      │        ┌─────────┐ ┌──────────┐
 *      │        │published│ │ rejected │
 *      │        └─────────┘ └──────────┘
 *      │
 *      │  publish fails
 *      ▼
 *   ┌────────┐
 *   │ failed │
 *   └────────┘
 *
 *   (cron also transitions pending → expired when APPROVAL_TTL_MS elapses)
 *
 * IDEMPOTENCY (fixes V1 bug #13 — approval had no real state machine):
 *   The approval-repo's `setApprovalPublished` / `setApprovalRejected` /
 *   `setApprovalFailed` all do a CONDITIONAL UPDATE
 *   (`UPDATE jobs SET status=... WHERE id=? AND status='pending'`). If two
 *   callbacks arrive for the same job, only the first UPDATE matches a row.
 *
 *   Because the repo functions return `Promise<void>` (not rows-affected), we
 *   verify the transition by RE-FETCHING the job afterwards and comparing
 *   `publishedMessageId` against the id we just published. If they don't
 *   match, someone else won the race — we silently skip the side-effects
 *   (stats, audit) and best-effort delete our duplicate published message.
 *
 * BUTTON DISABLING (fixes V1 bug — buttons remained clickable after approval):
 *   Before publishing, we edit the preview message to a "⏳ Publishing…"
 *   state with a single disabled button. This PREVENTS the user from
 *   double-clicking Publish while we're doing the slow network I/O. After the
 *   publish completes (or fails), we edit again to the final state. The
 *   keyboard is gone, so no further callbacks can fire from this message.
 *
 * AUTHORIZATION:
 *   - `isAuthorized(userId)` — must be in the admins table (or be the owner).
 *   - `can(role, "approve" | "reject")` — owner/editor/reviewer only; viewers
 *     cannot act on approvals.
 *   - Both checks must pass. A non-admin clicking a leaked approval button
 *     gets "⛔" and no state change.
 * -----------------------------------------------------------------------------
 */

import type {
  Env,
  ExtractedContent,
  JobRecord,
  Role,
  TelegramCallbackQuery,
} from "../types";
import { answerCallbackQuery } from "../telegram/client";
import { disabledKeyboard } from "./keyboards";
import { can } from "../domain/roles";
import { log } from "../observability/logger";
import {
  getApprovalJob,
  setApprovalFailed,
  setApprovalPublished,
  setApprovalRejected,
} from "../storage/repositories/approval-repo";
import {
  audit,
  getRole,
  isAuthorized,
} from "../storage/repositories/admins";
import {
  recordApproval,
  recordPublished,
  recordRejected,
} from "../storage/repositories/stats";

const SCOPE = "approval.handleApprovalCallback";

// ============================================================
// Parsed payload
// ============================================================

interface ApprovalPayload {
  html: string;
  parts: string[];
  media?: ExtractedContent["media"];
  footer?: string;
}

function parsePayload(raw: string): ApprovalPayload | null {
  try {
    const obj = JSON.parse(raw) as Partial<ApprovalPayload>;
    if (typeof obj.html !== "string" || !Array.isArray(obj.parts)) {
      return null;
    }
    return {
      html: obj.html,
      parts: obj.parts as string[],
      media: obj.media,
      footer: obj.footer,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Main entry
// ============================================================

/**
 * Handle a `pub:{jobId}` or `rej:{jobId}` callback.
 *
 * The caller (callbacks.ts) does NOT pre-answer the callback query for
 * approval actions — this function is responsible for calling
 * `answerCallbackQuery` itself (with meaningful text/alert) so the user gets
 * proper feedback.
 */
export async function handleApprovalCallback(
  env: Env,
  cq: TelegramCallbackQuery,
): Promise<void> {
  const data = cq.data ?? "";
  const fromId = cq.from.id;

  // ── 1. Parse callback_data ──────────────────────────────────────
  let action: "pub" | "rej";
  let jobId: string;
  if (data.startsWith("pub:")) {
    action = "pub";
    jobId = data.slice(4);
  } else if (data.startsWith("rej:")) {
    action = "rej";
    jobId = data.slice(4);
  } else {
    return; // not an approval callback
  }

  if (!jobId) {
    await safeAnswer(env, cq.id, "⚠️ Invalid ID");
    return;
  }

  // ── 2. Auth check FIRST (don't load job for unauthorized users) ──
  let authorized = false;
  let role: Role | null = null;
  try {
    authorized = await isAuthorized(env, fromId);
    if (authorized) role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "auth check threw", { error: String(e) });
    await safeAnswer(env, cq.id, "⚠️ Internal error", true);
    return;
  }

  if (!authorized || !can(role, action === "pub" ? "approve" : "reject")) {
    await safeAnswer(env, cq.id, "⛔ Unauthorized", true);
    return;
  }

  // ── 3. Load the job ─────────────────────────────────────────────
  let job: JobRecord | null;
  try {
    job = await getApprovalJob(env, jobId);
  } catch (e) {
    log("error", SCOPE, "getApprovalJob threw", { error: String(e) });
    await safeAnswer(env, cq.id, "⚠️ Internal error", true);
    return;
  }

  if (!job || job.status !== "pending") {
    await safeAnswer(env, cq.id, "⚠️ This preview is no longer valid", true);
    await updateKeyboardOnly(env, cq, "⏳ No longer valid");
    return;
  }

  // ── 4. Dispatch: publish or reject ──────────────────────────────
  if (action === "pub") {
    await handlePublish(env, cq, jobId, job);
  } else {
    await handleReject(env, cq, jobId, job);
  }
}

// ============================================================
// Publish branch
// ============================================================

async function handlePublish(
  env: Env,
  cq: TelegramCallbackQuery,
  jobId: string,
  job: JobRecord,
): Promise<void> {
  const payload = parsePayload(job.payload);
  if (!payload) {
    log("error", SCOPE, "invalid payload; failing job", { jobId });
    try {
      await setApprovalFailed(env, jobId, "invalid payload");
    } catch (e) {
      log("error", SCOPE, "setApprovalFailed threw", { error: String(e) });
    }
    await safeAnswer(env, cq.id, "⚠️ Invalid content", true);
    await updateKeyboardOnly(env, cq, "❌ Invalid content");
    return;
  }

  // Disable the keyboard BEFORE the slow publish I/O so the user can't
  // double-click Publish while we're working. This is the visible half of
  // the "buttons remain clickable after callback" fix.
  await updateKeyboardOnly(env, cq, "⏳ Publishing...");
  await safeAnswer(env, cq.id, "⏳ Publishing…");

  // Publish to TARGET_CHANNEL.
  let publishOk = false;
  let publishedMessageId: number | null = null;
  let publishError: string | undefined;

  try {
    const publisherMod: {
      publishPost?: (
        env: Env,
        html: string,
        parts: string[],
        media?: ExtractedContent["media"],
      ) => Promise<{ ok: boolean; messageIds: number[]; error?: string }>;
    } = await import("../telegram/publisher");
    if (!publisherMod.publishPost) {
      throw new Error("publisher.publishPost not available");
    }
    const r = await publisherMod.publishPost(
      env,
      payload.html,
      payload.parts,
      payload.media,
    );
    publishOk = r.ok;
    publishedMessageId =
      r.ok && r.messageIds.length > 0 ? r.messageIds[0] : null;
    publishError = r.error;
  } catch (e) {
    publishError = String(e);
    log("error", SCOPE, "publishPost threw", { error: publishError, jobId });
  }

  // Conditional UPDATE — idempotent. If a parallel callback already moved
  // the job out of "pending", this UPDATE matches 0 rows (silent no-op).
  // The D1 `published_chat_id` column is INTEGER; for "@username" channels
  // we store 0 as a sentinel (the dashboard falls back to env.TARGET_CHANNEL).
  const publishedChatIdNum = parseChannelIdNum(env.TARGET_CHANNEL);
  try {
    if (publishOk && publishedMessageId != null) {
      await setApprovalPublished(
        env,
        jobId,
        publishedMessageId,
        publishedChatIdNum,
      );
    } else if (!publishOk) {
      await setApprovalFailed(
        env,
        jobId,
        publishError ?? "unknown publish error",
      );
    }
  } catch (e) {
    log("error", SCOPE, "state transition threw", { error: String(e), jobId });
  }

  // Re-fetch to verify whether OUR transition was the one that stuck.
  // The conditional UPDATE guarantees only one callback can transition a
  // pending job; if our messageId matches the stored one, we won the race.
  let updated: JobRecord | null = null;
  try {
    updated = await getApprovalJob(env, jobId);
  } catch (e) {
    log("warn", SCOPE, "re-fetch after transition failed", {
      error: String(e),
      jobId,
    });
  }

  const weWon =
    updated != null &&
    publishOk &&
    publishedMessageId != null &&
    updated.status === "published" &&
    updated.publishedMessageId === publishedMessageId;

  if (!weWon && publishOk && updated && updated.status === "published") {
    // We published a duplicate post (someone else's UPDATE won). Best-effort
    // delete our duplicate so the channel doesn't show two copies.
    log("warn", SCOPE, "duplicate publish detected; attempting cleanup", {
      jobId,
      ourMsgId: publishedMessageId,
      winnerMsgId: updated.publishedMessageId,
    });
    if (publishedMessageId != null) {
      try {
        const { deleteMessage } = await import("../telegram/client");
        // The duplicate is in TARGET_CHANNEL; convert string id appropriately.
        await deleteMessage(env.BOT_TOKEN, {
          chat_id: env.TARGET_CHANNEL,
          message_id: publishedMessageId,
        });
      } catch (e) {
        log("warn", SCOPE, "duplicate cleanup failed", { error: String(e) });
      }
    }
    await safeAnswer(env, cq.id, "⚠️ Already published", true);
    await updateKeyboardOnly(env, cq, "✅ Already published");
    return;
  }

  if (!weWon && !publishOk) {
    // Publish failed. Check if our setApprovalFailed won or someone else
    // already resolved the job.
    const weFailed =
      updated != null &&
      updated.status === "failed" &&
      updated.errorMessage === (publishError ?? "unknown publish error");
    if (!weFailed) {
      // Someone else resolved it. Don't double-record.
      await safeAnswer(env, cq.id, "⚠️ Already processed", true);
      await updateKeyboardOnly(env, cq, "⏳ Already processed");
      return;
    }
    // Our failure stuck.
    void audit(env, job.userId, "approval.failed", `job:${jobId}`, publishError ?? "unknown");
    await safeAnswer(env, cq.id, "❌ Publish failed", true);
    await updateKeyboardOnly(
      env,
      cq,
      `❌ Publish failed: ${truncate(publishError ?? "unknown", 200)}`,
    );
    return;
  }

  if (!weWon) {
    // publishOk but updated is null/missing — can't verify. Optimistically
    // treat as success but skip stats to avoid double-counting.
    log("warn", SCOPE, "could not verify publish transition; skipping stats", {
      jobId,
    });
    await safeAnswer(env, cq.id, "✅ Published");
    await updateKeyboardOnly(env, cq, "✅ Published");
    return;
  }

  // We won the race — record stats + audit.
  try {
    await Promise.all([
      recordPublished(env, job.userId),
      recordApproval(env, job.userId),
    ]);
  } catch (e) {
    log("warn", SCOPE, "stats record failed", { error: String(e) });
  }
  try {
    await audit(env, job.userId, "approval.publish", `job:${jobId}`, "");
  } catch (e) {
    log("warn", SCOPE, "audit failed", { error: String(e) });
  }

  await safeAnswer(env, cq.id, "✅ Published");
  await updateKeyboardOnly(env, cq, "✅ Published");
}

// ============================================================
// Reject branch
// ============================================================

async function handleReject(
  env: Env,
  cq: TelegramCallbackQuery,
  jobId: string,
  job: JobRecord,
): Promise<void> {
  // Disable keyboard immediately.
  await updateKeyboardOnly(env, cq, "⏳ Processing...");

  // setApprovalRejected returns true ONLY if THIS call flipped pending→rejected.
  // Concurrent reject callbacks: only one gets true, preventing double-counting
  // of recordRejected + audit entries (fixes v2.15.6 idempotency bug).
  let weWon = false;
  try {
    weWon = await setApprovalRejected(env, jobId);
  } catch (e) {
    log("error", SCOPE, "setApprovalRejected threw", { error: String(e), jobId });
    await safeAnswer(env, cq.id, "⚠️ Internal error", true);
    return;
  }

  if (weWon) {
    try {
      await recordRejected(env, job.userId);
    } catch (e) {
      log("warn", SCOPE, "recordRejected failed", { error: String(e) });
    }
    try {
      await audit(env, job.userId, "approval.reject", `job:${jobId}`, "");
    } catch (e) {
      log("warn", SCOPE, "audit failed", { error: String(e) });
    }
    // Clear any KV cache related to this job (optimize KV usage)
    try {
      await env.AI_ADMIN_KV.delete(`approval:${jobId}`).catch(() => undefined);
      await env.AI_ADMIN_KV.delete(`job:${jobId}`).catch(() => undefined);
    } catch { /* ignore */ }
    await safeAnswer(env, cq.id, "🚫 Rejected");
    // Don't delete or replace the message — just update the keyboard to show "Rejected"
    await updateKeyboardOnly(env, cq, "🚫 Rejected");
  } else {
    // Someone else resolved it (published, failed, or already rejected).
    // Don't record a rejection — avoids double-counting stats/audit.
    await safeAnswer(env, cq.id, "⚠️ Already processed", true);
    await updateKeyboardOnly(env, cq, "⏳ Already processed");
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Update ONLY the inline keyboard (not the message text).
 * Uses editMessageReplyMarkup which ONLY changes the keyboard —
 * the original message text/caption/media is completely preserved.
 *
 * If editMessageReplyMarkup fails (rare), we DON'T replace the message.
 * The callback query is already answered with the status text.
 */
async function updateKeyboardOnly(
  env: Env,
  cq: TelegramCallbackQuery,
  statusText: string,
): Promise<void> {
  const msg = cq.message;
  if (!msg) return;
  try {
    // editMessageReplyMarkup: ONLY changes the keyboard, preserves everything else.
    // This is the correct Telegram API method for our use case.
    const { tgApi } = await import("../telegram/client");
    await tgApi(env.BOT_TOKEN, "editMessageReplyMarkup", {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: JSON.parse(disabledKeyboard(statusText)),
    });
  } catch (e) {
    // If editMessageReplyMarkup fails, DON'T replace the message.
    // The callback query answer already shows the status to the user.
    // This preserves the original preview content completely.
    log("warn", SCOPE, "updateKeyboardOnly: editMessageReplyMarkup failed (message preserved)", {
      error: String(e),
      statusText,
    });
  }
}

/** Wrap answerCallbackQuery so it never throws. */
async function safeAnswer(
  env: Env,
  cqId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  try {
    await answerCallbackQuery(env.BOT_TOKEN, {
      callback_query_id: cqId,
      text: text || undefined,
      show_alert: showAlert,
    });
  } catch (e) {
    // Most common failure: query was already answered (Telegram allows only
    // the first answerCallbackQuery to show text). Safe to ignore.
    log("info", SCOPE, "answerCallbackQuery failed (likely already answered)", {
      error: String(e),
    });
  }
}

/** Truncate a string for safe display in error messages. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Convert env.TARGET_CHANNEL (which may be "@username" or "-1001234567890")
 * to a number for storage in the INTEGER `published_chat_id` column. Returns
 * 0 for non-numeric channels (the dashboard falls back to env.TARGET_CHANNEL).
 */
function parseChannelIdNum(channel: string): number {
  // Numeric channel IDs (e.g. "-1001234567890") parse cleanly.
  const n = Number(channel);
  if (Number.isInteger(n)) return n;
  return 0;
}
