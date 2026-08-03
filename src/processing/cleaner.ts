/**
 * src/processing/cleaner.ts
 * -----------------------------------------------------------------------------
 * Idempotent content cleaner. Ports + improves V1's cleaner (the best part of
 * V1) with stricter guarantees:
 *
 *   • Code blocks (``` ... ```), inline code, and URLs are extracted to NUL
 *     placeholders BEFORE any text-level cleaning, so they survive every pass
 *     untouched. Placeholders contain no spaces, so whitespace normalization
 *     never corrupts them.
 *   • Telegram invite links (t.me/joinchat, t.me/+xxx, t.me/addstickers) are
 *     dropped entirely. All other URLs (github, docs, npm, pypi, arxiv,
 *     huggingface, etc.) are preserved verbatim.
 *   • "via @user", "source: @user", "@user | desc" signature lines, standalone
 *     promo @mention lines, "Join/Follow/Subscribe" lines and "for more: @chan"
 *     lines are removed. The channel's own handle is NEVER stripped (pass it
 *     via opts.ownHandle).
 *   • Spam hashtag blocks (5+ consecutive) are collapsed to the first 2.
 *   • 3+ consecutive newlines collapse to 2. Output is trimmed.
 *
 * IDEMPOTENT: running cleanContent twice produces the same output. Each regex
 * pass only matches patterns that still exist after the previous pass — none
 * of them produce text that would re-trigger themselves.
 * -----------------------------------------------------------------------------
 */

// NUL is used as a placeholder delimiter because it almost never appears in
// real Telegram message text. We strip any existing NUL chars up-front so a
// malicious or accidental NUL in the input cannot collide with our markers.
const NUL = "\u0000";

// ---------------------------------------------------------------------------
// URL / link patterns
// ---------------------------------------------------------------------------

// URL regex: matches both protocol URLs (https://...) and bare URLs
// (example.com/path, twitter.com/user, etc.). Bare URLs are common in
// social-media signature blocks. We extract them to placeholders so they
// can be protected or removed as a block.
const URL_RE = /(?:https?:\/\/)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s<>"')]*)?/gi;

// Telegram promo URLs (t.me/username without post number) — REMOVED
// Also matches bare t.me/username (without https://)
// const TG_PROMO_LINE_RE = /(?:https?:\/\/)?t\.me\/(?:joinchat|\+|addstickers|addemoji|[A-Za-z0-9_]+)\/?(?!\d)/gi;
// t.me/username/123 = specific post link — KEEP
// const TG_POST_LINK_RE = /(?:https?:\/\/)?t\.me\/[A-Za-z0-9_]+\/\d+/i;

// "source: @user" / "src: @user" / "منبع: @user" — only removes @username attribution
// Does NOT remove "source: https://..." links (those are valuable content)
const SOURCE_ATTR_RE = /\s*(?:source|src|منبع|credit)\s*[:：]\s*@[A-Za-z0-9_]+/gi;

// GitHub URLs (used by contentStats + classifier). Non-global, safe for .test().
const GITHUB_RE = /(?:github\.com|gist\.github\.com|raw\.githubusercontent\.com)/i;

// ---------------------------------------------------------------------------
// Attribution / promo patterns
// ---------------------------------------------------------------------------

// " via @user" / " — via @user" / " - via @user" (anywhere, inline)
const VIA_ATTR_RE = /\s+(?:[—–-]\s+)?via\s+@[A-Za-z0-9_]+/gi;

// " source: @user" / "src: @user" / "منبع: @user"
// const SOURCE_ATTR_RE = /\s*(?:source|src|منبع)\s*[:：]?\s*@[A-Za-z0-9_]+/gi;

// Whole-line signature: "@user | some description"
const SIGNATURE_LINE_RE = /^[ \t]*@[A-Za-z0-9_]+\s*[|｜]\s*.+$/gm;

// Whole-line standalone promo mentions: "@user" or "@user @user2 @user3"
// Also matches lines with emoji prefix + @username (e.g. "🌀 @ILIVIR3")
const STANDALONE_MENTION_LINE_RE =
  /^[ \t]*(?:[\p{Extended_Pictographic}\s]*)?@[A-Za-z0-9_]+(?:\s+@[A-Za-z0-9_]+)*[ \t]*$/gmu;

// Lines with emoji + @username + optional description (e.g. "🌀 @ILIVIR3", "🆔 @ShahrSakhtAfzar")
const EMOJI_MENTION_LINE_RE =
  /^[ \t]*[\p{Extended_Pictographic}]+\s*@[A-Za-z0-9_]+(?:\s*[|｜\-—–]\s*.*)?[ \t]*$/gmu;

