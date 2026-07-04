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
// v0.5.14: PROMPT PROTECTION — protect AI image generation prompts
// ============================================================
// Users paste long English AI prompts (Midjourney, Stable Diffusion, etc.)
// that contain keywords like "photorealistic", "octane render", "--ar", "8k".
// The AI rewrite step would destroy these by summarizing/translating them.
//
// We detect these blocks BEFORE cleaning, replace them with placeholders,
// and restore them AFTER the AI rewrite step (in pipeline.js).
// ============================================================

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
];

/**
 * v0.5.17: COMPLETELY REWRITTEN prompt detection.
 *
 * Problem in v0.5.15: When a post has Persian text + English prompt + Persian text
 * all in one paragraph (separated by single \n), the entire paragraph was protected.
 * This caused isMostlyPlaceholders=true → AI skipped → Persian text not cleaned.
 *
 * Solution: Instead of protecting whole paragraphs, detect CONTIGUOUS ENGLISH
 * blocks WITHIN paragraphs and protect only those.
 *
 * Algorithm:
 * 1. Split text into lines (by \n)
 * 2. Find contiguous runs of English-dominant lines (>50% ASCII letters)
 * 3. If such a run is >100 chars AND contains prompt keywords, protect it
 * 4. Leave surrounding Persian/non-prompt text for AI to process
 *
 * This way: "متن فارسی\nKeep the face 100% identical...\nمتن فارسی"
 * → Only the English block is protected, Persian text goes to AI.
 */
export function protectPrompts(text) {
  if (!text) return { text, prompts: [] };

  const prompts = [];

  // Split into lines
  const lines = text.split("\n");

  // Find contiguous runs of English-dominant lines
  const result = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Check if this line is English-dominant (>50% ASCII letters vs Persian/Arabic)
    const asciiLetters = (line.match(/[a-zA-Z]/g) || []).length;
    const persianChars = (line.match(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
    const isEnglishDominant = asciiLetters > persianChars && asciiLetters > 10;

    if (isEnglishDominant) {
      // Collect contiguous English-dominant lines
      const englishBlock = [line];
      let j = i + 1;
      while (j < lines.length) {
        const nextLine = lines[j];
        const nextAscii = (nextLine.match(/[a-zA-Z]/g) || []).length;
        const nextPersian = (nextLine.match(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
        const nextIsEnglish = nextAscii > nextPersian && nextAscii > 10;
        // Also include short lines (empty, URLs, etc.) between English lines
        const nextIsShort = nextLine.trim().length < 20;
        if (nextIsEnglish || (nextIsShort && englishBlock.length > 0)) {
          englishBlock.push(nextLine);
          j++;
        } else {
          break;
        }
      }

      const blockText = englishBlock.join("\n").trim();

      // Check if this block looks like an AI prompt
      const blockLower = blockText.toLowerCase();
      let keywordCount = 0;
      for (const kw of PROMPT_KEYWORDS) {
        if (blockLower.includes(kw)) keywordCount++;
      }
      const hasMJParams = /--\w+\s+\S+/.test(blockText);
      const startsWithLabel = /^(prompt|system|user|assistant|instruction|role)\s*:/i.test(blockText.trim());

      // Protect if: >80 chars AND (1+ keyword OR MJ params OR starts with label)
      // OR: >150 chars of pure English (likely a prompt even without keywords)
      const shouldProtect = (
        (blockText.length > 80 && (keywordCount >= 1 || hasMJParams || startsWithLabel)) ||
        (blockText.length > 150 && keywordCount >= 1)
      );

      if (shouldProtect) {
        const placeholder = `__PROMPT_BLOCK_${prompts.length}__`;
        prompts.push(blockText);
        console.log(`[cleaner] v0.5.17 protected English prompt block ${prompts.length - 1}: ${blockText.length} chars, ${keywordCount} keywords, MJ=${hasMJParams}`);
        result.push(placeholder);
        i = j; // Skip past the block
        continue;
      }
    }

    result.push(line);
    i++;
  }

  return {
    text: result.join("\n"),
    prompts,
  };
}

/**
 * Restore protected AI prompt blocks back into the text.
 * Called AFTER the AI rewrite step.
 *
 * v0.5.18: Restored prompts are wrapped with "🎨 AI Prompt:" label
 * so the formatter can detect them and wrap in collapsible blockquote.
 */
export function restorePrompts(text, prompts) {
  if (!text || !prompts || prompts.length === 0) return text;
  return text.replace(/__PROMPT_BLOCK_(\d+)__/g, (_, i) => {
    const prompt = prompts[Number(i)];
    if (!prompt) return "";
    // v0.5.18: Wrap with label + blank lines so formatter regex boundary works
    // The \n\n before and after ensures the formatter's (?=\n\n|\n#|\n\*\*|$) boundary triggers
    return `\n🎨 AI Prompt:\n${prompt}\n`;
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
