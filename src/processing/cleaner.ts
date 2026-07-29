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

const URL_RE = /https?:\/\/[^\s<>"')]+/gi;

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

// Whole-line "Join / Follow / Subscribe" prompts (English + Persian)
const JOIN_LINE_RE =
  /^[ \t]*(?:please\s+)?(?:join|follow|subscribe|دنبال\s+کنید?|عضو\s+شوید?|عضویت)\b[^\n]*$/gim;

// Whole-line "for more: @chan" / "اطلاعات بیشتر: @chan"
const FOR_MORE_LINE_RE =
  /^[ \t]*(?:for\s+more|بیشتر|اطلاعات\s+بیشتر|more\s+info|see\s+more|more\s+at)\s*[:：]?\s*@[A-Za-z0-9_]+[^\n]*$/gim;

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
    // Only remove Telegram INVITE links (joinchat, +xxx, addstickers, addemoji)
    // These are ALWAYS promo — never legitimate content.
    if (/^https?:\/\/t\.me\/(?:joinchat|\+|addstickers|addemoji)/i.test(url)) {
      return " ";
    }
    // ALL other URLs (including t.me/username and t.me/username/123) are KEPT.
    // t.me/username removal is handled separately (only at bottom of post as attribution).
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

  // Extract URLs → placeholders (also drops Telegram invite links).
  const u = extractUrls(text);
  text = u.text;

  // --- text-level cleaning passes ---

  // "via @user" attribution
  text = text.replace(VIA_ATTR_RE, " ");

  // "source: @user" attribution — only removes @username, NOT URLs
  text = text.replace(SOURCE_ATTR_RE, " ");

  // "@user | desc" signature lines
  text = text.replace(SIGNATURE_LINE_RE, "");

  // Emoji + @username lines (e.g. "🌀 @ILIVIR3", "🆔 @ShahrSakhtAfzar")
  text = text.replace(EMOJI_MENTION_LINE_RE, "");

  // Standalone promo @mention lines — but never the channel's own handle.
  const ownHandle = opts?.ownHandle?.replace(/^@/, "");
  text = text.replace(STANDALONE_MENTION_LINE_RE, (match) => {
    if (ownHandle) {
      const mentions = match.trim().split(/\s+/);
      const allOwn = mentions.every(
        (m) => m.toLowerCase() === "@" + ownHandle.toLowerCase(),
      );
      if (allOwn) return match;
    }
    return "";
  });

  // "Join / Follow / Subscribe" lines
  text = text.replace(JOIN_LINE_RE, "");

  // "for more: @chan" lines
  text = text.replace(FOR_MORE_LINE_RE, "");

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
        prompts.push(part);
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
  // Regex matches: ⟨⟨PROMPT_BLOCK_0⟩⟩ (with optional whitespace from AI).
  let firstReplaced = false;
  const result = text.replace(/⟨⟨\s*PROMPT_BLOCK_(\d+)\s*⟩⟩/g, () => {
    if (!firstReplaced) {
      firstReplaced = true;
      return "\n\n```prompt\n" + allPrompts + "\n```\n\n";
    }
    return "";
  });

  // Fallback: if the AI stripped the angle brackets but left "PROMPT_BLOCK_0",
  // catch that too (case-insensitive, with optional surrounding whitespace).
  if (!firstReplaced) {
    const fallback = result.replace(/\bPROMPT_BLOCK_\d+\b/gi, () => {
      if (!firstReplaced) {
        firstReplaced = true;
        return "\n\n```prompt\n" + allPrompts + "\n```\n\n";
      }
      return "";
    });
    return fallback;
  }

  return result;
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