// Channel signature BLOCK: a multi-line block at the END of a post that
// contains a @channel mention followed by social/website links. These are
// promo "contact us" blocks that should be removed entirely. Example:
//   @some_channel
//   website: example.com/channel
//   twitter: twitter.com/some
// The block starts with a @mention line and includes subsequent lines that
// are ONLY links/social references (no real content).
// NOTE: URLs are already extracted to \u0000URL{n}\u0000 placeholders by
// the time this regex runs. So we match the placeholder form.
const CHANNEL_SIGNATURE_BLOCK_PLACEHOLDER_RE =
  /(?:\n\s*\n|\n)\s*@[A-Za-z0-9_]+[ \t]*\n(?:(?:[ \t]*(?:website|site|web|twitter|instagram|facebook|telegram|telegram\s+channel|کانال|سایت|وب‌سایت|وبسایت|توییتر|اینستاگرام|تلگرام|🌐|🐦|📷|📘|💬)\s*[:：]?\s*)?[ \t]*\u0000URL\d+\u0000[ \t]*\n?)+/gi;

// Whole-line "Join / Follow / Subscribe" prompts (English + Persian).
// NOTE: "channel" alone is too broad (matches "Channel 7 news" etc.) —
// only match promo patterns: "our channel", "join channel", "channel: @x".
// NOTE: "عضویت" alone means "membership" (common word) — only match the
// full phrase "عضویت در کانال" (membership in channel).
const JOIN_LINE_RE =
  /^[ \t]*(?:please\s+)?(?:join|follow|subscribe|دنبال\s+کنید?|عضو\s+شوید?|عضویت\s+در\s+کانال|کانال\s+ما|join\s+our\s+channel|our\s+channel)[^\n]*$/gim;

// Forwarded message header: "--- forward from @channel ---" or similar.
// Telegram doesn't add these, but users paste forwarded content with these
// headers. Remove them entirely.
const FORWARD_HEADER_RE =
  /^[ \t]*[-—–=*]{2,}\s*(?:forward(?:ed)?\s+from|فوروارد\s+از|از\s+کانال)\s+@?[A-Za-z0-9_]+\s*[-—–=*]{0,}[ \t]*$/gim;

// Whole-line "for more: @chan" / "اطلاعات بیشتر: @chan"
// FIX: only remove the @mention part, NOT URLs on the same line.
// If the line contains a URL, preserve the URL and only strip the @mention.
const FOR_MORE_LINE_RE =
  /^[ \t]*(?:for\s+more|بیشتر|اطلاعات\s+بیشتر|more\s+info|see\s+more|more\s+at)\s*[:：]?\s*@[A-Za-z0-9_]+[ \t]*$/gim;

// Spam hashtag blocks: 5+ consecutive "#tag " tokens
const HASHTAG_SPAM_RE = /(?:#[A-Za-z0-9_]+\s*){5,}/g;

// ---------------------------------------------------------------------------
// Helpers — extract / restore (code blocks, inline code, URLs)
// ---------------------------------------------------------------------------

function stripNul(s: string): string {
  return s.replace(/\u0000/g, "");
}

function extractCodeBlocks(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    blocks.push(m);
    return `${NUL}CB${blocks.length - 1}${NUL}`;
  });
  return { text, blocks };
}

function restoreCodeBlocks(text: string, blocks: string[]): string {
  return text.replace(/\u0000CB(\d+)\u0000/g, (_, i) => blocks[Number(i)] ?? "");
}

