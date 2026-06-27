/**
 * src/formatter.js
 * UI Formatter (Stage 3) — transforms plain text into beautiful Telegram HTML.
 *
 * Per V2 Architecture:
 *   - Formatter ONLY changes appearance, NEVER changes meaning
 *   - Editor outputs plain text, Formatter adds all visual presentation
 *   - Formatting is controlled by `intensity` (0-100%) and `emojiLevel` (0-100%)
 *
 * UI Rules (from ui_rules.md):
 *   - Bold: ONLY for important info (tool names, product names, etc.) — 2-6 per post
 *   - Monospace: for commands, filenames, env vars, API names
 *   - Quote blocks: for URLs, repos, docs, commands, footer
 *   - Bullet lists: convert inline lists to bullets
 *   - Numbered lists: when order matters
 *   - Headings: only when they improve navigation
 *   - Emojis: 1-5 per post, only allowed emojis, no emotional emojis
 *   - Paragraphs: max 3-4 sentences, split long ones
 *
 * Intensity mapping (formatting ONLY, not rewriting):
 *   10% = spacing + footer
 *   20% = + better paragraphs + bold keywords
 *   30% = + paragraph optimization + quote links
 *   40% = + lists + headings + monospace + quote repos/docs
 *   50% = + advanced visual layout
 *   60% = + magazine quality formatting
 *   80% = + professional editorial formatting
 *   100% = maximum visual optimization
 */

// URL regex that stops at the next "https://" (handles stuck-together URLs)
const URL_SPLIT_REGEX = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"'])+/gi;

// Allowed emojis per UI Rules (no emotional emojis)
const ALLOWED_EMOJIS = ["🛠️", "🚀", "🤖", "📚", "⚡", "🔒", "🌐", "📦", "💡", "📝", "🎯", "🐞", "🧩"];

// Patterns for detecting technical terms that should be monospace
const MONOSPACE_PATTERNS = [
  // Commands: npm install, pip install, git clone, docker run, etc.
  /\b(npm|pip|yarn|pnpm|bun|cargo|go|git|docker|kubectl|terraform|wrangler|node|python|ruby|gem)\s+(install|run|build|clone|create|add|remove|start|stop|deploy|init|exec)\b/gi,
  // Filenames: package.json, config.yml, docker-compose.yml, etc.
  /\b[\w-]+\.(json|yml|yaml|toml|ini|env|sh|bash|zsh|py|js|ts|go|rs|rb|java|c|cpp|md|txt|xml|html|css|sql)\b/gi,
  // Environment variables: ALL_CAPS_NAMES
  /\b[A-Z]{2,}[A-Z0-9_]{2,}\b/g,
  // File paths: /path/to/file
  /\/[\w\-./]+/g,
];

