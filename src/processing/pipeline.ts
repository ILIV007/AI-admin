/**
 * src/processing/pipeline.ts
 * -----------------------------------------------------------------------------
 * Main content pipeline orchestration.
 *
 * Flow:
 *   1. cleanContent + protectPrompts       (idempotent, prompt-safe)
 *   2. classify                            (rule-based, no AI)
 *   3. Decide rewrite mode                 (priority: none → user → classifier)
 *   4. AI rewrite (admins only)            (dynamic import of ../ai/fallback)
 *   5. On AI failure → graceful format-only
 *   6. validatePreservation                (URLs/repos/code/packages)
 *   7. sanitizeAiOutput                    (strip raw HTML, balance fences)
 *   8. restorePrompts                      (placeholders → original prompts)
 *   9. markdownToBlocks                    (rich markdown IR)
 *  10. blocksToTelegramHtml                (escaped footer included)
 *  11. chunkHtml(html, 4000, footer)       (visible-length, balanced, last-only footer)
 *  12. Approval / publish / format-only    (admin → publish|preview; non-admin → format_only)
 *
 * PRIORITY (fixes V1 bug #6 — decision always overrode user setting):
 *   • settings.rewriteMode === "none"                              → no rewrite
 *   • !isAdmin                                                     → no AI, format-only
 *   • classification.recommendedNeedsRewrite || rewriteMode != normal → AI
 *   • otherwise                                                    → format-only
 * -----------------------------------------------------------------------------
 */

import type {
  AIRequest,
  AIResult,
  Classification,
  Env,
  ExtractedContent,
  PipelineResult,
  Settings,
} from "../types";
import { cleanContent, protectPrompts, restorePrompts } from "./cleaner";
import { classify } from "./classifier";
import { validatePreservation } from "./preservation";
import { sanitizeAiOutput } from "../formatting/sanitizer";
import { markdownToBlocks } from "../formatting/blocks";
import { blocksToTelegramHtml } from "../formatting/telegram-html";
import { chunkHtml } from "../formatting/chunker";
import { getProfile } from "../config/defaults";
import { ownerUserId } from "../config/env";
import { log } from "../observability/logger";

// ============================================================
// Constants
// ============================================================

// Telegram hard cap is 4096 visible chars. We chunk at 4000 to leave headroom
// for the footer and any entity-expansion surprises.
const CHUNK_MAX_VISIBLE = 4000;

// ============================================================
// runPipeline
// ============================================================