function extractInlineCode(text: string): { text: string; codes: string[] } {
  const codes: string[] = [];
  text = text.replace(/`[^`\n]+`/g, (m) => {
    codes.push(m);
    return `${NUL}IC${codes.length - 1}${NUL}`;
  });
  return { text, codes };
}

function restoreInlineCode(text: string, codes: string[]): string {
  return text.replace(/\u0000IC(\d+)\u0000/g, (_, i) => codes[Number(i)] ?? "");
}

function extractUrls(text: string): { text: string; urls: string[] } {
  const urls: string[] = [];
  text = text.replace(URL_RE, (url) => {
    // Remove Telegram INVITE links (joinchat/+//addstickers/addemoji) — these
    // are always promo, regardless of context.
    if (/^https?:\/\/t\.me\/(?:joinchat|\+|addstickers|addemoji)/i.test(url)) {
      return " ";
    }
    // ALL other URLs (including https://t.me/username and t.me/username/123)
    // are KEPT inline. Standalone t.me/username LINES are removed separately
    // BEFORE extraction (see cleanContent) so the rule "only delete standalone
    // lines" applies uniformly to both bare and https:// forms.
    urls.push(url);
    return `${NUL}URL${urls.length - 1}${NUL}`;
  });
  return { text, urls };
}

function restoreUrls(text: string, urls: string[]): string {
  return text.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? "");
}

// ---------------------------------------------------------------------------
// cleanContent — main exported cleaner
// ---------------------------------------------------------------------------

export function cleanContent(
  rawText: string,
  opts?: { ownHandle?: string },
): string {
  if (!rawText) return "";

  let text = stripNul(rawText);

  // Normalize line endings.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Extract code blocks → placeholders (preserve verbatim).
  const cb = extractCodeBlocks(text);
  text = cb.text;

  // Extract inline code → placeholders.
  const ic = extractInlineCode(text);
  text = ic.text;

  // Remove STANDALONE t.me/username lines (both bare and https:// forms).
  // This runs BEFORE extractUrls so both forms are caught uniformly.
  // Inline t.me/username (inside a sentence) is KEPT — only standalone lines
  // are removed. Post links (t.me/username/123) are always kept.
  // CRITICAL: this matches ANY standalone line, not just "at end of post".
  text = text.replace(/^[ \t]*(?:https?:\/\/)?t\.me\/[A-Za-z0-9_]+\/?[ \t]*$/gimu, (match) => {
    if (/\/\d+/.test(match)) return match; // Keep post links (t.me/user/123)
    return "";
  });
  // Remove lines that are just emoji + t.me/username (e.g. "✉️ t.me/username/")
  text = text.replace(/^[ \t]*[\p{Extended_Pictographic}\u2600-\u27BF\uFE0F\s]+t\.me\/[A-Za-z0-9_]+\/?[ \t]*$/gimu, "");
  // Remove leftover standalone emojis on their own line (left after t.me removal)
  text = text.replace(/^[ \t]*[\p{Extended_Pictographic}\u2600-\u27BF\uFE0F]+[ \t]*$/gimu, "");

  // Extract URLs → placeholders (drops invite links; keeps all other URLs
  // including inline t.me/username and t.me/username/123 post links).
  const u = extractUrls(text);
  text = u.text;

  // --- text-level cleaning passes ---

  // CRITICAL FIX (v2.16.7): remove "channel signature blocks" — a @channel
  // mention followed by social/website links at the end of a post. These
  // are promo "contact us" blocks. The URLs are already placeholders now
  // (\u0000URL{n}\u0000), so the regex matches the placeholder form.
  // This runs BEFORE the hasUrlPlaceholder guard so the entire block
  // (including the links) is removed together.
  text = text.replace(CHANNEL_SIGNATURE_BLOCK_PLACEHOLDER_RE, "\n");

  // CRITICAL FIX (v2.15.9): line-removal regexes must NOT delete lines that
  // contain a URL placeholder. extractUrls already converted URLs to
  // \u0000URL{n}\u0000 placeholders. If a regex like SIGNATURE_LINE_RE
  // matches "@user | desc \u0000URL0\u0000" and deletes the whole line,
  // the URL is LOST. We guard every line-removal regex with a check: if
  // the matched line contains a URL placeholder, keep it unchanged.
  const hasUrlPlaceholder = (line: string): boolean =>
    /\u0000URL\d+\u0000/.test(line);

  // "via @user" attribution
  text = text.replace(VIA_ATTR_RE, " ");

  // "source: @user" attribution — only removes @username, NOT URLs
  text = text.replace(SOURCE_ATTR_RE, " ");

  // "@user | desc" signature lines — ALWAYS removed.
  // The hasUrlPlaceholder guard is NOT applied here because a signature line
  // like "@channel | example.com" is ALWAYS promo — the link is part of the
  // signature (channel's website/twitter), not content. Removing the whole
  // line (including the link) is the correct behavior. The user confirmed:
  // "لینک‌های کنار آیدی آخر پست‌ها که مربوط به چنل‌ها هست رو نگه می‌داره"
  // (links next to channel ID at end of posts are being kept — should be removed).
  text = text.replace(SIGNATURE_LINE_RE, "");

  // Emoji + @username lines (e.g. "🌀 @ILIVIR3", "🆔 @ShahrSakhtAfzar")
  // — but NOT if the line contains a URL
  text = text.replace(EMOJI_MENTION_LINE_RE, (match) =>
    hasUrlPlaceholder(match) ? match : "",
  );

  // Standalone promo @mention lines — but never the channel's own handle.
  const ownHandle = opts?.ownHandle?.replace(/^@/, "");
  text = text.replace(STANDALONE_MENTION_LINE_RE, (match) => {
    if (hasUrlPlaceholder(match)) return match; // preserve lines with URLs
    if (ownHandle) {
      const mentions = match.trim().split(/\s+/);
      const allOwn = mentions.every(
        (m) => m.toLowerCase() === "@" + ownHandle.toLowerCase(),
      );
      if (allOwn) return match;
    }
    return "";
  });

  // "Join / Follow / Subscribe" lines — but NOT if the line contains a URL
  text = text.replace(JOIN_LINE_RE, (match) =>
    hasUrlPlaceholder(match) ? match : "",
  );

  // Forwarded message headers ("--- forward from @channel ---")
  // These are always removed (they're never legitimate content).
  text = text.replace(FORWARD_HEADER_RE, "");

  // "for more: @chan" lines — but NOT if the line contains a URL
  text = text.replace(FOR_MORE_LINE_RE, (match) =>
    hasUrlPlaceholder(match) ? match : "",
  );

  // Collapse spam hashtag blocks (5+ → first 2)
  text = text.replace(HASHTAG_SPAM_RE, (match) => {
    const tags = match.trim().split(/\s+/);
    return tags.slice(0, 2).join(" ") + " ";
  });

  // --- restore extracted content ---

  // URLs first (they have no internal spaces, so safe before whitespace pass).
  text = restoreUrls(text, u.urls);

  // Whitespace normalization. Placeholders (CB, IC) contain no spaces, so
  // these regexes cannot corrupt code content.
  text = text.replace(/[ \t]+/g, " "); // collapse runs of spaces/tabs
  text = text.replace(/^[ \t]+|[ \t]+$/gm, ""); // trim each line's edges
  text = text.replace(/\n{3,}/g, "\n\n"); // 3+ newlines → 2

  // Restore inline code (now that whitespace is normalized).
  text = restoreInlineCode(text, ic.codes);

  // Restore code blocks.
  text = restoreCodeBlocks(text, cb.blocks);

  // Final trim.
  return text.trim();
}

// ---------------------------------------------------------------------------
// protectPrompts / restorePrompts
// ---------------------------------------------------------------------------

// Keywords that strongly suggest a paragraph is an image-gen prompt.
// Task 28: expanded with more Midjourney/SD parameters and render engines.
const PROMPT_KEYWORDS = [
  // Midjourney / SD parameters
  "--ar",
  "--v ",
  "--seed",
  "--stylize",
  "--chaos",
  "--niji",
  "--quality",
  "--q ",
  "--tile",
  "--upscale",
  "--bw",
  "--hd",
  "--fast",
  "--relax",
  "--turbo",
  "--style",
  "--weird",
  "--no ",
  // Render engines / styles
  "photorealistic",
  "octane render",
  "unreal engine",
  "ray tracing",
  "raytracing",
  "midjourney",
  "stable diffusion",
  "sdxl",
  "sd1.5",
  "sd 1.5",
  "sd3",
  "sd 3",
  "flux",
  "dalle",
  "dall-e",
  "negative prompt",
  "prompt:",
  "highly detailed",
  "ultra realistic",
  "ultra-realistic",
  "hyperrealistic",
  "hyper-realistic",
  "8k",
  "16k",
  "uhd",
  "4k",
  "cinematic lighting",
  "volumetric lighting",
  "soft lighting",
  "studio lighting",
  "depth of field",
  "bokeh",
  "trending on artstation",
  "trending on cgsociety",
  "trending on behance",
  "sharp focus",
  "intricate details",
  "highly detailed face",
  "masterpiece",
  "best quality",
  "high quality",
];

// Paragraphs that start with one of these prefixes are ALWAYS treated as
// prompts. The prefix must be at the START of the paragraph (optionally
// preceded by whitespace), NOT preceded by other text like "Here is a prompt:".
const PROMPT_PREFIX_RE =
  /^\s*(?:prompt|system|user|instruction|negative\s+prompt)\s*[:：]\s*/i;

function isPromptParagraph(text: string): boolean {
  // Explicit prefix → always a prompt (skip very short false positives).
  if (PROMPT_PREFIX_RE.test(text)) {
    return text.length >= 15;
  }

  // Check if text is a code fence with language "prompt"
  // Format: ```prompt\n...\n``` (already extracted by cleanContent, but
  // protectPrompts runs AFTER cleanContent restores code blocks, so the
  // fence is visible again).
  if (/^```prompt\b/i.test(text.trim())) {
    return true;
  }

  // Must be at least 60 chars to be considered a prompt (shortened from 80)
  if (text.length < 60) return false;

  // English-dominant: more Latin chars than Persian/Arabic.
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const persian = (text.match(/[\u0600-\u06FF]/g) || []).length;
  if (persian > latin) return false;

  // Must contain at least 2 prompt keywords.
  const lower = text.toLowerCase();
  const matchCount = PROMPT_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  if (matchCount < 2) return false;

  // Must contain comma-separated descriptors OR --params OR multiple keywords
  if (!/,/.test(text) && !/--\w+/.test(text)) return false;

  return true;
}

