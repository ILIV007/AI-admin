/**
 * src/queue/consumer.ts
 * -----------------------------------------------------------------------------
 * Queue consumer — the REAL processing happens here.
 *
 * This is THE fix for V1 bug #2 ("ctx.waitUntil for 90s pipeline is
 * unreliable"): the webhook returns 200 in <50ms and the queue consumer does
 * the heavy work outside the request lifetime, with automatic retries on
 * transient failures.
 *
 * Message kinds (per src/types.ts QueueMessage):
 *   - process_update          : a fresh Telegram update, ready to process
 *   - finalize_media_group    : inactivity-window timer for an album
 *   - publish_scheduled       : publish a scheduled-post job now
 *   - retry_publish           : same as publish_scheduled (attempt is
 *                               informational; the DB `attempts` column is
 *                               authoritative)
 *
 * Failure handling:
 *   - On success → message.ack().
 *   - On transient error (network/timeout/5xx) → message.retry(); the queue
 *     runtime redelivers with backoff up to max_retries.
 *   - On non-transient error (parse failure, schema mismatch) → ack to avoid
 *     poison-message loops, but log + (where relevant) mark the job failed.
 * -----------------------------------------------------------------------------
 */

import type {
  Env,
  ExtractedContent,
  MediaGroupItem,
  QueueMessage,
  Settings,
  TelegramUpdate,
} from "../types";
// ExecutionContext is a global ambient type from @cloudflare/workers-types.
import { log } from "../observability/logger";
import { extractContent } from "../telegram/updates";
import { getSettings } from "../storage/repositories/settings";
import {
  recordAiCall,
  recordApproval,
  recordFailed,
  recordPublished,
  recordReceived,
} from "../storage/repositories/stats";
import * as mediaGroupsRepo from "../storage/repositories/media-groups";
import {
  createJob,
  getJob,
  incrementAttempts,
  updateJobStatus,
} from "../storage/repositories/jobs";
import { recordScheduled } from "../storage/repositories/stats";
import { sendMessage } from "../telegram/client";
import { enqueueMediaGroupFinalize } from "./producer";
import { MEDIA_GROUP_WINDOW_MS } from "../config/defaults";

// Hard cap on publish attempts. Matches the `max_retries` we'll set on the
// queue in wrangler.toml.
const MAX_PUBLISH_ATTEMPTS = 3;

// ============================================================
// Default export — Worker queue handler
// ============================================================

export default {
  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Process each message independently; one failure must not abort the batch.
    await Promise.all(
      batch.messages.map((m) => handleMessage(m, env, ctx).catch((e) => {
        // handleMessage is supposed to never throw (it acks/retries internally),
        // but defend against bugs in the handler itself.
        log("error", "queue.consumer", "handler threw unexpectedly", {
          err: String(e),
          kind: (m.body as { kind?: string }).kind,
        });
        try { m.ack(); } catch { /* ignore */ }
      })),
    );
  },
};

// ============================================================
// Per-message dispatch
// ============================================================

async function handleMessage(
  message: Message<QueueMessage>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const body = message.body;
  try {
    switch (body.kind) {
      case "process_update":
        await handleProcessUpdate(env, ctx, body.update);
        message.ack();
        break;

      case "finalize_media_group":
        await handleFinalizeMediaGroup(env, ctx, body.mediaGroupId);
        message.ack();
        break;

      case "publish_scheduled":
        await handlePublishScheduled(env, ctx, body.jobId);
        message.ack();
        break;

      case "retry_publish":
        // `attempt` is informational only; the DB `attempts` column is
        // authoritative. Same handler as publish_scheduled.
        await handlePublishScheduled(env, ctx, body.jobId);
        message.ack();
        break;

      default: {
        // Exhaustiveness guard. Future QueueMessage variants must be added
        // here; if not, we ack to avoid poison loops.
        const _exhaustive: never = body;
        log("warn", "queue.consumer", "unknown message kind", {
          body: _exhaustive as unknown,
        });
        message.ack();
      }
    }
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    log("error", "queue.consumer", "message handling failed", {
      kind: (body as { kind?: string }).kind,
      error: msg,
    });
    if (isTransient(err)) {
      // Redeliver later. The queue runtime backs off automatically.
      message.retry();
    } else {
      // Non-transient: ack to avoid poison-message loops.
      message.ack();
    }
  }
}

