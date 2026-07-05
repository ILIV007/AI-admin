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

// Patterns for spam/promo links that should be removed (but NOT technical links)
const SPAM_LINK_PATTERNS = [
  /https?:\/\/t\.me\/(?:joinchat|\/+joinchat)\S*/gi,  // Telegram invite links
  /https?:\/\/t\.me\/\+\S*/gi,                          // Telegram invite links (new format)
  /https?:\/\/t\.me\/(?:addstickers|addemoji)\S*/gi,   // Telegram sticker/emoji packs (usually promo)
];

// Patterns for links to KEEP (never remove — these are technical resources)
const TECH_LINK_PATTERNS = [
  /github\.com/i,
  /gist\.github/i,
  /raw\.githubusercontent/i,
  /gitlab\.com/i,
  /bitbucket\.org/i,
  /docs?\.\w+/i,
  /readthedocs/i,
  /stack?overflow/i,
  /developer\.\w+/i,
  /npmjs\.com/i,
  /pypi\.org/i,
  /crates\.io/i,
  /hub\.docker\.com/i,
  /wikipedia\.org/i,
  /arxiv\.org/i,
  /huggingface\.co/i,
];

function isSpamLink(url) {
  // Check if URL matches spam patterns
  for (const pat of SPAM_LINK_PATTERNS) {
    if (pat.test(url)) return true;
  }
  return false;
}

function isTechLink(url) {
  for (const pat of TECH_LINK_PATTERNS) {
    if (pat.test(url)) return true;
  }
  return false;
}

// ============================================================
// DETECT: is this username part of a tech URL or a promo?
// ============================================================
function isUsernamePartOfUrl(text, matchIndex) {
  // Walk backward from match start; if we hit "://" or "/" or "=" recently, it's a URL component
  const before = text.slice(Math.max(0, matchIndex - 10), matchIndex);
  return /(https?:\/\/|\/|=)/.test(before);
}

// ============================================================
// v0.6.2: PROMPT PROTECTION (using Persian word "پرامپت")
// ============================================================
// Detects paragraphs that follow the Persian word "پرامپت" (prompt)
// and protects English-dominant paragraphs from cleaning.
//
// Algorithm:
//   1. Find all occurrences of "پرامپت" in the text
//   2. For each occurrence, look at the paragraphs that come AFTER it
//      (within 1-2 paragraphs)
//   3. If those paragraphs are English-dominant and >80 chars, protect them
//
// This helps detect prompts in posts like:
//   "از این پرامپت استفاده کنید:
//    Character reference sheet, 4-panel grid layout..."
// ============================================================