export function protectPrompts(text: string): {
  text: string;
  prompts: string[];
} {
  if (!text) return { text, prompts: [] };

  const prompts: string[] = [];
  // Split on blank-line runs, KEEPING the separators so we can rejoin exactly.
  const parts = text.split(/(\n{2,})/);

  const out = parts
    .map((part) => {
      // Separator chunk — pass through unchanged.
      if (/^\n{2,}$/.test(part)) return part;
      if (!part.trim()) return part;
      if (isPromptParagraph(part)) {
        const idx = prompts.length;
        // Strip ```prompt fence markers if present — the content is stored
        // raw and restorePrompts will wrap it in a fresh fence.
        let promptContent = part.trim();
        const fenceMatch = /^```prompt\b[\s\S]*?\n([\s\S]*)\n```$/.exec(promptContent);
        if (fenceMatch) {
          promptContent = fenceMatch[1];
        }
        prompts.push(promptContent);
        // Use a TEXT-BASED placeholder (not NUL) so it survives AI API
        // round-trips. NUL bytes are stripped by JSON serialization in the
        // Gemini/OpenRouter APIs, leaving "PROMPT_0" as visible text.
        // Unicode angle brackets (U+27E8/U+27E9) are distinctive enough
        // to never appear in normal Telegram message text.
        return `⟨⟨PROMPT_BLOCK_${idx}⟩⟩`;
      }
      return part;
    })
    .join("");

  return { text: out, prompts };
}