/**
 * Heuristic: should we retry this message?
 *
 * Transient = network / timeout / 5xx-ish. D1 "network connection lost", Queue
 * "service unavailable", Telegram 429/5xx, etc. We're deliberately liberal
 * here — the alternative is a poison-message loop that drains the queue.
 */
function isTransient(err: unknown): boolean {
  const msg = ((err as Error)?.message ?? String(err)).toLowerCase();
  return /network|timeout|temporarily|service unavailable|connection|econnreset|429|5\d{2}\b/.test(msg);
}

// ============================================================
// process_update
// ============================================================

async function handleProcessUpdate(
  env: Env,
  ctx: ExecutionContext,
  update: TelegramUpdate,
): Promise<void> {
  // ── Callback queries go to the admin callback router ────────────
  if (update.callback_query) {
    try {
      const { handleCallbackQuery } = await import("../admin/callbacks");
      await handleCallbackQuery(env, update.callback_query);
    } catch (e) {
      log("error", "queue.consumer", "callback handler failed", {
        error: String(e),
      });
    }
    return;
  }

  const content = extractContent(update);
  if (!content) {
    log("info", "queue.consumer.handleProcessUpdate", "no content extracted; skipping");
    return;
  }

  const userId = content.fromId;
  if (userId == null) {
    log("warn", "queue.consumer.handleProcessUpdate", "no fromId; skipping", {
      chatId: content.chatId,
      messageId: content.messageId,
    });
    return;
  }

  // Stats: record received (fire-and-forget).
  ctx.waitUntil(safe(recordReceived(env, userId)));

  // ── Media group: aggregate, don't process yet ───────────────────
  if (content.mediaGroupId) {
    const item: MediaGroupItem = {
      mediaGroupId: content.mediaGroupId,
      messageId: content.messageId,
      chatId: content.chatId,
      fromId: userId,
      text: content.text,
      media: content.media,
      receivedAt: Date.now(),
      finalized: 0,
    };
    await mediaGroupsRepo.addItem(env, item);

    // (Re)schedule a finalize check after the inactivity window. Multiple
    // such enqueues are fine — the consumer dedupes via isFinalized +
    // inactivity check.
    ctx.waitUntil(
      safe(enqueueMediaGroupFinalize(env, content.mediaGroupId, MEDIA_GROUP_WINDOW_MS)),
    );
    return;
  }

  // ── Command messages go to the command dispatcher ───────────────
  if (content.text && content.text.startsWith("/")) {
    try {
      const { dispatchCommand } = await import("../admin/commands");
      await dispatchCommand(env, ctx, update.message ?? update.channel_post!, content);
    } catch (e) {
      log("error", "queue.consumer", "command dispatch failed", {
        error: String(e),
        text: content.text.slice(0, 50),
      });
    }
    return;
  }

  // ── addadmin flow: owner sending a numeric user id ──────────────
  if (content.chatType === "private" && userId !== null) {
    try {
      const { handleAddAdminReply } = await import("../admin/addadmin");
      const handled = await handleAddAdminReply(env, update.message!);
      if (handled) return;
    } catch (e) {
      log("warn", "queue.consumer", "addadmin reply check failed", {
        error: String(e),
      });
    }
  }

  // ── sched_next flag: this message should become a scheduled post ─
  if (userId !== null && content.chatType === "private") {
    let schedFor: number | null = null;
    try {
      const raw = await env.KV.get(`sched_next:${userId}`);
      if (raw) schedFor = Number(raw);
    } catch { /* ignore */ }
    if (schedFor && schedFor > Date.now()) {
      // Clean content, format, store as scheduled_post job, do NOT publish now.
      try {
        const { cleanContent } = await import("../processing/cleaner");
        const { blocksToTelegramHtml } = await import("../formatting/telegram-html");
        const { markdownToBlocks } = await import("../formatting/blocks");
        const { chunkHtml } = await import("../formatting/chunker");
        const settings = await getSettings(env, userId);
        const cleaned = cleanContent(content.text);
        const blocks = markdownToBlocks(cleaned);
        const html = blocksToTelegramHtml(blocks, settings.footerText);
        const parts = chunkHtml(html, 4000, settings.footerText);
        const jobId = await createJob(env, {
          type: "scheduled_post",
          status: "pending",
          userId,
          chatId: content.chatId,
          messageId: content.messageId,
          payload: JSON.stringify({ html, parts, media: content.media, footer: settings.footerText }),
          scheduledFor: schedFor,
        });
        await env.KV.delete(`sched_next:${userId}`);
        await recordScheduled(env, userId);
        const faTime = new Date(schedFor).toLocaleString("fa-IR", { timeZone: "Asia/Tehran" });
        await sendMessage(env.BOT_TOKEN, {
          chat_id: content.chatId,
          text: `📅 پست زمان‌بندی شد برای ${faTime}\n🆔 <code>${jobId}</code>`,
          parse_mode: "HTML",
        }).catch(() => undefined);
        return;
      } catch (e) {
        log("error", "queue.consumer", "schedule job creation failed", { error: String(e) });
      }
    }
  }

  // ── Normal single message: pipeline ─────────────────────────────
  const settings = await getSettings(env, userId);

  // Dynamic import per spec — pipeline module is owned by another agent.
  const pipelineMod: {
    runPipeline: (
      env: Env,
      content: ExtractedContent,
      settings: Settings,
    ) => Promise<{
      ok: boolean;
      action: "published" | "preview" | "format_only" | "skipped" | "failed";
      aiUsed: boolean;
      errorMessage?: string;
    }>;
  } = await import("../processing/pipeline");

  const result = await pipelineMod.runPipeline(env, content, settings);

  // Record stats based on outcome. Fire-and-forget via ctx.waitUntil.
  if (result.aiUsed) {
    ctx.waitUntil(safe(recordAiCall(env, userId)));
  }
  if (result.action === "published") {
    ctx.waitUntil(safe(recordPublished(env, userId)));
  } else if (result.action === "preview") {
    ctx.waitUntil(safe(recordApproval(env, userId)));
  } else if (result.action === "failed") {
    ctx.waitUntil(safe(recordFailed(env, userId)));
  }
}