export async function runPipeline(
  env: Env,
  content: ExtractedContent,
  settings: Settings,
): Promise<PipelineResult> {
  const scope = "pipeline.runPipeline";
  const isAdmin = content.fromId != null && content.fromId === ownerUserId(env);

  // ── 1. Clean content + protect prompts ──────────────────────────
  // First, strip ANY occurrence of the footer channel from the input text
  // (prevents duplicate @channel appearing before the footer).
  // This handles: footer at end, @channel in middle, @channel with emoji, etc.
  let inputText = content.text;
  if (settings.footerText) {
    // Extract channel name from footer (e.g. "🌀 @ILIVIR3" → "ILIVIR3")
    const channelMatch = settings.footerText.match(/@([A-Za-z0-9_]+)/);
    if (channelMatch) {
      const channelName = channelMatch[1];
      // Remove ALL occurrences of @channelName (with optional emoji prefix)
      // Pattern: optional emoji/space + @channelName + word boundary
      const channelRegex = new RegExp(
        `(^|\\n)[\\s\\p{Extended_Pictographic}]*@${channelName}\\b[^\\n]*`,
        "gu",
      );
      inputText = inputText.replace(channelRegex, "").trim();
    }
    // Also remove the full footer text if it appears anywhere
    const footerEscaped = settings.footerText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const footerRegex = new RegExp(footerEscaped, "gi");
    inputText = inputText.replace(footerRegex, "").trim();
    // Clean up multiple blank lines
    inputText = inputText.replace(/\n{3,}/g, "\n\n").trim();
  }
  const cleaned = cleanContent(inputText);
  const { text: protectedText, prompts } = protectPrompts(cleaned);
  let workingText = protectedText;

  // ── 2. Classify ─────────────────────────────────────────────────
  const classification: Classification = classify(workingText);

  // ── 3. Decide rewrite mode ──────────────────────────────────────
  // Priority: none → non-admin (no AI) → recommended-or-explicit → format-only
  let useAi = false;
  if (settings.rewriteMode !== "none" && isAdmin) {
    if (classification.recommendedNeedsRewrite || settings.rewriteMode !== "normal") {
      useAi = true;
    }
  }

  // ── 4. AI rewrite (admins only) ─────────────────────────────────
  let aiUsed = false;
  let aiProvider: string | undefined;
  let aiModel: string | undefined;
  let finalText = workingText;

  if (useAi) {
    // Send typing again before AI call (typing expires after ~5s)
    if (isAdmin && content.chatType === "private" && content.fromId != null) {
      try {
        const { sendChatAction } = await import("../telegram/client");
        await sendChatAction(env.BOT_TOKEN, {
          chat_id: content.fromId,
          action: "typing",
        });
      } catch { /* ignore */ }
    }
    try {
      // Dynamic import per spec — other agents own ../ai/fallback.
      const aiMod: {
        rewriteWithFallback: (
          env: Env,
          req: AIRequest,
        ) => Promise<AIResult>;
      } = await import("../ai/fallback");
      const profile = getProfile(settings.profile);
      const aiReq: AIRequest = {
        text: workingText,
        classification,
        settings,
        profile,
        // Task 28: when the user picked "summarize" as their rewrite mode,
        // route the request through the summarize branch of the prompt
        // builder (compress to ~40%, drop filler, keep technical refs).
        mode: settings.rewriteMode === "summarize" ? "summarize" : "rewrite",
      };
      const ai: AIResult = await aiMod.rewriteWithFallback(env, aiReq);

      if (ai?.ok && ai?.text) {
        // ── 6. Validate preservation ────────────────────────────
        const validation = validatePreservation(workingText, ai.text);
        if (!validation.ok) {
          log("warn", scope, "preservation validation failed", {
            missing: validation.missing,
            category: classification.category,
          });
          // Critical = URL or repo loss. Those break the post's value, so
          // fall back to the cleaned original.
          const criticalMissing = validation.missing.filter(
            (m) => m.startsWith("url:") || m.startsWith("repo:"),
          );
          if (criticalMissing.length > 0) {
            log("warn", scope, "critical content missing; using cleaned original", {
              criticalMissing,
            });
            finalText = workingText;
          } else {
            // Minor loss (codeblock merge, package rename) — keep AI output.
            finalText = ai.text;
          }
        } else {
          finalText = ai.text;
        }
        aiUsed = true;
        aiProvider = ai.provider;
        aiModel = ai.model;
      } else {
        // ── 5. Graceful fallback to format-only ─────────────────
        log("warn", scope, "AI failed; falling back to format-only", {
          error: ai?.error,
          provider: ai?.provider,
          model: ai?.model,
        });
        finalText = workingText;
      }
    } catch (e) {
      log("error", scope, "AI rewrite threw; format-only", {
        error: String(e),
      });
      finalText = workingText;
    }
  }

  // ── 7. Sanitize AI output (also applies to cleaned text — harmless) ──
  finalText = sanitizeAiOutput(finalText);

  // ── 7b. Strip ANY @channel references from final text (AI may add them) ──
  // The AI knows about ILIVIR3 from the system prompt and might include
  // @ILIVIR3 in its output. Remove ALL occurrences to prevent duplicate
  // channel IDs before the footer.
  if (settings.footerText) {
    const chMatch = settings.footerText.match(/@([A-Za-z0-9_]+)/);
    if (chMatch) {
      const chName = chMatch[1];
      // Remove @channelName anywhere in the text (with optional emoji prefix on its own line)
      const chRegex = new RegExp(
        `(^|\\n)[\\s\\p{Extended_Pictographic}]*@${chName}\\b[^\\n]*`,
        "gu",
      );
      finalText = finalText.replace(chRegex, "").trim();
    }
    // Also remove the full footer text if it appears anywhere
    const fEscaped = settings.footerText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    finalText = finalText.replace(new RegExp(fEscaped, "gi"), "").trim();
    // Clean up multiple blank lines
    finalText = finalText.replace(/\n{3,}/g, "\n\n").trim();
  }

  // ── 8. Restore prompt placeholders ──────────────────────────────
  finalText = restorePrompts(finalText, prompts);

  // ── 9. Markdown → blocks ────────────────────────────────────────
  const blocks = markdownToBlocks(finalText);

  // ── 10. Blocks → Telegram HTML (footer escaped inside renderer) ─
  const html = blocksToTelegramHtml(blocks, settings.footerText);

  // ── 11. Chunk by visible length, footer only on last chunk ──────
  const parts = chunkHtml(html, CHUNK_MAX_VISIBLE, settings.footerText);

  // ── 12. Non-admin: format-only, do NOT publish ──────────────────
  if (!isAdmin) {
    log("info", scope, "non-admin; format-only", {
      fromId: content.fromId,
      category: classification.category,
    });
    return {
      ok: true,
      action: "format_only",
      html,
      parts,
      media: content.media,
      classification,
      aiUsed: false,
    };
  }

  // ── 12b. Approval mode: create job + send preview ───────────────
  if (settings.approvalMode) {
    let jobId: string | undefined;
    try {
      // approval-repo is now provided by task 2-d. The dynamic import keeps
      // the pipeline decoupled from storage at module-load time.
      const approvalMod: {
        createApprovalJob?: (
          env: Env,
          data: {
            userId: number;
            chatId: number;
            messageId: number;
            html: string;
            parts: string[];
            media?: ExtractedContent["media"];
            footer: string;
          },
        ) => Promise<string>;
      } = await import("../storage/repositories/approval-repo");
      if (approvalMod.createApprovalJob && content.fromId != null) {
        jobId = await approvalMod.createApprovalJob(env, {
          userId: content.fromId,
          chatId: content.chatId,
          messageId: content.messageId,
          html,
          parts,
          media: content.media,
          footer: settings.footerText,
        });
      } else {
        log("warn", scope, "approval-repo missing createApprovalJob");
      }
    } catch (e) {
      log("error", scope, "approval job creation failed", { error: String(e) });
    }

    // Send preview to the admin's private chat (userId).
    try {
      const publisherMod: {
        sendPreview?: (
          env: Env,
          userId: number,
          html: string,
          parts: string[],
          media?: ExtractedContent["media"],
          keyboard?: string,
        ) => Promise<{ ok: boolean; messageId?: number; error?: string }>;
      } = await import("../telegram/publisher");
      if (publisherMod.sendPreview && content.fromId != null) {
        // Build approval keyboard with Publish/Reject buttons
        let approvalKb: string | undefined;
        if (jobId) {
          try {
            const { approvalKeyboard } = await import("../admin/keyboards");
            approvalKb = approvalKeyboard(jobId);
          } catch { /* ignore */ }
        }
        const preview = await publisherMod.sendPreview(
          env,
          content.fromId,
          html,
          parts,
          content.media,
          approvalKb,
        );
        if (!preview?.ok) {
          log("warn", scope, "preview send failed", { error: preview?.error });
        }
      }
    } catch (e) {
      log("error", scope, "sendPreview threw", { error: String(e) });
    }

    return {
      ok: true,
      action: "preview",
      html,
      parts,
      media: content.media,
      classification,
      aiUsed,
      aiProvider,
      aiModel,
      jobId,
    };
  }

  // ── 12c. Schedule mode (task 26): store as scheduled_post, do NOT publish ──
  // When scheduleEnabled is ON and the sender is an admin, the formatted
  // post is persisted in D1 as a pending scheduled_post job with
  // scheduled_for = the computed next slot. The cron picks it up later and
  // publishes it via the queue. The admin sees a "📅 Scheduled for {time}"
  // reply instead of the published post copy.
  if (settings.scheduleEnabled && content.fromId != null) {
    try {
      const jobsMod: {
        listPendingScheduledForUser?: (
          env: Env,
          userId: number,
          limit?: number,
        ) => Promise<{ scheduledFor: number | null }[]>;
        createJob?: (
          env: Env,
          job: {
            type: "scheduled_post";
            status: "pending";
            userId: number;
            chatId: number;
            messageId: number;
            payload: string;
            scheduledFor: number;
            publishedMessageId?: number | null;
            publishedChatId?: number | null;
          },
        ) => Promise<string>;
      } = await import("../storage/repositories/jobs");
      const schedulerMod: {
        computeNextScheduledTime: (
          now: number,
          pendingScheduledFors: number[],
          messagesPerDay: number,
          intervalHours: number,
        ) => number;
      } = await import("./scheduler");

      if (!jobsMod.listPendingScheduledForUser || !jobsMod.createJob) {
        throw new Error("jobs repo missing required exports");
      }
      if (!schedulerMod.computeNextScheduledTime) {
        throw new Error("scheduler module missing computeNextScheduledTime");
      }

      const pending = await jobsMod.listPendingScheduledForUser(
        env,
        content.fromId,
        200,
      );
      const pendingFors = pending
        .map((p) => p.scheduledFor)
        .filter((t): t is number => typeof t === "number" && Number.isFinite(t));

      // Defensive: fall back to defaults if the settings row is malformed.
      const perDay =
        Number.isFinite(settings.scheduleMessagesPerDay) &&
        settings.scheduleMessagesPerDay! >= 1
          ? settings.scheduleMessagesPerDay!
          : 1;
      const intervalHours =
        Number.isFinite(settings.scheduleIntervalHours) &&
        settings.scheduleIntervalHours! >= 1
          ? settings.scheduleIntervalHours!
          : 24;

      const scheduledFor = schedulerMod.computeNextScheduledTime(
        Date.now(),
        pendingFors,
        perDay,
        intervalHours,
      );

      const payload = JSON.stringify({
        html,
        parts,
        media: content.media,
        footer: settings.footerText,
      });
      const jobId = await jobsMod.createJob(env, {
        type: "scheduled_post",
        status: "pending",
        userId: content.fromId,
        chatId: content.chatId,
        messageId: content.messageId,
        payload,
        scheduledFor,
        publishedMessageId: null,
        publishedChatId: null,
      });

      log("info", scope, "scheduled_post job created", {
        jobId,
        scheduledFor,
        perDay,
        intervalHours,
        pendingCount: pendingFors.length,
      });

      // Send preview to admin with Reject button (like approval mode)
      try {
        const publisherMod: {
          sendPreview?: (
            env: Env,
            userId: number,
            html: string,
            parts: string[],
            media?: ExtractedContent["media"],
            keyboard?: string,
          ) => Promise<{ ok: boolean; messageId?: number; error?: string }>;
        } = await import("../telegram/publisher");
        if (publisherMod.sendPreview && content.fromId != null) {
          // Build a reject keyboard for the scheduled post
          const { buildInlineKeyboard } = await import("../telegram/entities");
          const rejectKb = buildInlineKeyboard([
            [{ text: "🚫 Cancel Scheduled Post", callback_data: `cancelsched:${jobId}` }],
          ]);
          await publisherMod.sendPreview(
            env,
            content.fromId,
            html,
            parts,
            content.media,
            rejectKb,
          );
        }
      } catch (e) {
        log("warn", scope, "schedule preview send failed", { error: String(e) });
      }

      return {
        ok: true,
        action: "scheduled",
        html,
        parts,
        media: content.media,
        classification,
        aiUsed,
        aiProvider,
        aiModel,
        jobId,
        scheduledFor,
      };
    } catch (e) {
      log("error", scope, "schedule job creation failed; falling back to publish", {
        error: String(e),
      });
      // Fall through to direct publish so the admin's post isn't lost.
    }
  }

  // ── 12d. Publish directly to target channel ─────────────────────
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
    const result = await publisherMod.publishPost(env, html, parts, content.media);
    if (!result?.ok) {
      throw new Error(result?.error ?? "publish failed");
    }
    log("info", scope, "published", {
      messageIds: result.messageIds,
      category: classification.category,
      aiUsed,
      parts: parts.length,
    });
    return {
      ok: true,
      action: "published",
      html,
      parts,
      media: content.media,
      classification,
      aiUsed,
      aiProvider,
      aiModel,
    };
  } catch (e) {
    log("error", scope, "publish failed", { error: String(e) });
    return {
      ok: false,
      action: "failed",
      html,
      parts,
      media: content.media,
      classification,
      aiUsed,
      aiProvider,
      aiModel,
      errorMessage: String(e),
    };
  }
}