export function restorePrompts(text: string, prompts: string[]): string {
  if (!text || prompts.length === 0) return text;
  // Combine ALL prompts into a SINGLE code block (not separate blocks).
  // PRESERVE "prompt:" / "system:" / "instruction:" labels — they are part of
  // the content the user wants to keep. Do NOT strip them.
  // Use ```prompt fence → rendered as <blockquote expandable><pre><code>
  // (collapsible AND copyable monospace).
  const allPrompts = prompts
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p, i) => (prompts.length > 1 ? `--- Prompt ${i + 1} ---\n` : "") + p)
    .join("\n\n");

  if (!allPrompts) return text; // nothing left after cleaning

  // Replace all text-based placeholders with a single combined block.
  // Do NOT add extra \n\n around the block — the placeholder already
  // has the surrounding whitespace from the original text. Adding \n\n
  // creates triple blank lines that break formatting.
  const promptBlock = "```prompt\n" + allPrompts + "\n```";
  let firstReplaced = false;
  const result = text.replace(/⟨⟨\s*PROMPT_BLOCK_(\d+)\s*⟩⟩/g, () => {
    if (!firstReplaced) {
      firstReplaced = true;
      return promptBlock;
    }
    return "";
  });

  // Fallback: if the AI stripped the angle brackets but left "PROMPT_BLOCK_0",
  // catch that too (case-insensitive).
  if (!firstReplaced) {
    const fallback = result.replace(/\bPROMPT_BLOCK_\d+\b/gi, () => {
      if (!firstReplaced) {
        firstReplaced = true;
        return promptBlock;
      }
      return "";
    });
    return fallback;
  }

  // Clean up any triple+ blank lines that may have formed.
  return result.replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------
// detectLanguage
// ---------------------------------------------------------------------------

export function detectLanguage(text: string): "fa" | "en" | "auto" {
  if (!text) return "auto";
  const persian = (
    text.match(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []
  ).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (persian === 0 && latin === 0) return "auto";
  // Require a 1.2x margin to commit; otherwise leave as "auto".
  if (persian > latin * 1.2) return "fa";
  if (latin > persian * 1.2) return "en";
  return "auto";
}

// ---------------------------------------------------------------------------
// contentStats
// ---------------------------------------------------------------------------

export interface ContentStats {
  length: number;
  words: number;
  links: number;
  hasGithub: boolean;
  hasCodeBlock: boolean;
}

export function contentStats(text: string): ContentStats {
  if (!text) {
    return { length: 0, words: 0, links: 0, hasGithub: false, hasCodeBlock: false };
  }
  const links = text.match(URL_RE) || [];
  return {
    length: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    links: links.length,
    hasGithub: GITHUB_RE.test(text),
    hasCodeBlock: /```/.test(text),
  };
}
