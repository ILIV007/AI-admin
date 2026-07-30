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
import { normalizePersianHalfSpaces } from "../formatting/persian-normalizer";
import { chunkHtml } from "../formatting/chunker";
import { truncateVisible, buildInlineKeyboard } from "../telegram/entities";
import { getProfile } from "../config/defaults";
import { isAuthorized, getRole } from "../storage/repositories/admins";
import { fixRtlParagraphs } from "../ai/prompts";
import { rewriteWithFallback } from "../ai/fallback";
import { sendChatAction } from "../telegram/client";
import {
  publishPost,
  sendPreview,
  editChannelPost,
} from "../telegram/publisher";
import { can } from "../domain/roles";
import { recordScheduled } from "../storage/repositories/stats";
import {
  recordPublishedPost,
  getPublishedPost,
  listPendingScheduledForUser,
  createJob,
} from "../storage/repositories/jobs";
import { log } from "../observability/logger";

// ============================================================
// Constants
// ============================================================

// Telegram hard cap is 4096 visible chars. We chunk at 4000 to leave headroom
// for the footer and any entity-expansion surprises.
const CHUNK_MAX_VISIBLE = 4000;

// Telegram caption hard cap is 1024 visible chars. We chunk at 1000 for headroom.
const CAPTION_MAX_VISIBLE = 1000;

// NOTE: There is NO 48-hour edit window for channel posts. Telegram bots can
// edit their OWN channel messages at ANY time. The 48h limit only applies to
// group/supergroup/private messages. We removed the TELEGRAM_EDIT_WINDOW_MS
// constant and the age check in the channel-edit branch (FIX CE-4).

// Max pending scheduled posts per user (prevents unbounded D1 growth).
const MAX_PENDING_SCHEDULED_PER_USER = 50;

// ============================================================
// chunkMixedMedia — two-level chunking for media posts
// ============================================================

/**
 * Chunk HTML for posts that may have media.
 *
 * CRITICAL FIX: when a post has media AND needs multiple parts, the FIRST
 * part is a media caption (1024 char limit) but subsequent parts are
 * text-only messages (4096 char limit). Previously, ALL parts used the
 * caption limit (1000), making text-only parts unnecessarily short —
 * a 4000-char text message was split into 4 pieces of 1000 instead of
 * 1 piece of 4000.
 *
 * This function:
 * 1. If no media → chunk everything at textMax (simple case).
 * 2. If media → first chunk at captionMax to see if it fits in one caption.
 *    a. If 1 part → done (single caption + footer).
 *    b. If multiple parts → first part = caption (at captionMax),
 *       remaining content re-chunked at textMax (much larger) → fewer parts.
 *
 * @param html       Full HTML to chunk (footer already embedded by renderer).
 * @param hasMedia   Whether the post has media (photo/video/document/animation).
 * @param footer     Footer text (passed to chunker so it strips + re-appends).
 * @param captionMax Max visible chars for the caption part (media only).
 * @param textMax    Max visible chars for text-message parts.
 * @returns Array of HTML chunks.
 */
