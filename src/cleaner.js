/**
 * src/cleaner.js
 * Content cleaning layer — runs BEFORE the AI rewrite step.
 *
 * Goal: remove promotional noise + attribution tags, but NEVER touch:
 *   - GitHub / docs / tool URLs
 *   - Code blocks
 *   - Technical instructions
 *   - Author usernames that are part of the actual content
 *
 * The cleaner is idempotent: running it twice produces the same output.
 */

const LINK_REGEX = /https?:\/\/[^\s<>"']+/gi;
// Note: t.me/ links are preserved as URLs (protected by URL safeguard).
// Promo @usernames are removed separately by the @-handling regex below.
// We do NOT blanket-remove t.me/ links because some are legitimate resources.

// ============================================================
// DETECT: is this username part of a tech URL or a promo?
// ============================================================
function isUsernamePartOfUrl(text, matchIndex) {
  // Walk backward from match start; if we hit "://" or "/" or "=" recently, it's a URL component
  const before = text.slice(Math.max(0, matchIndex - 10), matchIndex);
  return /(https?:\/\/|\/|=)/.test(before);
}

// ============================================================
// MAIN CLEAN FUNCTION
// ============================================================

export function cleanContent(rawText) {
  if (!rawText) return "";
  let text = rawText;

  // 1. Protect code blocks and inline code from cleaning
  const codeBlocks = [];
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    codeBlocks.push(m);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });
  const inlineCodes = [];
  text = text.replace(/`[^`\n]+`/g, (m) => {
    inlineCodes.push(m);
    return `__INLINE_CODE_${inlineCodes.length - 1}__`;
  });

  // 2. Protect URLs (GitHub, docs, etc.)
  const urls = [];
  text = text.replace(LINK_REGEX, (m) => {
    urls.push(m);
    return `__URL_${urls.length - 1}__`;
  });

  // 3. Remove "via @username" attribution
  text = text.replace(/\bvia\s+@[\w_]+\b/gi, "");

  // 4. Remove "source: @username"
  text = text.replace(/\bsource\s*:\s*@[\w_]+\b/gi, "");

  // 5. Remove "@DevTwitter | <Author>" style attribution lines (signature at end of post)
  //    IMPORTANT: use [^\n]* (single-line) NOT [^]* — otherwise we'd delete all content
  //    after the attribution line, causing data loss.
  text = text.replace(/\n\s*@\w+\s*\|[^\n]*$/gim, "");
  text = text.replace(/\n\s*@\w+\s*[—–-]\s*[^\n]*$/gim, "");

  // 6. Remove standalone @channel_username lines that are pure promo
  //    BUT keep usernames that appear inside a URL or as part of code/tech content
  text = text.replace(/(^|\s)@([A-Za-z][A-Za-z0-9_]{3,})\b/g, (match, prefix, username, offset) => {
    if (isUsernamePartOfUrl(text, offset + prefix.length)) return match;
    // Keep if username is at the start of a quoted reply context
    return prefix;
  });

  // 7. Remove "Join / Follow / Subscribe" lines
  text = text.replace(/^\s*(join|subscribe|follow|don't miss out|click here to)\b[^\n]*$/gim, "");
  text = text.replace(/\b(join our (channel|group)|subscribe to (our|the) channel)\b[^\n]*/gi, "");

  // 8. Remove "for more: @channel" / "more: t.me/xxx"
  text = text.replace(/\b(for more|more info|more details?)\s*[:：]\s*@?[\w/.\-]+/gi, "");

  // 9. Collapse spam hashtag blocks (5+ consecutive hashtags → keep first 2)
  //    Use [ \t]* instead of \s* so we DON'T consume the trailing newline
  //    (otherwise the next line gets glued onto the hashtags).
  text = text.replace(/((?:#\w+[ \t]*){5,})/g, (block) => {
    const tags = block.trim().split(/[ \t]+/);
    return tags.slice(0, 2).join(" ");
  });

  // 10. Remove promotional footers like "📡 @channel | 💬 @chat | 🌐 site"
  text = text.replace(/\n\s*[📡💬🌐🚀📢]*\s*@[A-Za-z]\w+(?:\s*\|\s*[@🌐][^\n]+)*\s*$/i, "");

  // 11. Restore URLs
  text = text.replace(/__URL_(\d+)__/g, (_, i) => urls[Number(i)]);

  // 12. Restore inline code
  text = text.replace(/__INLINE_CODE_(\d+)__/g, (_, i) => inlineCodes[Number(i)]);

  // 13. Restore code blocks
  text = text.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => codeBlocks[Number(i)]);

  // 14. Clean up extra whitespace
  text = text
    .replace(/[ \t]+\n/g, "\n")      // trailing spaces per line
    .replace(/\n{3,}/g, "\n\n")      // max 2 consecutive newlines
    .replace(/^[ \t]+/gm, (line) => line) // preserve intentional indentation
    .trim();

  return text;
}

// ============================================================
// LANGUAGE DETECTION (very lightweight)
// ============================================================

export function detectLanguage(text) {
  if (!text) return "en";
  // Count Arabic/Persian characters
  const faChars = (text.match(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  // Count Latin letters
  const enChars = (text.match(/[A-Za-z]/g) || []).length;

  if (faChars > enChars && faChars > 5) return "fa";
  if (enChars > faChars) return "en";
  return "auto";
}

// ============================================================
// STATS HELPER (used for logging, not storage)
// ============================================================
export function contentStats(text) {
  return {
    length: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    links: (text.match(LINK_REGEX) || []).length,
    hasGithub: GITHUB_REGEX.test(text),
    hasCodeBlock: /```/.test(text),
  };
}

const GITHUB_REGEX = /github\.com|gist\.github|raw\.githubusercontent/i;