// ============================================================
// finalize_media_group
// ============================================================

async function handleFinalizeMediaGroup(
  env: Env,
  ctx: ExecutionContext,
  mediaGroupId: string,
): Promise<void> {
  // Already finalized by a previous finalize message? Skip.
  if (await mediaGroupsRepo.isFinalized(env, mediaGroupId)) {
    return;
  }

  const items = await mediaGroupsRepo.getItems(env, mediaGroupId);
  if (items.length === 0) {
    // No items yet — race: items not yet committed (eventual consistency) or
    // the group id is bogus. Re-enqueue with a small delay.
    ctx.waitUntil(
      safe(enqueueMediaGroupFinalize(env, mediaGroupId, MEDIA_GROUP_WINDOW_MS)),
    );
    return;
  }

  // Inactivity check: if the most recent item arrived within the window, the
  // album may still be arriving. Wait another window.
  const now = Date.now();
  const lastReceivedAt = items.reduce(
    (max, i) => (i.receivedAt > max ? i.receivedAt : max),
    0,
  );
  if (now - lastReceivedAt < MEDIA_GROUP_WINDOW_MS) {
    ctx.waitUntil(
      safe(enqueueMediaGroupFinalize(env, mediaGroupId, MEDIA_GROUP_WINDOW_MS)),
    );
    return;
  }

  // Claim the group atomically — concurrent finalize messages will see
  // finalized=1 next time and skip.
  await mediaGroupsRepo.markFinalized(env, mediaGroupId);

  // Combine: concatenate captions in order; take the first item's media as
  // the "primary" media (the publisher only handles one media per post).
  const combinedText = items
    .map((i) => i.text)
    .filter((t) => t && t.trim().length > 0)
    .join("\n\n");

  const firstWithMedia = items.find((i) => i.media);
  const primaryMedia = firstWithMedia?.media;

  const firstItem = items[0];
  const content: ExtractedContent = {
    fromId: firstItem.fromId,
    fromName: "",
    chatId: firstItem.chatId,
    // chatType isn't preserved in the media_group_items table; the pipeline
    // doesn't depend on it. Use "channel" as a sensible default (albums
    // usually come from channels).
    chatType: "channel",
    messageId: firstItem.messageId,
    text: combinedText,
    entities: [],
    media: primaryMedia,
    // Intentionally omit mediaGroupId — we're past aggregation.
    mediaGroupId: undefined,
    isChannelPost: false,
    isEdit: false,
  };

  const settings = await getSettings(env, firstItem.fromId);

  const pipelineMod: {
    runPipeline: (
      env: Env,
      content: ExtractedContent,
      settings: Settings,
    ) => Promise<{
      ok: boolean;
      action: "published" | "preview" | "format_only" | "skipped" | "failed";
      aiUsed: boolean;
      errorMessage?: string;
    }>;
  } = await import("../processing/pipeline");

  const result = await pipelineMod.runPipeline(env, content, settings);

  if (result.aiUsed) {
    ctx.waitUntil(safe(recordAiCall(env, firstItem.fromId)));
  }
  if (result.action === "published") {
    ctx.waitUntil(safe(recordPublished(env, firstItem.fromId)));
  } else if (result.action === "preview") {
    ctx.waitUntil(safe(recordApproval(env, firstItem.fromId)));
  } else if (result.action === "failed") {
    ctx.waitUntil(safe(recordFailed(env, firstItem.fromId)));
  }
}

