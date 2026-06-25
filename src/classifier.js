/**
 * src/classifier.js
 * Content type detection + rewrite-mode decision.
 *
 * Two layers:
 *   1. Lightweight rule-based pre-classifier (instant, no AI cost)
 *   2. AI-based classifier (more accurate, costs tokens)
 *
 * Strategy: try AI first; on failure, fall back to rule-based.
 * This guarantees the pipeline NEVER blocks on classification.
 */

// ============================================================
// RULE-BASED FALLBACK CLASSIFIER
// ============================================================

const LINK_REGEX = /https?:\/\/[^\s<>"']+/gi;
const GITHUB_REGEX = /github\.com|gist\.github|raw\.githubusercontent/i;
const DOCS_REGEX = /docs?\.|documentation|readthedocs|\.dev\/docs|wiki\./i;
const HASHTAG_SPAM_REGEX = /(?:#\w+\s*){5,}/; // 5+ consecutive hashtags = spam
const AD_KEYWORDS = /\b(join|subscribe|follow|don't miss|limited time|click here|buy now|order now| DM |direct message)\b/i;
const ATTRIBUTION_REGEX = /via\s+@\w+|@DevTwitter|\|\s*@?\w+\s*$|source:\s*@\w+/i;

export function ruleBasedClassify(text) {
  if (!text || !text.trim()) {
    return { content_type: "other", rewrite_mode: "none", needs_rewrite: false };
  }

  const links = text.match(LINK_REGEX) || [];
  const wordCount = text.trim().split(/\s+/).length;
  const lines = text.split("\n").filter((l) => l.trim());

  // Detect content type — ORDER MATTERS: most specific first
  // (e.g. a list of GitHub URLs is "list_resources", not "github_repo")
  let content_type = "other";

  const isLinkDump = links.length >= 3 && lines.length >= 3 && wordCount / links.length < 8;

  if (isLinkDump) {
    content_type = "list_resources";
  } else if (GITHUB_REGEX.test(text)) {
    content_type = "github_repo";
  } else if (/tutorial|how to|guide|step\s*\d|آموزش|راهنما/i.test(text)) {
    content_type = "tutorial";
  } else if (DOCS_REGEX.test(text)) {
    content_type = "tool";
  } else if (/\bAI\b|GPT|LLM|model|neural|machine learning|یادگیری ماشین|هوش مصنوعی/i.test(text)) {
    content_type = "ai_update";
  } else if (/\bbreaking|update|released|launches|announces|منتشر شد|معرفی شد/i.test(text)) {
    content_type = "news";
  } else if (HASHTAG_SPAM_REGEX.test(text) || AD_KEYWORDS.test(text)) {
    content_type = "other"; // spam-ish
  }

  // Decide rewrite mode
  let rewrite_mode = "light";
  let needs_rewrite = true;

  if (content_type === "list_resources") {
    rewrite_mode = "none";
    needs_rewrite = false;
  } else if (content_type === "tutorial" || content_type === "github_repo") {
    rewrite_mode = "light";
    needs_rewrite = true;
  } else if (content_type === "news") {
    rewrite_mode = "normal";
    needs_rewrite = true;
  } else if (wordCount > 500) {
    rewrite_mode = "summary";
    needs_rewrite = true;
  } else if (HASHTAG_SPAM_REGEX.test(text) || ATTRIBUTION_REGEX.test(text) || AD_KEYWORDS.test(text)) {
    rewrite_mode = "normal";
    needs_rewrite = true;
  }

  return { content_type, rewrite_mode, needs_rewrite };
}

// ============================================================
// MAIN CLASSIFY ENTRYPOINT
// ============================================================

/**
 * FAST rule-based classify only.
 *
 * Why no AI classify? Cloudflare Workers free tier has a 30-second wall time limit.
 * AI classify calls Gemini (often 429) then OpenRouter fallback = up to 24 seconds.
 * Combined with AI rewrite, the pipeline exceeds 30s and Cloudflare kills the worker
 * mid-flight — leaving the "processing" message stuck forever.
 *
 * The rule-based classifier is instant (<1ms) and produces good results for the
 * common content types. AI classify was a nice-to-have but is not worth the risk.
 *
 * Always returns { ok, decision, source: "rules" }
 */
export async function classify(env, settings, text) {
  const decision = ruleBasedClassify(text);

  // Respect admin's forced language mode
  if (settings.language_mode && settings.language_mode !== "auto") {
    decision.language_mode = settings.language_mode;
  }

  return { ok: true, source: "rules", decision };
}
