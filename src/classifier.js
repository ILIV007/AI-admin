/**
 * src/classifier.js
 * Content type detection + rewrite-mode decision — v0.5.0
 *
 * Fixes:
 *   - language_mode properly passed to decision
 *   - Better integration with settings
 *   - More accurate content type detection
 */

const LINK_REGEX = /https?:\/\/[^\s<>"']+/gi;
const GITHUB_REGEX = /github\.com|gist\.github|raw\.githubusercontent/i;
const DOCS_REGEX = /docs?\.|documentation|readthedocs|\.dev\/docs|wiki\./i;
const HASHTAG_SPAM_REGEX = /(?:#\w+\s*){5,}/;
const AD_KEYWORDS = /\b(join|subscribe|follow|don't miss|limited time|click here|buy now|order now| DM |direct message)\b/i;
const ATTRIBUTION_REGEX = /via\s+@\w+|@DevTwitter|\|\s*@?\w+\s*$|source:\s*@\w+/i;

export function ruleBasedClassify(text) {
  if (!text || !text.trim()) {
    return { content_type: "other", rewrite_mode: "none", needs_rewrite: false };
  }

  const links = text.match(LINK_REGEX) || [];
  const wordCount = text.trim().split(/\s+/).length;
  const lines = text.split("\n").filter((l) => l.trim());

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
    content_type = "other";
  }

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
export async function classify(env, settings, text) {
  // Skip AI for very short text
  if (!text || text.length < 60) {
    const decision = ruleBasedClassify(text);
    // Respect admin's forced settings
    if (settings.rewrite_mode && settings.rewrite_mode !== "normal") {
      decision.rewrite_mode = settings.rewrite_mode;
      decision.needs_rewrite = settings.rewrite_mode !== "none";
    }
    // v0.5.0: Properly include language_mode in decision
    if (settings.language_mode && settings.language_mode !== "auto") {
      decision.language_mode = settings.language_mode;
    }
    return { ok: true, source: "rules", decision };
  }

  // Try AI classification
  const aiRes = await aiClassifySafe(env, settings, text);
  if (aiRes.ok) {
    const decision = { ...aiRes.decision };
    // Override with admin's forced settings
    if (settings.language_mode && settings.language_mode !== "auto") {
      decision.language_mode = settings.language_mode;
    }
    if (settings.rewrite_mode && settings.rewrite_mode !== "normal") {
      decision.rewrite_mode = settings.rewrite_mode;
      decision.needs_rewrite = settings.rewrite_mode !== "none";
    }
    return { ok: true, source: "ai", decision };
  }

  // Fallback to rules
  console.warn(`[classifier] AI failed (${aiRes.error}); using rules`);
  const decision = ruleBasedClassify(text);
  if (settings.language_mode && settings.language_mode !== "auto") {
    decision.language_mode = settings.language_mode;
  }
  if (settings.rewrite_mode && settings.rewrite_mode !== "normal") {
    decision.rewrite_mode = settings.rewrite_mode;
    decision.needs_rewrite = settings.rewrite_mode !== "none";
  }
  return { ok: true, source: "rules", decision, aiError: aiRes.error };
}

async function aiClassifySafe(env, settings, text) {
  try {
    const { aiClassify } = await import("./ai.js");
    return await aiClassify(env, settings, text);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