// ============================================================
// publish_scheduled / retry_publish
// ============================================================

async function handlePublishScheduled(
  env: Env,
  ctx: ExecutionContext,
  jobId: string,
): Promise<void> {
  const job = await getJob(env, jobId);
  if (!job) {
    log("warn", "queue.consumer.handlePublishScheduled", "job not found", { jobId });
    return;
  }
  if (job.status !== "pending") {
    log("info", "queue.consumer.handlePublishScheduled", `job status is '${job.status}'; skipping`, { jobId });
    return;
  }

  // Parse payload.
  let payload: {
    html?: string;
    parts?: string[];
    media?: ExtractedContent["media"];
    footer?: string;
  };
  try {
    payload = JSON.parse(job.payload) as typeof payload;
  } catch (e) {
    log("error", "queue.consumer.handlePublishScheduled", "payload parse failed", {
      jobId,
      error: (e as Error).message,
    });
    await updateJobStatus(env, jobId, "failed", { errorMessage: "payload parse failed" });
    return;
  }
  if (!payload.html || !payload.parts) {
    await updateJobStatus(env, jobId, "failed", {
      errorMessage: "missing html/parts in payload",
    });
    return;
  }

  // Publish.
  try {
    const publisherMod: {
      publishPost: (
        env: Env,
        html: string,
        parts: string[],
        media?: ExtractedContent["media"],
      ) => Promise<{ ok: boolean; messageIds: number[]; error?: string }>;
    } = await import("../telegram/publisher");

    const result = await publisherMod.publishPost(
      env,
      payload.html,
      payload.parts,
      payload.media,
    );
    if (!result.ok) {
      throw new Error(result.error ?? "publishPost returned not-ok");
    }

    // Mark published (unconditional here — approval-repo's setApprovalPublished
    // is the idempotent variant used by callback handlers; for scheduled posts
    // the queue is the only publisher so a plain update is fine).
    const firstMsgId = result.messageIds[0] ?? null;
    if (firstMsgId !== null) {
      // env.TARGET_CHANNEL may be "@channel" or "-100xxx"; store as-is — the
      // value is meaningful to the dashboard even if it isn't a numeric id.
      const chatIdVal = Number(env.TARGET_CHANNEL);
      await updateJobStatus(env, jobId, "published", {
        publishedMessageId: firstMsgId,
        publishedChatId: Number.isFinite(chatIdVal) ? chatIdVal : 0,
      });
    } else {
      await updateJobStatus(env, jobId, "published");
    }
    ctx.waitUntil(safe(recordPublished(env, job.userId)));
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    const attempts = await incrementAttempts(env, jobId);
    if (attempts < MAX_PUBLISH_ATTEMPTS) {
      log("warn", "queue.consumer.handlePublishScheduled", "publish failed; will retry", {
        jobId,
        error: msg,
        attempts,
      });
      // Re-throw so the outer handler calls message.retry().
      throw err;
    }
    log("error", "queue.consumer.handlePublishScheduled", "publish failed permanently", {
      jobId,
      error: msg,
      attempts,
    });
    await updateJobStatus(env, jobId, "failed", { errorMessage: msg });
    ctx.waitUntil(safe(recordFailed(env, job.userId)));
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Wrap a promise so it never rejects — used for fire-and-forget ctx.waitUntil
 * calls where a rejection would surface as an unhandled rejection.
 */
function safe<T>(p: Promise<T>): Promise<void> {
  return p.then(
    () => undefined,
    (e) => {
      log("warn", "queue.consumer.safe", "background op failed", {
        error: (e as Error)?.message ?? String(e),
      });
    },
  );
}