function isEnglishDominant(text) {
  if (!text) return false;
  const enChars = (text.match(/[A-Za-z]/g) || []).length;
  const faChars = (text.match(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  return enChars > faChars && enChars > 10;
}

const PROMPT_KEYWORDS = [
  "photorealistic", "octane render", "masterpiece", "8k", "4k", "ultra detailed",
  "keep the face", "identical to the reference", "no changes to identity",
  "--ar", "--v", "--niji", "--seed", "--chaos", "--stylize",
  "stable diffusion", "midjourney", "dall-e", "sdxl", "controlnet",
  "negative prompt", "steps:", "cfg scale", "sampler", "denoising",
  "render", "cinematic lighting", "volumetric lighting", "ray tracing",
  "unreal engine", "blender", "zbrush", "substance painter",
  "highly detailed", "intricate details", "sharp focus", "depth of field",
  "bokeh", "film grain", "color grading", "hdr", "uhd",
  "prompt:", "system prompt:", "user:", "assistant:", "instruction:",
  "face identical", "lighting may change", "hairstyle", "facial shape",
  "panel", "reference sheet", "grid layout", "lens", "framing", "shot", "angle",
  "background", "camera", "pure white", "studio",
];

export function protectPrompts(text) {
  if (!text) return { text, prompts: [] };
  const prompts = [];
  const paragraphs = text.split(/\n\s*\n/);
  const result = [];

  for (const para of paragraphs) {
    const paraTrimmed = para.trim();
    if (!paraTrimmed) { result.push(para); continue; }

    // v0.6.10: Strip URLs and markdown links before counting ASCII letters
    // This prevents link-heavy paragraphs from being detected as English prompts
    const paraNoUrls = paraTrimmed
      .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")  // [text](url) → text
      .replace(/https?:\/\/[^\s]+/g, "");          // plain URLs → removed
    const asciiLetters = (paraNoUrls.match(/[a-zA-Z]/g) || []).length;
    const persianChars = (paraNoUrls.match(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
    const isEnglishDominant = asciiLetters > persianChars && asciiLetters > 15;

    // v0.6.10: Skip if paragraph is mostly URLs/links (not real prompt content)
    const urlCount = (paraTrimmed.match(/https?:\/\/[^\s]+/g) || []).length;
    const markdownLinkCount = (paraTrimmed.match(/\[([^\]]*)\]\([^)]+\)/g) || []).length;
    const isLinkHeavy = (urlCount + markdownLinkCount) >= 2 && paraNoUrls.trim().length < 100;

    if (isEnglishDominant && !isLinkHeavy) {
      const paraLower = paraTrimmed.toLowerCase();
      let keywordCount = 0;
      for (const kw of PROMPT_KEYWORDS) {
        if (paraLower.includes(kw)) keywordCount++;
      }
      const hasMJParams = /--\w+\s+\S+/.test(paraTrimmed);
      const startsWithLabel = /^(prompt|system|user|assistant|instruction|role)\s*:/i.test(paraTrimmed);
      const hasPromptStructure = /\b(panel|reference sheet|grid layout|view|profile|lighting|lens|framing|shot|angle|background|camera|render)\b/i.test(paraTrimmed);
      // Also check if the word "پرامپت" appears in nearby text (previous paragraph)
      const prevPara = result.length > 0 ? result[result.length - 1] : "";
      const hasNearbyPromptWord = prevPara.includes("پرامپت") || paraTrimmed.includes("پرامپت");

      const shouldProtect = (
        (paraTrimmed.length > 80 && (keywordCount >= 1 || hasMJParams || startsWithLabel || hasPromptStructure || hasNearbyPromptWord)) ||
        (paraTrimmed.length > 200 && isEnglishDominant)
      );

      if (shouldProtect) {
        const placeholder = `__PROMPT_BLOCK_${prompts.length}__`;
        prompts.push(paraTrimmed);
        console.log(`[cleaner] protected prompt block ${prompts.length - 1}: ${paraTrimmed.length} chars, ${keywordCount} keywords`);
        result.push(placeholder);
        continue;
      }
    }
    result.push(para);
  }

  return { text: result.join("\n\n"), prompts };
}

export function restorePrompts(text, prompts) {
  if (!text || !prompts || prompts.length === 0) return text;
  return text.replace(/__PROMPT_BLOCK_(\d+)__/g, (_, i) => {
    const prompt = prompts[Number(i)];
    if (!prompt) return "";
    return `\n§PROMPT_START§${prompt}§PROMPT_END§\n`;
  });
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

  // 2. Protect URLs (GitHub, docs, etc.) — but REMOVE spam links first.
  //    Spam links: Telegram invite links (t.me/joinchat, t.me/+xxx), sticker packs
  //    Tech links: GitHub, docs, npm, etc. (always preserved)
  const urls = [];
  text = text.replace(LINK_REGEX, (m) => {
    if (isSpamLink(m) && !isTechLink(m)) {
      // Spam link — remove it (return empty string)
      console.log(`[cleaner] removing spam link: ${m.slice(0, 60)}`);
      return "";
    }
    urls.push(m);
    return `__URL_${urls.length - 1}__`;
  });

  // 3. Remove "via @username" attribution
  text = text.replace(/\bvia\s+@[\w_]+\b/gi, "");

  // 4. Remove "source: @username"
  text = text.replace(/\bsource\s*:\s*@[\w_]+\b/gi, "");

  // 5. Remove "@DevTwitter | <Author>" style attribution lines (signature at end of post)
  text = text.replace(/\n\s*@\w+\s*\|[^\n]*$/gim, "");
  text = text.replace(/\n\s*@\w+\s*[—–-]\s*[^\n]*$/gim, "");

  // v0.6.11: Remove promotional footer PATTERNS
  text = text.split("\n").map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.includes("🌀 @ILIVIR3")) return line;

    // Check if line starts with an emoji (non-ASCII, non-Persian, non-letter)
    const startsWithEmoji = /^[^\w\s\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(trimmed);

    // Remove: emoji + @username (e.g. "🆔 @ShahrSakhtAfzar", "🎮 @GamotionArt")
    if (startsWithEmoji && /@\w+/.test(trimmed) && trimmed.length < 80) return "";
    // Remove: @username | description
    if (/^@\w+\s*[|•·]\s*[^\n]{0,60}$/.test(trimmed)) return "";
    // Remove: @username • description
    if (/^@\w+\s*•/.test(trimmed)) return "";
    // Remove: standalone @username
    if (/^@\w+$/.test(trimmed)) return "";
    // Remove: dots/separators
    if (/^[.·•─—–-]{3,}$/.test(trimmed)) return "";
    return line;
  }).join("\n");

  // 6. Remove @channel_username inline (but not URLs or bot footer)
  text = text.replace(/(^|\s)@([A-Za-z][A-Za-z0-9_]{3,})\b/g, (match, prefix, username, offset) => {
    if (isUsernamePartOfUrl(text, offset + prefix.length)) return match;
    if (username === "ILIVIR3") return match;
    return prefix;
  });

  // v0.6.11: Clean up leftover lines (standalone emoji or emoji + separator + short text)
  text = text.split("\n").map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.includes("🌀 @ILIVIR3")) return line;
    // Remove: standalone non-alphanumeric line (leftover emoji)
    if (/^[^\w\s\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]+$/.test(trimmed) && trimmed.length < 5) return "";
    // Remove: emoji + separator + short text (leftover from @channel | desc)
    const startsWithEmoji = /^[^\w\s\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(trimmed);
    if (startsWithEmoji && /[|•·-]/.test(trimmed) && trimmed.length < 60) return "";
    return line;
  }).join("\n");

  // 7. Remove "Join / Follow / Subscribe" lines
  text = text.replace(/^\s*(join|subscribe|follow|don't miss out|click here to)\b[^\n]*$/gim, "");
  text = text.replace(/\b(join our (channel|group)|subscribe to (our|the) channel)\b[^\n]*/gi, "");

  // 8. Remove "for more: @channel" / "more: t.me/xxx"
  text = text.replace(/\b(for more|more info|more details?)\s*[:：]\s*@?[\w/.\-]+/gi, "");

  // 9. Collapse spam hashtag blocks
  text = text.replace(/((?:#\w+[ \t]*){5,})/g, (block) => {
    const tags = block.trim().split(/[ \t]+/);
    return tags.slice(0, 2).join(" ");
  });

  // 10. Remove promotional footers (already handled above, but keep as fallback)
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