function chunkMixedMedia(
  html: string,
  hasMedia: boolean,
  footer: string,
  captionMax: number,
  textMax: number,
): string[] {
  if (!hasMedia) {
    // No media: all parts are text messages. Simple chunk.
    return chunkHtml(html, textMax, footer);
  }

  // Media: first pass — chunk at caption limit WITHOUT footer to see how
  // many caption-sized parts we'd need.
  const captionParts = chunkHtml(html, captionMax, "");
  if (captionParts.length <= 1) {
    // Fits in a single caption. Re-chunk WITH footer (so footer is appended
    // to the single part).
    return chunkHtml(html, captionMax, footer);
  }

  // Multiple parts needed:
  // - Part 0 = media caption (at captionMax, no footer — publisher adds it)
  // - Parts 1+ = text messages (at textMax, WITH footer on the last one)
  //
  // We take the first caption part as-is, then concatenate the remaining
  // caption parts and re-chunk them at the much larger textMax. This
  // dramatically reduces the number of text parts (e.g. 3×1000 → 1×3000).
  const captionPart = captionParts[0];
  const remainingHtml = captionParts.slice(1).join("\n\n");
  const textParts = chunkHtml(remainingHtml, textMax, footer);
  return [captionPart, ...textParts];
}

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
      // CRITICAL FIX: only strip STANDALONE @channelName lines (where the
      // mention is the ONLY content on the line). Do NOT strip lines that
      // contain @channelName + other content (links, descriptions, etc).
      // The old regex [^\n]* ate the entire line including any links.
      const channelRegex = new RegExp(
        `(^|\\n)[\\s\\p{Extended_Pictographic}]*@${channelName}\\s*(?:[|｜\\-—–]\\s*.*)?[ \\t]*(?=\\n|$)`,
        "gu",
      );
      inputText = inputText.replace(channelRegex, "").trim();
      // Also remove inline @channelName (not at start of line) — just the mention, keep the rest
      inputText = inputText.replace(new RegExp(`\\s*@${channelName}\\b`, "g"), "").trim();
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
  // FIX: for "normal" rewriteMode with editIntensity > 0, always use AI.
  // Previously, if the classifier said "no rewrite needed" AND mode was "normal",
  // AI was skipped — even if the user wanted formatting improvements.
  //
  // CRITICAL: if the post has NO text (media-only, e.g. a photo with no caption),
  // do NOT use AI — there's nothing to rewrite. Use format-only mode instead.
  // The publisher handles empty captions correctly (sends media without caption).
  let useAi = false;
  const canUseAi = isAdmin && (role === "owner" || role === "editor");
  const hasText = workingText.trim().length > 0;
  if (settings.rewriteMode !== "none" && canUseAi && hasText) {
    if (settings.rewriteMode !== "normal") {
      // light/aggressive/summarize → always use AI
      useAi = true;
    } else if (classification.recommendedNeedsRewrite) {
      // normal mode + classifier says rewrite needed
      useAi = true;
    } else if (settings.editIntensity > 0) {
      // normal mode + user wants edits → use AI for formatting
      useAi = true;
    }
  }
  if (useAi && !hasText) {
    log("info", scope, "no text content (media-only); skipping AI, using format-only");
    useAi = false;
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
        await sendChatAction(env.BOT_TOKEN, {
          chat_id: content.fromId,
          action: "typing",
        });
      } catch { /* ignore */ }
    }
    try {
      const profile = getProfile(settings.profile);
      const aiReq: AIRequest = {
        text: workingText,
        classification,
        settings,
        profile,
        mode: settings.rewriteMode === "summarize" ? "summarize" : "rewrite",
      };
      const ai: AIResult = await rewriteWithFallback(env, aiReq);

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
  // CRITICAL FIX: only strip lines that are JUST @channelName (with optional
  // emoji/space prefix), NOT lines that contain @channelName AND other content
  // like links. The old regex [^\n]* would eat the entire line including
  // any links on it.
  if (settings.footerText) {
    const chMatch = settings.footerText.match(/@([A-Za-z0-9_]+)/);
    if (chMatch) {
      const chName = chMatch[1];
      // Only remove lines where @channelName is the ONLY content (standalone mention lines).
      // Do NOT remove lines that have @channelName + other text (e.g. links, descriptions).
      const chRegex = new RegExp(
        `(^|\\n)[\\s\\p{Extended_Pictographic}]*@${chName}\\s*(?:[|｜\\-—–]\\s*.*)?[ \\t]*(?=\\n|$)`,
        "gu",
      );
      finalText = finalText.replace(chRegex, "").trim();
      // Also remove inline @channelName (not at start of line) — just remove the mention, keep the rest
      finalText = finalText.replace(new RegExp(`\\s*@${chName}\\b`, "g"), "").trim();
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

  // ── 8c. Normalize Persian half-spaces (نیم‌فاصله, U+200C).
  //      Even with explicit AI instructions, models frequently forget to
  //      insert half-spaces in compound words (بهروزرسانی instead of به‌روزرسانی).
  //      This deterministic post-processor catches and fixes common misses.
  //      Code fences, inline code, and links are protected internally.
  finalText = normalizePersianHalfSpaces(finalText);

  // ── 9. Markdown → blocks ────────────────────────────────────────
  const blocks = markdownToBlocks(finalText);

  // ── 10. Blocks → Telegram HTML (footer escaped inside renderer) ─
  const html = blocksToTelegramHtml(blocks, settings.footerText);

  // ── 11. Chunk by visible length ──────
  // CRITICAL FIX: when a post has media AND needs multiple parts, the FIRST
  // part is a media caption (1024 char limit) but subsequent parts are
  // text-only messages (4096 char limit). Using the caption limit for ALL
  // parts made text-only parts unnecessarily short. chunkMixedMedia handles
  // this by chunking the caption at 1000 and the rest at 4000.
  const hasMedia = !!content.media;
  let parts = chunkMixedMedia(
    html,
    hasMedia,
    settings.footerText,
    CAPTION_MAX_VISIBLE,
    CHUNK_MAX_VISIBLE,
  );

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
      const summaryResult = await rewriteWithFallback(env, summarizeReq);
      if (summaryResult?.ok && summaryResult?.text) {
        // CRITICAL: if the AI stripped the prompt placeholder during
        // summarization, the prompt content would be LOST. Check if any
        // placeholder survived. If not, re-insert the prompt block at
        // the end of the summarized text.
        let summaryText = summaryResult.text;
        if (hasPrompts) {
          const hasPlaceholder = /⟨⟨\s*PROMPT_BLOCK_\d+\s*⟩⟩/i.test(summaryText) ||
                                /\bPROMPT_BLOCK_\d+\b/i.test(summaryText);
          if (!hasPlaceholder) {
            // AI removed the placeholder — re-insert the prompt block.
            const allPrompts = prompts
              .map((p) => p.trim())
              .filter((p) => p.length > 0)
              .map((p, i) => (prompts.length > 1 ? `--- Prompt ${i + 1} ---\n` : "") + p)
              .join("\n\n");
            if (allPrompts) {
              summaryText = summaryText.trim() + "\n\n```prompt\n" + allPrompts + "\n```";
              log("info", scope, "prompt placeholder lost in summarize; re-inserted", { prompts: prompts.length });
            }
          }
        }
        // Restore prompts (handles both cases: placeholder survived or re-inserted above)
        summaryText = restorePrompts(summaryText, prompts);
        const summaryBlocks = markdownToBlocks(summaryText);
        const summaryHtml = blocksToTelegramHtml(summaryBlocks, settings.footerText);
        const newParts = chunkMixedMedia(summaryHtml, hasMedia, settings.footerText, CAPTION_MAX_VISIBLE, CHUNK_MAX_VISIBLE);
        if (newParts.length < parts.length) {
          log("info", scope, "summarize reduced parts", { before: parts.length, after: newParts.length });
          parts = newParts;
          bestHtml = summaryHtml;
          finalText = summaryText;
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
        const ultraResult = await rewriteWithFallback(env, ultraReq);
        if (ultraResult?.ok && ultraResult?.text) {
          const ultraBlocks = markdownToBlocks(ultraResult.text);
          const ultraHtml = blocksToTelegramHtml(ultraBlocks, settings.footerText);
          const ultraParts = chunkMixedMedia(ultraHtml, hasMedia, settings.footerText, CAPTION_MAX_VISIBLE, CHUNK_MAX_VISIBLE);
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
      // Hard cap to the appropriate limit (minus footer room) so we never
      // exceed Telegram's caption limit (1024 for media) or message limit
      // (4096 for text). truncateVisible keeps HTML tags balanced.
      const forceMax = hasMedia ? CAPTION_MAX_VISIBLE : CHUNK_MAX_VISIBLE;
      const footerRoom = footerBlock ? footerBlock.length + 2 : 0; // +2 for "\n"
      const cap = forceMax - footerRoom;
      let single = parts[0];
      // Only truncate if it exceeds the cap.
      // truncateVisible is now a static import.
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
      // CRITICAL FIX: use chunkMixedMedia so the caption part uses 850
      // (1000-150) and text parts use 3850 (4000-150), not 850 for ALL.
      const replyRoom = 150; // room for footer + page number on each part
      parts = chunkMixedMedia(
        bestHtml,
        hasMedia,
        settings.footerText,
        CAPTION_MAX_VISIBLE - replyRoom,
        CHUNK_MAX_VISIBLE - replyRoom,
      );
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
      if (sendPreview && content.fromId != null) {
        // Build approval keyboard with Publish/Reject buttons
        let approvalKb: string | undefined;
        if (jobId) {
          try {
            const { approvalKeyboard } = await import("../admin/keyboards");
            approvalKb = approvalKeyboard(jobId);
          } catch { /* ignore */ }
        }
        const preview = await sendPreview(
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
      const schedulerMod: {
        computeNextScheduledTime: (
          now: number,
          pendingScheduledFors: number[],
          slotsPerDay: number,
          startHour?: number,
        ) => number;
      } = await import("./scheduler");

      if (!listPendingScheduledForUser || !createJob) {
        throw new Error("jobs repo missing required exports");
      }
      if (!schedulerMod.computeNextScheduledTime) {
        throw new Error("scheduler module missing computeNextScheduledTime");
      }

      const pending = await listPendingScheduledForUser(
        env,
        content.fromId,
        200,
      );
      const pendingFors = pending
        .map((p) => p.scheduledFor)
        .filter((t): t is number => typeof t === "number" && Number.isFinite(t));

      // P1-SS6 fix: queue depth limit — max 50 pending scheduled posts per user.
      // Prevents unbounded D1 growth + accidental spam-scheduling.
      
      if (pendingFors.length >= MAX_PENDING_SCHEDULED_PER_USER) {
        log("warn", scope, "schedule queue depth limit reached", {
          pending: pendingFors.length,
          limit: MAX_PENDING_SCHEDULED_PER_USER,
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
          errorMessage: `Too many pending scheduled posts (max ${MAX_PENDING_SCHEDULED_PER_USER}). Wait for some to publish or cancel existing ones.`,
        };
      }

      // Defensive: fall back to defaults if the settings row is malformed.
      const perDay =
        Number.isFinite(settings.scheduleMessagesPerDay) &&
        settings.scheduleMessagesPerDay! >= 1
          ? settings.scheduleMessagesPerDay!
          : 4;
      // FIX SC-3: use scheduleStartHour (Tehran) instead of intervalHours.
      // The new scheduler divides the day into `perDay` equal slots starting
      // at startHour. intervalHours is kept for backward compat but no
      // longer drives scheduling.
      const startHour =
        Number.isFinite(settings.scheduleStartHour) &&
        settings.scheduleStartHour! >= 0 &&
        settings.scheduleStartHour! <= 23
          ? settings.scheduleStartHour!
          : 9;

      const scheduledFor = schedulerMod.computeNextScheduledTime(
        Date.now(),
        pendingFors,
        perDay,
        startHour,
      );

      // P1-SS3 fix: store parts WITHOUT footer in the payload. The cron
      // appends the footer at publish time. This prevents double-footer if
      // the cron ever reconstructs HTML from `html` + appends footer.
      // P2-SS8 fix: also store AI metadata so the cron can report which
      // model processed the post.
      const partsNoFooter = chunkMixedMedia(html, hasMedia, "", CAPTION_MAX_VISIBLE, CHUNK_MAX_VISIBLE);
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
      const jobId = await createJob(env, {
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
        startHour,
        pendingCount: pendingFors.length,
      });

      // P1-SS2 fix: record the "scheduled" stat so the admin dashboard
      // counter reflects scheduled posts.
      try {
        await recordScheduled(env, content.fromId);
      } catch { /* best effort */ }

      // P1-SS4 fix: show the scheduled time in the admin preview message.
      try {
        if (sendPreview && content.fromId != null) {
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
          await sendPreview(
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
  // NOTE: Telegram bots can edit their OWN channel posts at ANY time — there
  // is NO 48h limit for channel messages. The 48h limit only applies to
  // group/supergroup/private messages. So we removed the age check.
  if (
    settings.channelEditing &&
    isAdmin &&
    content.isEdit &&
    can(role, "edit_channel")
  ) {
    try {
      if (getPublishedPost && content.fromId != null) {
        const mapping = await getPublishedPost(
          env,
          content.chatId,
          content.messageId,
        );
        if (mapping) {
          if (editChannelPost) {
            // FIX CE-5: For multi-part posts we can only edit the FIRST
            // channel message (we only stored its message_id). Use the FULL
            // html truncated to 4096 visible chars so the edit contains as
            // much content as possible rather than just parts[0].
            const { truncateVisible } = await import("../telegram/entities");
            const editHtml = truncateVisible(html, 4096);
            // FIX CE-2: mapping.publishedChatId is now a STRING (TEXT column)
            // so it can be "@ILIVIR3" or "-100xxx". editChannelPost accepts
            // number | string. No fallback to env.TARGET_CHANNEL needed —
            // the stored value is already the correct chat identifier.
            const editChatId = mapping.publishedChatId || env.TARGET_CHANNEL;
            log("info", scope, "editing channel post in place", {
              channelMsgId: mapping.publishedMessageId,
              hasMedia: !!content.media,
              chatIdIsString: typeof editChatId === "string",
              htmlLen: editHtml.length,
            });
            const editResult = await editChannelPost(
              env,
              editChatId,
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
    } catch (e) {
      log("warn", scope, "channel edit branch threw; falling back to publish", {
        error: String(e),
      });
    }
  }

  // ── 12e. Publish directly to target channel ─────────────────────
  try {
    if (!publishPost) {
      throw new Error("publisher.publishPost not available");
    }
    const result = await publishPost(env, html, parts, content.media);
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
    // FIX CE-6: if this fails, the admin must be warned (channel editing
    // will NOT work for this post). We still don't block the publish.
    if (result.messageIds.length > 0 && content.fromId != null) {
      try {
        // FIX CE-2: store the channel identifier as a STRING. For @username
        // channels this is "@ILIVIR3"; for numeric channels it's
        // "-1001234567890". Both are valid chat_id values for the edit API.
        const targetChatId = resolveChannelId(env);
        await recordPublishedPost(
          env,
          content.chatId,
          content.messageId,
          targetChatId,
          result.messageIds[0],
        );
      } catch (e) {
        log("error", scope, "recordPublishedPost FAILED — channel edit will NOT work for this post", {
          error: String(e),
        });
        // Notify the admin so they know channel editing won't work.
        // Best-effort; never blocks the publish.
        try {
          const { notifyAdmin } = await import("../observability/notify");
          await notifyAdmin(
            env,
            "⚠️ <b>Channel Edit Warning</b>\n\n" +
            "Failed to save the post mapping (source → channel message). " +
            "Channel editing will NOT work for this post — if you edit your " +
            "source message, a new channel post will be created instead of " +
            "editing the existing one.\n\n" +
            "Error: <code>" + escapeHtmlSimple(String(e)) + "</code>\n\n" +
            "Fix: run <code>/Admi-bug</code> → Init Schema to ensure the " +
            "<code>published_posts</code> table exists.",
          );
        } catch { /* ignore notification failure */ }
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
 * Resolve env.TARGET_CHANNEL to the channel identifier string for storage in
 * published_posts. Returns the value as-is: either a @username ("@ILIVIR3")
 * or a numeric id ("-1001234567890"). Both are valid chat_id values for the
 * Telegram Bot API's editMessageText / editMessageCaption methods.
 *
 * FIX CE-2: previously this returned a NUMBER (0 for @username), which made
 * editChannelPost send chat_id: 0 → 400 error. Now we store the string so
 * the edit path can pass it directly.
 */
function resolveChannelId(env: Env): string {
  return env.TARGET_CHANNEL?.trim() ?? "";
}

/** Minimal HTML escaper for inline error messages in notifyAdmin. */
function escapeHtmlSimple(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