// ============================================================
// HTML ENGINE
// ============================================================
const htmlEngine = {
  name: "html",
  parseMode: "HTML",

  escape(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },

  wrapLink(url) {
    return `<blockquote>${url}</blockquote>`;
  },

  /**
   * Format plain text into beautiful Telegram HTML.
   * @param {string} text - plain text from Editor stage
   * @param {object} ctx - { footer, intensity, emojiLevel }
   */
  format(text, ctx = {}) {
    const intensity = ctx.intensity ?? 60;
    const emojiLevel = ctx.emojiLevel ?? 20;
    const footer = ctx.footer; // null = no footer (added separately in pipeline)

    if (!text || !text.trim()) return "";

    // 1. Protect code blocks
    const codeBlocks = [];
    let work = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code.replace(/^\n+|\n+$/g, ""));
      return `__CODEBLOCK_${codeBlocks.length - 1}__`;
    });

    // 2. Protect inline code
    const inlineCodes = [];
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return `__INLINE_${inlineCodes.length - 1}__`;
    });

    // 3. Convert markdown-style links [text](url) → "text\nurl"
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1\n$2");

    // 4. Remove angle brackets around URLs
    work = work.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");

    // 5. Escape HTML
    work = this.escape(work);

    // 6. Replace URLs with blockquotes
    work = work.replace(URL_SPLIT_REGEX, (url) => this.wrapLink(url));

    // 7. Restore inline code
    work = work.replace(/__INLINE_(\d+)__/g, (_, i) => `<code>${this.escape(inlineCodes[Number(i)])}</code>`);

    // 8. Restore code blocks
    work = work.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => `<pre><code>${this.escape(codeBlocks[Number(i)])}</code></pre>`);

    // === FORMATTING BASED ON INTENSITY ===

    // 9. Bold conversion (intensity >= 20)
    if (intensity >= 20) {
      // **bold** → <b>bold</b>
      work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      // *italic* → <i>italic</i> (after bold)
      work = work.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
      // ~~strike~~ → <s>strike</s>
      if (intensity >= 40) {
        work = work.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
      }
    }

    // 10. Headings (intensity >= 40)
    if (intensity >= 40) {
      // ### Title, ## Title, # Title → <b>Title</b>
      work = work.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
    }

    // 11. Bullet lists (intensity >= 20)
    if (intensity >= 20) {
      // - item, * item, • item → • item
      work = work.replace(/^[\s]*[-•*]\s+(.+)$/gm, "• $1");
    }

    // 12. Numbered lists (intensity >= 40)
    if (intensity >= 40) {
      // 1. item → keep as is (already numbered)
      // Convert "1)" to "1." for consistency
      work = work.replace(/^(\d+)\)\s+/gm, "$1. ");
    }

    // 13. Quote paragraphs (intensity >= 30)
    // Per UI Rules: quote long paragraphs, commands, multi-line examples
    if (intensity >= 30) {
      const minLength = intensity >= 80 ? 80 : 120;
      const lines = work.split("\n");
      const quotedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("<blockquote>")) return line;
        if (/<[a-z/]/i.test(trimmed)) return line;
        if (trimmed.length < minLength) return line;
        if (/^[•\-\*\d]/.test(trimmed)) return line;
        if (trimmed.startsWith("__CODEBLOCK") || trimmed.startsWith("__INLINE")) return line;
        const sentenceEnds = (trimmed.match(/[.!?؟!]/g) || []).length;
        if (sentenceEnds < 2) return line;
        return `<blockquote>${trimmed}</blockquote>`;
      });
      work = quotedLines.join("\n");
    }

    // 14. Split long paragraphs (intensity >= 40)
    // Per UI Rules: max 3-4 sentences per paragraph
    if (intensity >= 40) {
      work = work.replace(/([.!?؟!])\s+/g, "$1\n");
    }

    // 15. Add emojis (based on emojiLevel)
    if (emojiLevel > 0) {
      work = this.addEmojis(work, emojiLevel);
    }

    // 16. Clean up extra blank lines
    work = work.replace(/\n{3,}/g, "\n\n");

    // 17. Append footer (if provided)
    if (footer) {
      work = `${work}\n\n<blockquote>${footer}</blockquote>`;
    }

    return work.trim();
  },

  /**
   * Add emojis based on emojiLevel.
   * Per UI Rules: 1-5 emojis, only allowed emojis, no emotional emojis.
   */
  addEmojis(text, emojiLevel) {
    if (emojiLevel === 0) return text;

    const maxEmojis = emojiLevel <= 20 ? 2 : emojiLevel <= 50 ? 4 : 5;
    let emojiCount = 0;

    // Add emoji at the start of the post
    if (emojiCount < maxEmojis) {
      const startEmoji = ALLOWED_EMOJIS[Math.floor(Math.random() * 3)]; // 🛠️🚀🤖
      text = `${startEmoji} ${text}`;
      emojiCount++;
    }

    // Add emojis before headings (lines starting with <b>)
    if (emojiCount < maxEmojis) {
      const headingEmojis = ["📚", "⚡", "🔒", "📦", "💡", "📝", "🎯"];
      text = text.replace(/<b>([^<]+)<\/b>/g, (match, content) => {
        if (emojiCount >= maxEmojis) return match;
        emojiCount++;
        const emoji = headingEmojis[emojiCount % headingEmojis.length];
        return `${emoji} <b>${content}</b>`;
      });
    }

    return text;
  },

  wrapFooter(text, footer) {
    return `${text}\n\n<blockquote>${footer}</blockquote>`;
  },
};

// ============================================================
// PLAIN TEXT ENGINE (fallback)
// ============================================================
const plainEngine = {
  name: "plain",
  parseMode: null,
  wrapLink(url) { return url; },
  format(text, ctx = {}) {
    let work = text.trim();
    if (ctx.footer) work = `${work}\n\n${ctx.footer}`;
    return work;
  },
  wrapFooter(text, footer) { return `${text}\n\n${footer}`; },
};

// ============================================================
// REGISTRY
// ============================================================
const REGISTRY = new Map();
REGISTRY.set("html", htmlEngine);
REGISTRY.set("plain", plainEngine);

export function registerEngine(engine) {
  if (!engine?.name || typeof engine.format !== "function") {
    throw new Error("Invalid engine");
  }
  REGISTRY.set(engine.name, engine);
}

export function getEngine(name = "html") {
  return REGISTRY.get(name) || htmlEngine;
}

// ============================================================
// PUBLIC API
// ============================================================
export function formatPost(text, ctx = {}) {
  const engine = getEngine(ctx.engineName || "html");
  const formatted = engine.format(text, ctx);
  return { text: formatted, parseMode: engine.parseMode };
}

export function extractUrls(text) {
  return [...new Set(text.match(URL_SPLIT_REGEX) || [])];
}
