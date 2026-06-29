/**
 * src/cleaner.js
 * Content cleaning layer — v0.5.0
 *
 * Improvements:
 *   - Better Persian language detection (weighted threshold)
 *   - Preserves t.me/username links (only removes spam invite links)
 *   - Better RTL text handling
 */

const LINK_REGEX = /https?:\/\/[^\s<>"']+/gi;

const SPAM_LINK_PATTERNS = [
  /https?:\/\/t\.me\/(?:joinchat|\/+joinchat)\S*/gi,
  /https?:\/\/t\.me\/\+\S*/gi,
  /https?:\/\/t\.me\/(?:addstickers|addemoji)\S*/gi,
];

const TECH_LINK_PATTERNS = [
  /github\.com/i, /gist\.github/i, /raw\.githubusercontent/i,
  /gitlab\.com/i, /bitbucket\.org/i, /docs?\.\w+/i,
  /readthedocs/i, /stack?overflow/i, /developer\.\w+/i,
  /npmjs\.com/i, /pypi\.org/i, /crates\.io/i,
  /hub\.docker\.com/i, /wikipedia\.org/i, /arxiv\.org/i,
  /huggingface\.co/i,
];

function isSpamLink(url) {
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

function isUsernamePartOfUrl(text, matchIndex) {
  const before = text.slice(Math.max(0, matchIndex - 10), matchIndex);
  return /(https?:\/\/|\/|=)/.test(before);
}

// ============================================================
// MAIN CLEAN FUNCTION
// ============================================================
export function cleanContent(rawText) {
  if (!rawText) return "";
  let text = rawText;

  // 1. Protect code blocks and inline code
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

  // 2. Protect URLs — remove spam links, keep tech links
  const urls = [];
  text = text.replace(LINK_REGEX, (m) => {
    if (isSpamLink(m) && !isTechLink(m)) {
      console.log(`[cleaner] removing spam link: ${m.slice(0, 60)}`);
      return "";
    }
    urls.push(m);
    return `__URL_${urls.length - 1}__`;
  });

  // 3. Remove attribution patterns
  text = text.replace(/\bvia\s+@[\w_]+\b/gi, "");
  text = text.replace(/\bsource\s*:\s*@[\w_]+\b/gi, "");
  text = text.replace(/\n\s*@\w+\s*\|[^\n]*$/gim, "");
  text = text.replace(/\n\s*@\w+\s*[—–-]\s*[^\n]*$/gim, "");

  // 4. Remove standalone @channel_username (promo only, keep in URLs)
  text = text.replace(/(^|\s)@([A-Za-z][A-Za-z0-9_]{3,})\b/g, (match, prefix, username, offset) => {
    if (isUsernamePartOfUrl(text, offset + prefix.length)) return match;
    return prefix;
  });

  // 5. Remove promo lines
  text = text.replace(/^\s*(join|subscribe|follow|don't miss out|click here to)\b[^\n]*$/gim, "");
  text = text.replace(/\b(join our (channel|group)|subscribe to (our|the) channel)\b[^\n]*/gi, "");
  text = text.replace(/\b(for more|more info|more details?)\s*[:：]\s*@?[\w/.\-]+/gi, "");

  // 6. Collapse spam hashtags (5+ → keep first 2)
  text = text.replace(/((?:#\w+[ \t]*){5,})/g, (block) => {
    const tags = block.trim().split(/[ \t]+/);
    return tags.slice(0, 2).join(" ");
  });

  // 7. Remove promotional footers
  text = text.replace(/\n\s*[📡💬🌐🚀📢]*\s*@[A-Za-z]\w+(?:\s*\|\s*[@🌐][^\n]+)*\s*$/i, "");

  // 8. Restore protected content
  text = text.replace(/__URL_(\d+)__/g, (_, i) => urls[Number(i)]);
  text = text.replace(/__INLINE_CODE_(\d+)__/g, (_, i) => inlineCodes[Number(i)]);
  text = text.replace(/__CODE_BLOCK_(\d+)__/g, (_, i) => codeBlocks[Number(i)]);

  // 9. Clean whitespace
  text = text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return text;
}

// ============================================================
// LANGUAGE DETECTION — v0.5.0: Improved with weighted threshold
// ============================================================
export function detectLanguage(text) {
  if (!text) return "en";

  const faChars = (text.match(/[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/g) || []).length;
  const enChars = (text.match(/[A-Za-z]/g) || []).length;

  // v0.5.0: Use weighted threshold (1.5x) for better mixed-content detection
  if (faChars > enChars * 1.5 && faChars > 5) return "fa";
  if (enChars > faChars) return "en";

  // If mixed with slight Persian dominance, check for Persian words
  if (faChars > 0 && faChars >= enChars) {
    const persianWords = /\b(و|در|به|از|که|این|با|برای|است|های|شد|کرد|می|نیست|بود|یا|اما|اگر|چون|زیرا|بنابراین|همچنین|بسیار|خوب|بد|جديد|قدیمی|بزرگ|کوچک|زیاد|کم|هست|هستم|هستی|هستیم|هستید|هستند|باشد|باشم|باشی|باشیم|باشید|باشند)\b/gi;
    const faWordCount = (text.match(persianWords) || []).length;
    if (faWordCount >= 2) return "fa";
  }

  return "auto";
}

// ============================================================
// STATS HELPER
// ============================================================
export function contentStats(text) {
  return {
    length: text.length,
    words: text.trim() ? text.trim().split(/\s+/).length : 0,
    links: (text.match(LINK_REGEX) || []).length,
    hasGithub: /github\.com|gist\.github|raw\.githubusercontent/i.test(text),
    hasCodeBlock: /```/.test(text),
  };
}
