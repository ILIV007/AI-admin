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
  const cleaned = cleanContent(content.text);
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
        mode: "rewrite",
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
        const preview = await publisherMod.sendPreview(
          env,
          content.fromId,
          html,
          parts,
          content.media,
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

  // ── 12c. Publish directly to target channel ─────────────────────
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
