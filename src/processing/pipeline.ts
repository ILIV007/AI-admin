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
import { isAuthorized, getRole } from "../storage/repositories/admins";
import { fixRtlParagraphs } from "../ai/prompts";
import { can } from "../domain/roles";
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
  // P0-1 fix: use isAuthorized() (checks admins table + owner) instead of
  // owner-only check. Editors/reviewers/viewers are now recognized as admins.
  // role is fetched for finer-grained decisions (e.g. who can use AI).
  const isAdmin =
    content.fromId != null && (await isAuthorized(env, content.fromId));
  const role =
    isAdmin && content.fromId != null
      ? await getRole(env, content.fromId)
      : null;

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
  // P0-3 fix: pass the channel's own handle so cleanContent does NOT strip
  // it as spam. Without this, @ILIVIR3 inside forwarded posts is removed.
  let ownHandle: string | undefined;
  if (settings.footerText) {
    const ownMatch = settings.footerText.match(/@([A-Za-z0-9_]+)/);
    ownHandle = ownMatch ? ownMatch[1] : undefined;
  }
  const cleaned = cleanContent(inputText, { ownHandle });
  const { text: protectedText, prompts } = protectPrompts(cleaned);
  let workingText = protectedText;

  // ── 2. Classify ─────────────────────────────────────────────────
  const classification: Classification = classify(workingText);

  // ── 3. Decide rewrite mode ──────────────────────────────────────
  // Priority: none → non-admin (no AI) → recommended-or-explicit → format-only
  // P0-1 fix: AI rewriting is available to owner + editor (not reviewer/viewer).
  // Non-admins always get format-only output.
  let useAi = false;
  const canUseAi = isAdmin && (role === "owner" || role === "editor");
  if (settings.rewriteMode !== "none" && canUseAi) {
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

  // ── 8b. Fix RTL: prepend RLM mark to Persian paragraphs that start with
  //      an English word (P2-5). Defense-in-depth behind the AI instruction.
  finalText = fixRtlParagraphs(finalText);

  // ── 9. Markdown → blocks ────────────────────────────────────────
  const blocks = markdownToBlocks(finalText);

  // ── 10. Blocks → Telegram HTML (footer escaped inside renderer) ─
  const html = blocksToTelegramHtml(blocks, settings.footerText);

  // ── 11. Chunk by visible length ──────
  // For media posts: caption limit is 1024 chars. Use 1000 for caption.
  // For text-only: message limit is 4096 chars. Use 4000.
  const hasMedia = !!content.media;
  const chunkMax = hasMedia ? 1000 : CHUNK_MAX_VISIBLE;
  let parts = chunkHtml(html, chunkMax, settings.footerText);

  // Check if this post contains prompts (from protectPrompts)
  const hasPrompts = prompts.length > 0;

  // Escape helper for footer (used in multiple places below).
  // Includes a null guard — settings.footerText may be null/undefined if a D1
  // row was corrupted or a future code path clears the default.
  const escapeFooter = (s: string | null | undefined): string =>
    s ? s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!)) : "";

  // For ALL posts (prompt and regular):
  // If >1 part: try summarize first to fit in 1 part.
  //
  // For PROMPT posts: NEVER split into multiple posts. Use standard summarize,
  // then an ultra-aggressive summarize that compresses the prompt content
  // itself. If both fail, force to a single (possibly truncated) part.
  //
  // For REGULAR posts: if summarize fails or still >1 part, use reply chain
  // with:
  //   - Footer on EVERY part
  //   - Page numbers (1/N, 2/N) ABOVE the footer, in ITALIC
  //   - Reply chain (each part replies to previous)
  if (parts.length > 1) {
    // Try summarize first
    log("info", scope, "post too long, attempting summarize", { parts: parts.length, hasPrompts });
    let summarizeSuccess = false;
    // Track the best (shortest) HTML + text so the reply-chain fallback
    // re-chunks the SUMMARIZED version, not the original.
    let bestHtml = html;
    try {
      const summarizeAiMod: {
        rewriteWithFallback: (env: Env, req: AIRequest) => Promise<AIResult>;
      } = await import("../ai/fallback");
      const summarizeProfile = getProfile(settings.profile);
      // P1-7 fix: summarize the ORIGINAL cleaned text (workingText), NOT
      // finalText (which has prompts restored, footer stripped, RTL marks
      // applied, etc.). Summarize mode is designed for raw content.
      const summarizeReq: AIRequest = {
        text: workingText,
        classification,
        settings: { ...settings, rewriteMode: "summarize" },
        profile: summarizeProfile,
        mode: "summarize",
      };
      const summaryResult = await summarizeAiMod.rewriteWithFallback(env, summarizeReq);
      if (summaryResult?.ok && summaryResult?.text) {
        const summaryBlocks = markdownToBlocks(summaryResult.text);
        const summaryHtml = blocksToTelegramHtml(summaryBlocks, settings.footerText);
        const newParts = chunkHtml(summaryHtml, chunkMax, settings.footerText);
        if (newParts.length < parts.length) {
          log("info", scope, "summarize reduced parts", { before: parts.length, after: newParts.length });
          parts = newParts;
          bestHtml = summaryHtml;
          finalText = summaryResult.text;
          aiUsed = true;
          aiProvider = summaryResult.provider;
          aiModel = summaryResult.model;
          if (newParts.length <= 1) {
            summarizeSuccess = true;
          }
        }
      }
    } catch (e) {
      log("warn", scope, "summarize failed; will use reply chain", { error: String(e) });
    }

    // ── PROMPT POSTS: ultra-summarize if standard summarize didn't fit ──
    // Prompts must NEVER be split into multiple posts. The ultra pass tells
    // the AI to aggressively compress the ```prompt block content itself
    // (drop redundant adjectives, keep --parameters + subject + key style).
    if (hasPrompts && !summarizeSuccess && parts.length > 1) {
      log("info", scope, "prompt post still too long; ultra-summarize", { parts: parts.length });
      try {
        const ultraMod: {
          rewriteWithFallback: (env: Env, req: AIRequest) => Promise<AIResult>;
        } = await import("../ai/fallback");
        const ultraProfile = getProfile(settings.profile);
        const ultraReq: AIRequest = {
          text: finalText,
          classification,
          settings: { ...settings, rewriteMode: "summarize" },
          profile: ultraProfile,
          mode: "summarize",
          // Inject as a top-level # OVERRIDE INSTRUCTION (NOT appended to text),
          // so the model treats it as a directive rather than source content.
          instructionOverride:
            "The source contains AI/image-generation prompts inside ```prompt fences. " +
            "AGGRESSIVELY compress the prompt content: remove redundant adjectives, duplicate " +
            "style descriptors, and filler words. KEEP the subject, ALL --parameters (e.g. " +
            "--ar, --v, --seed), negative prompts, and key technical terms. Target: fit the " +
            "ENTIRE output under 3000 visible characters so it fits in ONE Telegram message. " +
            "Preserve every ```prompt fence. Preserve ALL links. Preserve original language.",
        };
        const ultraResult = await ultraMod.rewriteWithFallback(env, ultraReq);
        if (ultraResult?.ok && ultraResult?.text) {
          const ultraBlocks = markdownToBlocks(ultraResult.text);
          const ultraHtml = blocksToTelegramHtml(ultraBlocks, settings.footerText);
          const ultraParts = chunkHtml(ultraHtml, chunkMax, settings.footerText);
          if (ultraParts.length < parts.length) {
            log("info", scope, "ultra-summarize reduced parts", { before: parts.length, after: ultraParts.length });
            parts = ultraParts;
            bestHtml = ultraHtml;
            finalText = ultraResult.text;
            aiProvider = ultraResult.provider;
            aiModel = ultraResult.model;
            if (ultraParts.length <= 1) {
              summarizeSuccess = true;
            }
          }
        }
      } catch (e) {
        log("warn", scope, "ultra-summarize failed", { error: String(e) });
      }
    }

    // ── PROMPT POSTS: NEVER split. Force to a single part (last resort). ──
    // If both summarize passes failed to get under 1 part, keep ONLY the
    // first chunk and ensure the footer is present. Some prompt content may
    // be truncated, but the post stays single — the user's hard requirement.
    if (hasPrompts && parts.length > 1) {
      log("warn", scope, "prompt post forced to single part (truncated)", { parts: parts.length });
      const footerBlock = settings.footerText
        ? `<blockquote>${escapeFooter(settings.footerText)}</blockquote>`
        : "";
      // Hard cap to chunkMax (minus footer room) so we never exceed Telegram's
      // caption limit (1024 for media) or message limit (4096 for text).
      // truncateVisible keeps HTML tags balanced.
      const footerRoom = footerBlock ? footerBlock.length + 2 : 0; // +2 for "\n"
      const cap = chunkMax - footerRoom;
      let single = parts[0];
      // Only truncate if it exceeds the cap.
      const { truncateVisible } = await import("../telegram/entities");
      if (single.length > cap) {
        single = truncateVisible(single, Math.max(100, cap));
      }
      // Ensure the single part ends with the footer.
      if (footerBlock && !single.endsWith(footerBlock)) {
        single = single.replace(/\s+$/, "") + "\n" + footerBlock;
      }
      parts = [single];
    }

    // ── REGULAR POSTS: reply chain with footer on ALL + page numbers ──
    // Page numbers go ABOVE the footer (not after it) and use ITALIC (<i>).
    if (!hasPrompts && !summarizeSuccess && parts.length > 1) {
      log("info", scope, "using reply chain split", { parts: parts.length });
      // Re-chunk the BEST html (summarized if available) with a smaller max
      // to leave room for the footer + page number on every part.
      const splitMax = (hasMedia ? 1000 : CHUNK_MAX_VISIBLE) - 150;
      parts = chunkHtml(bestHtml, splitMax, settings.footerText);
      const totalPages = parts.length;
      const footerEscaped = escapeFooter(settings.footerText);
      parts = parts.map((p, i) => {
        const pageNum = `${i + 1}/${totalPages}`;
        const pageMark = `<i>${pageNum}</i>`; // ITALIC page number
        const footerBlock = `<blockquote>${footerEscaped}</blockquote>`;
        if (p.endsWith(footerBlock)) {
          // Footer already there (last chunk from chunker) → insert page
          // number ABOVE the footer (between body and footer).
          return (
            p.slice(0, -footerBlock.length).replace(/\s+$/, "") +
            `\n${pageMark}\n` +
            footerBlock
          );
        }
        // No footer yet → append page number (above) then footer (below).
        return p.replace(/\s+$/, "") + `\n${pageMark}\n` + footerBlock;
      });
    }
  }

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
  //
  // P1-SS5 fix: if BOTH approvalMode and scheduleEnabled are ON, approval
  // takes precedence (the post gets a preview instead of being scheduled).
  // Log a warning so the admin understands why scheduling didn't fire.
  if (settings.scheduleEnabled && settings.approvalMode) {
    log("warn", scope, "both approval and schedule enabled; approval takes precedence — post will be previewed, not scheduled");
  }
  if (settings.scheduleEnabled && !settings.approvalMode && content.fromId != null) {
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

      // P1-SS6 fix: queue depth limit — max 50 pending scheduled posts per user.
      // Prevents unbounded D1 growth + accidental spam-scheduling.
      const MAX_PENDING_PER_USER = 50;
      if (pendingFors.length >= MAX_PENDING_PER_USER) {
        log("warn", scope, "schedule queue depth limit reached", {
          pending: pendingFors.length,
          limit: MAX_PENDING_PER_USER,
        });
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
          errorMessage: `Too many pending scheduled posts (max ${MAX_PENDING_PER_USER}). Wait for some to publish or cancel existing ones.`,
        };
      }

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

      // P1-SS3 fix: store parts WITHOUT footer in the payload. The cron
      // appends the footer at publish time. This prevents double-footer if
      // the cron ever reconstructs HTML from `html` + appends footer.
      // P2-SS8 fix: also store AI metadata so the cron can report which
      // model processed the post.
      const { chunkHtml: chunkHtmlNoFooter } = await import("../formatting/chunker");
      const partsNoFooter = chunkHtmlNoFooter(html, chunkMax, "");
      const payload = JSON.stringify({
        html,
        parts: partsNoFooter,
        media: content.media,
        footer: settings.footerText,
        aiUsed,
        aiProvider,
        aiModel,
        classification,
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

      // P1-SS2 fix: record the "scheduled" stat so the admin dashboard
      // counter reflects scheduled posts.
      try {
        const { recordScheduled } = await import("../storage/repositories/stats");
        await recordScheduled(env, content.fromId);
      } catch { /* best effort */ }

      // P1-SS4 fix: show the scheduled time in the admin preview message.
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
          const { buildInlineKeyboard } = await import("../telegram/entities");
          const rejectKb = buildInlineKeyboard([
            [{ text: "🚫 Cancel Scheduled Post", callback_data: `cancelsched:${jobId}` }],
          ]);
          // Format the scheduled time in Persian locale + Tehran timezone.
          const schedTime = new Date(scheduledFor).toLocaleString("fa-IR", {
            timeZone: "Asia/Tehran",
            dateStyle: "medium",
            timeStyle: "short",
          });
          const previewHtml =
            `📅 <b>Scheduled Post</b>\n\n` +
            `⏰ Will publish: <code>${schedTime}</code>\n\n` +
            html;
          await publisherMod.sendPreview(
            env,
            content.fromId,
            previewHtml,
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

  // ── 12d. Channel Edit mode (P0-CE1 + P1-CE2 + P1-X2) ────────────
  // If channelEditing is ON, the sender is an admin with edit_channel
  // permission, this is an EDIT of a previously-published source message,
  // AND we have a mapping to the channel message_id → edit in place.
  //
  // Telegram limits edits to 48h after the original post. We check
  // editDate (or fall back to "now") and skip the edit branch if the
  // mapping is older than 48h, falling through to a new publish.
  if (
    settings.channelEditing &&
    isAdmin &&
    content.isEdit &&
    can(role, "edit_channel")
  ) {
    try {
      const jobsMod: {
        getPublishedPost?: (
          env: Env,
          sourceChatId: number,
          sourceMessageId: number,
        ) => Promise<{
          publishedChatId: number;
          publishedMessageId: number;
          publishedAt: number;
        } | null>;
      } = await import("../storage/repositories/jobs");
      if (jobsMod.getPublishedPost && content.fromId != null) {
        const mapping = await jobsMod.getPublishedPost(
          env,
          content.chatId,
          content.messageId,
        );
        if (mapping) {
          // 48h edit window check.
          const editWindowMs = 48 * 60 * 60 * 1000;
          const ageMs = Date.now() - mapping.publishedAt;
          if (ageMs > editWindowMs) {
            log("info", scope, "channel edit skipped: original post >48h old", {
              ageHours: Math.round(ageMs / (60 * 60 * 1000)),
            });
            // Fall through to new publish.
          } else {
            const publisherMod: {
              editChannelPost?: (
                env: Env,
                chatId: number,
                messageId: number,
                html: string,
                hasMedia: boolean,
              ) => Promise<{ ok: boolean; error?: string }>;
            } = await import("../telegram/publisher");
            if (publisherMod.editChannelPost) {
              const editHtml = parts[0] || html;
              log("info", scope, "editing channel post in place", {
                channelMsgId: mapping.publishedMessageId,
                hasMedia: !!content.media,
              });
              const editResult = await publisherMod.editChannelPost(
                env,
                mapping.publishedChatId,
                mapping.publishedMessageId,
                editHtml,
                !!content.media,
              );
              if (editResult?.ok) {
                return {
                  ok: true,
                  action: "edited",
                  html,
                  parts,
                  media: content.media,
                  classification,
                  aiUsed,
                  aiProvider,
                  aiModel,
                };
              }
              log("warn", scope, "channel edit failed; falling back to new publish", {
                error: editResult?.error,
              });
              // Fall through to new publish so the edited content isn't lost.
            }
          }
        }
      }
    } catch (e) {
      log("warn", scope, "channel edit branch threw; falling back to publish", {
        error: String(e),
      });
    }
  }

  // ── 12e. Publish directly to target channel ─────────────────────
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

    // P1-CE2 fix: record the source→channel message mapping so that a later
    // edit of the source message can edit the channel post in place.
    if (result.messageIds.length > 0 && content.fromId != null) {
      try {
        const { recordPublishedPost } = await import("../storage/repositories/jobs");
        // Resolve the target channel to a numeric chat id for storage.
        // For @username channels, parseChannelIdNum returns 0; store the
        // first published message_id with the resolved channel id (0 is
        // acceptable — the lookup is by source message, not channel).
        const targetChatId = await resolveChannelIdNum(env);
        await recordPublishedPost(
          env,
          content.chatId,
          content.messageId,
          targetChatId,
          result.messageIds[0],
        );
      } catch (e) {
        log("warn", scope, "recordPublishedPost failed (non-fatal)", {
          error: String(e),
        });
      }
    }

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

/**
 * Resolve env.TARGET_CHANNEL to a numeric chat id for storage in
 * published_posts. For @username channels, returns 0 (the mapping lookup
 * is by source message, not channel, so 0 is acceptable as a sentinel).
 * For numeric channel ids (e.g. "-1001234567890"), returns the number.
 */
async function resolveChannelIdNum(env: Env): Promise<number> {
  const t = env.TARGET_CHANNEL?.trim() ?? "";
  if (/^-?\d+$/.test(t)) return Number(t);
  return 0;
}
