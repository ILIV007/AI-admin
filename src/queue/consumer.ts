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
  claimForPublish,
  createJob,
  getJob,
  incrementAttempts,
  updateJobStatus,
} from "../storage/repositories/jobs";
import { recordScheduled } from "../storage/repositories/stats";
import { sendMessage, sendChatAction, editMessageText, sendPhoto, sendVideo, sendDocument, sendAnimation } from "../telegram/client";
import { isAuthorized } from "../storage/repositories/admins";
import { enqueueMediaGroupFinalize } from "./producer";
import { MEDIA_GROUP_WINDOW_MS, TELEGRAM_LIMITS } from "../config/defaults";
import { truncateVisible } from "../telegram/entities";

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
    // Log to debug_events so the /Admi-bug panel can show recent errors
    try {
      const { insertEvent } = await import("../storage/repositories/debug-events");
      await insertEvent(env, "error", `queue: ${(body as { kind?: string }).kind || "unknown"}`, {
        error: msg.slice(0, 500),
        stack: (err as Error)?.stack?.slice(0, 500),
      });
    } catch {
      /* ignore — debug_events table might not exist yet */
    }
    // Notify admin of critical errors (best-effort)
    try {
      const { notifyError } = await import("../observability/notify");
      await notifyError(env, `queue.consumer (${(body as { kind?: string }).kind || "unknown"})`, msg, {
        kind: (body as { kind?: string }).kind,
      });
    } catch {
      /* ignore */
    }
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

  // Check if user is admin (for admin-only features: typing, loading, report, copy)
  const isAdmin = await isAuthorized(env, userId).catch(() => false);

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

  // ── Channel post: edit in place if channelEditing is enabled ────
  if (content.isChannelPost && content.chatType === "channel") {
    log("info", "queue.consumer", "channel post received", {
      messageId: content.messageId,
      chatId: content.chatId,
      fromId: content.fromId,
      hasText: !!content.text,
      hasMedia: !!content.media,
    });
    const channelSettings = await getSettings(env, userId || Number(env.ADMIN_ID));
    if (channelSettings.channelEditing) {
      // Skip if this is the bot's own post (prevent infinite loop)
      // Cache bot ID in KV to avoid calling getMe every time
      let botId: number | null = null;
      try {
        const cached = await env.AI_ADMIN_KV.get("bot:id");
        if (cached) {
          botId = Number(cached);
        } else {
          const { getMe } = await import("../telegram/client");
          const me = await getMe(env.BOT_TOKEN);
          botId = me.id;
          await env.AI_ADMIN_KV.put("bot:id", String(botId), { expirationTtl: 7 * 24 * 60 * 60 }); // 7 days
        }
      } catch (e) {
        log("warn", "queue.consumer", "failed to get bot ID", { error: String(e) });
      }
      if (botId && content.fromId === botId) {
        log("info", "queue.consumer", "skipping self-post in channel");
        return;
      }
      log("info", "queue.consumer", "running channel edit pipeline");
      await runChannelEditPipeline(env, content, channelSettings);
      return;
    } else {
      log("info", "queue.consumer", "channel post ignored (channelEditing OFF)");
      return;
    }
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

  // ── Normal single message: pipeline ─────────────────────────────
  const settings = await getSettings(env, userId);

  // Send "typing" indicator to admin (shows bot is working)
  // Use content.chatId (the chat where the message came from) for typing
  if (isAdmin) {
    await sendChatAction(env.BOT_TOKEN, {
      chat_id: content.chatId,
      action: "typing",
    }).catch(() => undefined);
    // Also send typing to admin's private chat if different
    if (userId !== content.chatId) {
      await sendChatAction(env.BOT_TOKEN, {
        chat_id: userId,
        action: "typing",
      }).catch(() => undefined);
    }
  }

  // Send a loading message to admin that will be edited to a report later
  let loadingMsgId: number | undefined;
  if (isAdmin) {
    try {
      const { t, getUiLanguage } = await import("../i18n");
      const lang = getUiLanguage(settings);
      const loadingText = `<blockquote><b>${t(lang, "processing")}</b></blockquote>\n\n${t(lang, "processing.steps")}`;
      const loadingResp = await sendMessage(env.BOT_TOKEN, {
        chat_id: userId,
        text: loadingText,
        parse_mode: "HTML",
      }).catch(() => undefined);
      if (loadingResp && typeof loadingResp === "object" && "message_id" in loadingResp) {
        loadingMsgId = (loadingResp as { message_id: number }).message_id;
      }
    } catch { /* ignore */ }
  }

  const t0 = Date.now();
  const pipelineMod: {
    runPipeline: (
      env: Env,
      content: ExtractedContent,
      settings: Settings,
    ) => Promise<import("../types").PipelineResult>;
  } = await import("../processing/pipeline");

  // Keep sending "typing" indicator every 4s while the pipeline runs.
  // Telegram's typing indicator expires after ~5s, so we need to refresh it
  // for long AI operations (10-15s).
  const typingInterval = isAdmin
    ? setInterval(() => {
        sendChatAction(env.BOT_TOKEN, {
          chat_id: content.chatId,
          action: "typing",
        }).catch(() => undefined);
        if (userId !== content.chatId) {
          sendChatAction(env.BOT_TOKEN, {
            chat_id: userId,
            action: "typing",
          }).catch(() => undefined);
        }
      }, 4000)
    : null;

  let result: import("../types").PipelineResult;
  try {
    result = await pipelineMod.runPipeline(env, content, settings);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
  const elapsedMs = Date.now() - t0;

  // Record stats based on outcome. Fire-and-forget via ctx.waitUntil.
  if (result.aiUsed) {
    ctx.waitUntil(safe(recordAiCall(env, userId)));
  }
  if (result.action === "published") {
    ctx.waitUntil(safe(recordPublished(env, userId)));
    // Create a history record so /Admi-bug history tab can show it
    ctx.waitUntil(safe(createHistoryRecord(env, userId, content, result, elapsedMs)));
  } else if (result.action === "edited") {
    // P0-CE1: channel edit succeeded — count as a published stat (the post
    // was updated in place, no new message in the channel).
    ctx.waitUntil(safe(recordPublished(env, userId)));
  } else if (result.action === "preview") {
    ctx.waitUntil(safe(recordApproval(env, userId)));
  } else if (result.action === "scheduled") {
    // Scheduled posts are counted as "scheduled" now; they'll be counted as
    // "published" later when the cron publishes them.
    ctx.waitUntil(safe(recordScheduled(env, userId)));
  } else if (result.action === "failed") {
    ctx.waitUntil(safe(recordFailed(env, userId)));
  }

  // ── Send post copy to admin + edit loading → report ─────────────
  // ALWAYS send to admin if they're authorized (regardless of chatType)
  if (isAdmin) {
    await sendAdminReport(env, userId, content, result, elapsedMs, loadingMsgId);
  }
}

// ============================================================
// createHistoryRecord — store every published post in jobs table for /Admi-bug history
// ============================================================

async function createHistoryRecord(
  env: Env,
  userId: number,
  content: ExtractedContent,
  result: import("../types").PipelineResult,
  elapsedMs: number,
): Promise<void> {
  try {
    const payload = JSON.stringify({
      html: result.html.slice(0, 500), // truncate for storage
      parts: result.parts.length,
      media: content.media?.type || null,
      category: result.classification.category,
      language: result.classification.language,
      aiUsed: result.aiUsed,
      aiProvider: result.aiProvider || null,
      aiModel: result.aiModel || null,
      elapsedMs,
      originalTextPreview: content.text.slice(0, 200),
    });
    await createJob(env, {
      type: "approval", // reuse existing type (CHECK constraint allows this)
      status: "published",
      userId,
      chatId: content.chatId,
      messageId: content.messageId,
      payload,
      scheduledFor: null,
    });
  } catch (e) {
    log("warn", "queue.consumer", "history record creation failed", { error: String(e) });
  }
}

// ============================================================
// sendAdminReport — send published post copy to admin + edit loading → report
// ============================================================

async function sendAdminReport(
  env: Env,
  userId: number,
  content: ExtractedContent,
  result: import("../types").PipelineResult,
  elapsedMs: number,
  loadingMsgId?: number,
): Promise<void> {
  try {
    // Get UI language for report
    const { t, getUiLanguage } = await import("../i18n");
    let lang = getUiLanguage();
    try {
      const { getSettings } = await import("../storage/repositories/settings");
      const settings = await getSettings(env, userId);
      lang = getUiLanguage(settings);
    } catch { /* use default */ }

    // 1. Send the published post copy to admin (same content as channel).
    //    Skipped for "scheduled" (not published yet) and "edited" (the
    //    channel post was updated in place — admin sees the edit directly).
    if (result.parts.length > 0 && result.action === "published") {
      try {
        if (content.media) {
          const mediaParams: Record<string, unknown> = {
            chat_id: userId,
            caption: truncateVisible(result.parts[0] ?? "", TELEGRAM_LIMITS.CAPTION_MAX_LEN),
            parse_mode: "HTML",
          };
          if (content.media.type === "photo") {
            mediaParams.photo = content.media.fileId;
            await sendPhoto(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          } else if (content.media.type === "video") {
            mediaParams.video = content.media.fileId;
            await sendVideo(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          } else if (content.media.type === "document") {
            mediaParams.document = content.media.fileId;
            await sendDocument(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          } else if (content.media.type === "animation") {
            mediaParams.animation = content.media.fileId;
            await sendAnimation(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          }
        } else {
          for (const part of result.parts) {
            await sendMessage(env.BOT_TOKEN, {
              chat_id: userId,
              text: part,
              parse_mode: "HTML",
            }).catch(() => undefined);
          }
        }
        if (content.media && result.parts.length > 1) {
          for (let i = 1; i < result.parts.length; i++) {
            await sendMessage(env.BOT_TOKEN, {
              chat_id: userId,
              text: result.parts[i],
              parse_mode: "HTML",
            }).catch(() => undefined);
          }
        }
      } catch { /* ignore */ }
    }

    // 2. Edit loading message → report
    if (loadingMsgId) {
      // Scheduled posts get a specialized reply showing the scheduled time,
      // the job id, and a short summary. We don't use the generic
      // "report.{action}" i18n key because the schedule confirmation needs
      // the time + job id inline.
      if (result.action === "scheduled" && result.scheduledFor) {
        const when = new Date(result.scheduledFor);
        const tehranTime = new Intl.DateTimeFormat("en-GB", {
          timeZone: "Asia/Tehran",
          dateStyle: "full",
          timeStyle: "short",
        }).format(when);
        const countdownSec = Math.max(
          0,
          Math.round((result.scheduledFor - Date.now()) / 1000),
        );
        const lines: string[] = [
          `<blockquote><b>📅 Scheduled</b></blockquote>`,
          ``,
          `Your post has been queued and will be published at:`,
          `<b>${escapeHtmlSimple(tehranTime)}</b>`,
          `⏱ Countdown: <code>${countdownSec}s</code>`,
        ];
        if (result.jobId) {
          lines.push(`🆔 Job ID: <code>${escapeHtmlSimple(result.jobId)}</code>`);
        }
        if (result.aiUsed && result.aiModel) {
          lines.push(
            `🤖 AI: <code>${escapeHtmlSimple(result.aiProvider || "?")}/${escapeHtmlSimple(result.aiModel)}</code>`,
          );
        }
        lines.push(`📊 Category: <code>${result.classification.category}</code>`);
        await editMessageText(env.BOT_TOKEN, {
          chat_id: userId,
          message_id: loadingMsgId,
          text: lines.join("\n"),
          parse_mode: "HTML",
        }).catch(() => undefined);
        return;
      }

      const statusKey = `report.${result.action}`;
      const status = t(lang, statusKey);

      const reportLines: string[] = [
        `<blockquote><b>${status}</b></blockquote>`,
        ``,
        `<b>${t(lang, "report.title")}</b>`,
        `<blockquote>`,
        `• ${t(lang, "report.category")}: <code>${result.classification.category}</code>`,
        `• ${t(lang, "report.language")}: <code>${result.classification.language}</code>`,
        `• ${t(lang, "report.words")}: <code>${result.classification.wordCount}</code>`,
        `• ${t(lang, "report.ai_used")}: <code>${result.aiUsed ? t(lang, "common.yes") : t(lang, "common.no")}</code>`,
      ];

      if (result.aiUsed && result.aiProvider && result.aiModel) {
        reportLines.push(`• ${t(lang, "report.ai_provider")}: <code>${result.aiProvider}</code>`);
        reportLines.push(`• ${t(lang, "report.ai_model")}: <code>${result.aiModel}</code>`);
      }

      reportLines.push(`• ${t(lang, "report.parts")}: <code>${result.parts.length}</code>`);
      reportLines.push(`• ${t(lang, "report.has_media")}: <code>${content.media ? content.media.type : t(lang, "common.no")}</code>`);
      reportLines.push(`• ${t(lang, "report.time")}: <code>${elapsedMs}ms</code>`);

      if (result.errorMessage) {
        reportLines.push(`• ${t(lang, "report.error")}: <code>${result.errorMessage.slice(0, 100)}</code>`);
      }

      reportLines.push(`</blockquote>`);

      if (content.text) {
        const preview = content.text.slice(0, 100).replace(/<[^>]+>/g, "");
        reportLines.push(``);
        reportLines.push(`<b>${t(lang, "report.original_preview")}:</b>`);
        reportLines.push(`<blockquote>${preview}</blockquote>`);
      }

      await editMessageText(env.BOT_TOKEN, {
        chat_id: userId,
        message_id: loadingMsgId,
        text: reportLines.join("\n"),
        parse_mode: "HTML",
      }).catch(() => undefined);
    }
  } catch (e) {
    log("warn", "queue.consumer", "admin report failed", { error: String(e) });
  }
}

// ============================================================
// runChannelEditPipeline — edit an existing channel post in place
// (matches V1 behavior: clean + AI rewrite + format, then editMessageText/Caption)
// ============================================================

async function runChannelEditPipeline(
  env: Env,
  content: ExtractedContent,
  settings: import("../types").Settings,
): Promise<void> {
  const scope = "queue.consumer.channelEdit";
  const startTime = Date.now();
  log("info", scope, "editing channel post", { messageId: content.messageId, chatId: content.chatId });

  try {
    // 1. Clean content + protect prompts
    const { cleanContent, protectPrompts, restorePrompts } = await import("../processing/cleaner");
    let inputText = content.text;
    // Strip existing footer (prevent duplicate)
    if (settings.footerText) {
      const footerEscaped = settings.footerText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const footerRegex = new RegExp(`\\s*${footerEscaped}\\s*$`, "i");
      inputText = inputText.replace(footerRegex, "").trim();
      const channelMatch = settings.footerText.match(/@(\w+)/);
      if (channelMatch) {
        const channelName = channelMatch[1];
        const channelRegex = new RegExp(`\\s*@${channelName}\\s*$`, "i");
        inputText = inputText.replace(channelRegex, "").trim();
      }
    }
    // P0-3 fix: pass ownHandle so cleanContent does NOT strip the channel's
    // own @handle as spam. Consistent with pipeline.ts.
    let ownHandle: string | undefined;
    if (settings.footerText) {
      const ownMatch = settings.footerText.match(/@([A-Za-z0-9_]+)/);
      ownHandle = ownMatch ? ownMatch[1] : undefined;
    }
    const cleaned = cleanContent(inputText, { ownHandle });
    const { text: protectedText, prompts } = protectPrompts(cleaned);
    let workingText = protectedText;

    // 2. Classify
    const { classify } = await import("../processing/classifier");
    const classification = classify(workingText);

    // 3. AI rewrite (if enabled)
    let aiUsed = false;
    let aiModel: string | undefined;
    const isAdmin = true; // channel posts are always processed
    if (settings.rewriteMode !== "none" && isAdmin) {
      if (classification.recommendedNeedsRewrite || settings.rewriteMode !== "normal") {
        try {
          const { rewriteWithFallback } = await import("../ai/fallback");
          const { getProfile } = await import("../config/defaults");
          const profile = getProfile(settings.profile);
          const aiReq: import("../types").AIRequest = {
            text: workingText,
            classification,
            settings,
            profile,
            mode: "rewrite",
          };
          const ai = await rewriteWithFallback(env, aiReq);
          if (ai?.ok && ai?.text) {
            workingText = ai.text;
            aiUsed = true;
            aiModel = ai.model;
          }
        } catch (e) {
          log("warn", scope, "AI failed in channel edit", { error: String(e) });
        }
      }
    }

    // 4. Sanitize + restore prompts
    const { sanitizeAiOutput } = await import("../formatting/sanitizer");
    workingText = sanitizeAiOutput(workingText);

    // 4b. Strip ANY @channel references from final text (AI may add them)
    if (settings.footerText) {
      const chMatch = settings.footerText.match(/@([A-Za-z0-9_]+)/);
      if (chMatch) {
        const chName = chMatch[1];
        const chRegex = new RegExp(
          `(^|\\n)[\\s\\p{Extended_Pictographic}]*@${chName}\\b[^\\n]*`,
          "gu",
        );
        workingText = workingText.replace(chRegex, "").trim();
      }
      const fEscaped = settings.footerText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      workingText = workingText.replace(new RegExp(fEscaped, "gi"), "").trim();
      workingText = workingText.replace(/\n{3,}/g, "\n\n").trim();
    }

    workingText = restorePrompts(workingText, prompts);

    // 5. Format to HTML
    const { markdownToBlocks } = await import("../formatting/blocks");
    const { blocksToTelegramHtml } = await import("../formatting/telegram-html");
    const { chunkHtml } = await import("../formatting/chunker");
    const blocks = markdownToBlocks(workingText);
    const html = blocksToTelegramHtml(blocks, settings.footerText);
    const parts = chunkHtml(html, 4000, settings.footerText);

    // Channel posts are single message — use first part only
    const editHtml = parts[0] || html;

    // 6. Edit the channel post
    const { editMessageText, editMessageCaption, sendMessage } = await import("../telegram/client");
    let editResult: { ok: boolean; error?: string };

    log("info", scope, "attempting edit", {
      chatId: content.chatId,
      messageId: content.messageId,
      hasMedia: !!content.media,
      htmlLength: editHtml.length,
    });

    if (content.media) {
      try {
        await editMessageCaption(env.BOT_TOKEN, {
          chat_id: content.chatId,
          message_id: content.messageId,
          caption: truncateVisible(editHtml, TELEGRAM_LIMITS.CAPTION_MAX_LEN),
          parse_mode: "HTML",
        });
        editResult = { ok: true };
        log("info", scope, "editMessageCaption success");
      } catch (e) {
        editResult = { ok: false, error: String(e) };
        log("error", scope, "editMessageCaption failed", { error: String(e), chatId: content.chatId, messageId: content.messageId });
      }
    } else {
      try {
        await editMessageText(env.BOT_TOKEN, {
          chat_id: content.chatId,
          message_id: content.messageId,
          text: editHtml,
          parse_mode: "HTML",
        });
        editResult = { ok: true };
        log("info", scope, "editMessageText success");
      } catch (e) {
        editResult = { ok: false, error: String(e) };
        log("error", scope, "editMessageText failed", { error: String(e), chatId: content.chatId, messageId: content.messageId });
      }
    }

    const elapsedMs = Date.now() - startTime;

    // 7. Notify admin
    const adminId = Number(env.ADMIN_ID);

    if (editResult.ok) {
      // Stats
      try {
        const { recordPublished, recordAiCall } = await import("../storage/repositories/stats");
        await recordPublished(env, adminId);
        if (aiUsed) await recordAiCall(env, adminId);
      } catch { /* ignore */ }

      const reportText =
        `<blockquote><b>✏️ Channel Post Edited</b></blockquote>\n\n` +
        `<b>📊 Report</b>\n` +
        `<blockquote>\n` +
        `• Message ID: <code>${content.messageId}</code>\n` +
        `• Category: <code>${classification.category}</code>\n` +
        `• AI Used: <code>${aiUsed ? "Yes" : "No"}</code>\n` +
        (aiUsed ? `• AI Model: <code>${aiModel}</code>\n` : "") +
        `• Time: <code>${elapsedMs}ms</code>\n` +
        `</blockquote>`;

      await sendMessage(env.BOT_TOKEN, {
        chat_id: adminId,
        text: reportText,
        parse_mode: "HTML",
      }).catch(() => undefined);
    } else {
      const errorText =
        `<blockquote><b>❌ Channel Edit Failed</b></blockquote>\n\n` +
        `<b>Error:</b> <code>${escapeHtmlSimple(editResult.error || "unknown")}</code>\n` +
        `<b>Message ID:</b> <code>${content.messageId}</code>`;

      await sendMessage(env.BOT_TOKEN, {
        chat_id: adminId,
        text: errorText,
        parse_mode: "HTML",
      }).catch(() => undefined);
    }
  } catch (e) {
    log("error", scope, "channel edit pipeline threw", { error: String(e) });
  }
}

function escapeHtmlSimple(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

  // Atomically claim the group. markFinalized now returns true only if THIS
  // call flipped finalized 0→1. If another concurrent handler already claimed
  // it, we get false and must back off — otherwise we'd double-publish.
  const claimed = await mediaGroupsRepo.markFinalized(env, mediaGroupId);
  if (!claimed) {
    log("info", "queue.finalizeMediaGroup", "group already finalized by another handler; skipping", {
      mediaGroupId,
    });
    return;
  }

  // Combine: concatenate captions in order for the text
  const combinedText = items
    .map((i) => i.text)
    .filter((t) => t && t.trim().length > 0)
    .join("\n\n");

  // Collect ALL media items for album sending
  const allMedia = items
    .filter((i) => i.media)
    .map((i) => i.media!) as NonNullable<ExtractedContent["media"]>[];

  // Primary media = first one (for backward compat with pipeline)
  const primaryMedia = allMedia[0];

  const firstItem = items[0];
  const content: ExtractedContent = {
    fromId: firstItem.fromId,
    fromName: "",
    chatId: firstItem.chatId,
    chatType: "channel",
    messageId: firstItem.messageId,
    text: combinedText,
    entities: [],
    media: primaryMedia,
    mediaGroupId: undefined,
    isChannelPost: false,
    isEdit: false,
  };

  const settings = await getSettings(env, firstItem.fromId);

  // Send typing indicator + loading message for admin
  const isAdmin = await isAuthorized(env, firstItem.fromId).catch(() => false);
  let loadingMsgId: number | undefined;
  if (isAdmin && firstItem.fromId) {
    // Typing
    await sendChatAction(env.BOT_TOKEN, {
      chat_id: firstItem.fromId,
      action: "typing",
    }).catch(() => undefined);

    // Loading message
    try {
      const { t, getUiLanguage } = await import("../i18n");
      const lang = getUiLanguage(settings);
      const loadingText = `<blockquote><b>${t(lang, "processing")}</b></blockquote>\n\n${t(lang, "processing.steps")}`;
      const loadingResp = await sendMessage(env.BOT_TOKEN, {
        chat_id: firstItem.fromId,
        text: loadingText,
        parse_mode: "HTML",
      }).catch(() => undefined);
      if (loadingResp && typeof loadingResp === "object" && "message_id" in loadingResp) {
        loadingMsgId = (loadingResp as { message_id: number }).message_id;
      }
    } catch { /* ignore */ }
  }

  const pipelineMod: {
    runPipeline: (
      env: Env,
      content: ExtractedContent,
      settings: Settings,
    ) => Promise<import("../types").PipelineResult>;
  } = await import("../processing/pipeline");

  const result = await pipelineMod.runPipeline(env, content, settings);
  // elapsedMs not needed for media groups // timing not critical for media groups

  // If published, send ALL media as album + text as separate message
  if (result.action === "published" && result.parts.length > 0) {
    try {
      // Send album with first part as caption (truncated to 1024-char caption limit)
      if (allMedia.length > 1) {
        const { sendMediaGroup } = await import("../telegram/client");
        const safeCaption = truncateVisible(result.parts[0] ?? "", TELEGRAM_LIMITS.CAPTION_MAX_LEN);
        const mediaItems = allMedia.map((m, i) => ({
          type: m.type,
          media: m.fileId,
          caption: i === 0 ? safeCaption : undefined,
          parse_mode: i === 0 ? "HTML" as const : undefined,
        }));
        await sendMediaGroup(env.BOT_TOKEN, {
          chat_id: env.TARGET_CHANNEL,
          media: mediaItems,
        }).catch(() => undefined);
      }
      // Send remaining text parts
      for (let i = 1; i < result.parts.length; i++) {
        await sendMessage(env.BOT_TOKEN, {
          chat_id: env.TARGET_CHANNEL,
          text: result.parts[i],
          parse_mode: "HTML",
        }).catch(() => undefined);
      }
      // Send copy to admin PV
      if (firstItem.fromId) {
        if (allMedia.length > 1) {
          const { sendMediaGroup } = await import("../telegram/client");
          const adminCaption = truncateVisible(result.parts[0] ?? "", TELEGRAM_LIMITS.CAPTION_MAX_LEN);
          const adminMediaItems = allMedia.map((m, i) => ({
            type: m.type,
            media: m.fileId,
            caption: i === 0 ? adminCaption : undefined,
            parse_mode: i === 0 ? "HTML" as const : undefined,
          }));
          await sendMediaGroup(env.BOT_TOKEN, {
            chat_id: firstItem.fromId,
            media: adminMediaItems,
          }).catch(() => undefined);
        } else if (primaryMedia) {
          // Single media → sendPhoto/sendVideo etc to admin
          const mediaParams: Record<string, unknown> = {
            chat_id: firstItem.fromId,
            caption: truncateVisible(result.parts[0] ?? "", TELEGRAM_LIMITS.CAPTION_MAX_LEN),
            parse_mode: "HTML",
          };
          if (primaryMedia.type === "photo") {
            mediaParams.photo = primaryMedia.fileId;
            await sendPhoto(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          } else if (primaryMedia.type === "video") {
            mediaParams.video = primaryMedia.fileId;
            await sendVideo(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          } else if (primaryMedia.type === "document") {
            mediaParams.document = primaryMedia.fileId;
            await sendDocument(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          }
        } else {
          // No media → text only
          for (const part of result.parts) {
            await sendMessage(env.BOT_TOKEN, {
              chat_id: firstItem.fromId,
              text: part,
              parse_mode: "HTML",
            }).catch(() => undefined);
          }
        }
        // Remaining parts to admin
        if (allMedia.length <= 1) {
          for (let i = 1; i < result.parts.length; i++) {
            await sendMessage(env.BOT_TOKEN, {
              chat_id: firstItem.fromId,
              text: result.parts[i],
              parse_mode: "HTML",
            }).catch(() => undefined);
          }
        }
      }
    } catch (e) {
      log("warn", "queue.consumer", "media group publish/admin copy failed", { error: String(e) });
    }
  }

  if (result.aiUsed) {
    ctx.waitUntil(safe(recordAiCall(env, firstItem.fromId)));
  }
  if (result.action === "published") {
    ctx.waitUntil(safe(recordPublished(env, firstItem.fromId)));
  } else if (result.action === "preview") {
    ctx.waitUntil(safe(recordApproval(env, firstItem.fromId)));
  } else if (result.action === "scheduled") {
    ctx.waitUntil(safe(recordScheduled(env, firstItem.fromId)));
  } else if (result.action === "failed") {
    ctx.waitUntil(safe(recordFailed(env, firstItem.fromId)));
  }

  // Edit loading message → report
  if (loadingMsgId && firstItem.fromId) {
    try {
      const { t, getUiLanguage } = await import("../i18n");
      const lang = getUiLanguage(settings);
      const statusKey = `report.${result.action}`;
      const status = t(lang, statusKey);
      const reportLines: string[] = [
        `<blockquote><b>${status}</b></blockquote>`,
        ``,
        `<b>${t(lang, "report.title")}</b>`,
        `<blockquote>`,
        `• ${t(lang, "report.category")}: <code>${result.classification?.category || "media"}</code>`,
        `• AI Used: <code>${result.aiUsed ? "Yes" : "No"}</code>`,
      ];
      if (result.aiUsed && result.aiModel) {
        reportLines.push(`• AI Model: <code>${result.aiModel}</code>`);
      }
      reportLines.push(`• Media items: <code>${allMedia.length}</code>`);
      reportLines.push(`</blockquote>`);
      await editMessageText(env.BOT_TOKEN, {
        chat_id: firstItem.fromId,
        message_id: loadingMsgId,
        text: reportLines.join("\n"),
        parse_mode: "HTML",
      }).catch(() => undefined);
    } catch { /* ignore */ }
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
  // Atomically claim the job (pending → publishing). This prevents the
  // double-publish race where the cron enqueues the same due job twice and
  // two handlers both see status=pending. Only the first caller gets true.
  const claimed = await claimForPublish(env, jobId);
  if (!claimed) {
    log("info", "queue.consumer.handlePublishScheduled", `job already claimed/published; skipping`, { jobId, status: job.status });
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

    // Send copy to admin + notification
    try {
      const adminId = Number(env.ADMIN_ID);
      if (adminId && job.userId !== adminId) {
        // Send post copy to admin
        if (payload.media) {
          const mediaParams: Record<string, unknown> = {
            chat_id: adminId,
            caption: truncateVisible(payload.parts[0] || "", TELEGRAM_LIMITS.CAPTION_MAX_LEN),
            parse_mode: "HTML",
          };
          if (payload.media.type === "photo") {
            mediaParams.photo = payload.media.fileId;
            await sendPhoto(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          } else if (payload.media.type === "video") {
            mediaParams.video = payload.media.fileId;
            await sendVideo(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          } else if (payload.media.type === "document") {
            mediaParams.document = payload.media.fileId;
            await sendDocument(env.BOT_TOKEN, mediaParams as never).catch(() => undefined);
          }
        } else {
          for (const part of payload.parts) {
            await sendMessage(env.BOT_TOKEN, {
              chat_id: adminId,
              text: part,
              parse_mode: "HTML",
            }).catch(() => undefined);
          }
        }
        // Send notification
        await sendMessage(env.BOT_TOKEN, {
          chat_id: adminId,
          text: `<blockquote><b>📅 Scheduled Post Published</b></blockquote>\nJob ID: <code>${jobId}</code>`,
          parse_mode: "HTML",
        }).catch(() => undefined);
      }
    } catch { /* ignore */ }
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
