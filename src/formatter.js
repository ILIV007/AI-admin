/**
 * src/formatter.js
 * UI Formatter (Stage 3) — transforms plain text into beautiful Telegram HTML.
 *
 * v0.3.7 changes:
 *   - edit_intensity controls ONLY formatting (NOT rewriting)
 *   - No emoji at start of post (only before headings)
 *   - Code blocks wrapped in expandable blockquotes
 *   - Numbered steps grouped into one blockquote
 *   - <a href> tags protected from HTML escaping
 *   - Prompts/long text in expandable blockquotes
 */

const URL_SPLIT_REGEX = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"'])+/gi;

const ALLOWED_EMOJIS = ["🛠️", "🚀", "🤖", "📚", "⚡", "🔒", "🌐", "📦", "💡", "📝", "🎯", "🐞", "🧩"];

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

  format(text, ctx = {}) {
    const intensity = ctx.intensity ?? 60;
    const emojiLevel = ctx.emojiLevel ?? 20;
    const footer = ctx.footer;

    if (!text || !text.trim()) return "";

    // 1. Protect code blocks FIRST (before any other processing)
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

    // 3. Convert markdown links [text](url) → placeholder (protect from escaping)
    //    We'll convert to <a> tags AFTER escaping, using placeholders.
    const linkPlaceholders = [];
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, linkText, url) => {
      linkPlaceholders.push({ text: linkText, url: url });
      return `__LINK_${linkPlaceholders.length - 1}__`;
    });

    // 4. Remove angle brackets around URLs
    work = work.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");

    // 5. Escape HTML
    work = this.escape(work);

    // 6. Restore link placeholders as <a> tags (AFTER escaping, so they're not mangled)
    work = work.replace(/__LINK_(\d+)__/g, (_, i) => {
      const link = linkPlaceholders[Number(i)];
      return `<a href="${link.url}">${this.escape(link.text)}</a>`;
    });

    // 7. Replace URLs with blockquotes
    work = work.replace(URL_SPLIT_REGEX, (url) => this.wrapLink(url));

    // 8. Restore inline code
    work = work.replace(/__INLINE_(\d+)__/g, (_, i) => `<code>${this.escape(inlineCodes[Number(i)])}</code>`);

    // 9. Restore code blocks — wrap in expandable blockquote if intensity >= 30
    work = work.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => {
      const code = this.escape(codeBlocks[Number(i)]);
      if (intensity >= 30) {
        return `<blockquote expandable><pre><code>${code}</code></pre></blockquote>`;
      }
      return `<pre><code>${code}</code></pre>`;
    });

    // 10. Bold (intensity >= 20)
    if (intensity >= 20) {
      work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      work = work.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
      if (intensity >= 40) {
        work = work.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
      }
    }

    // 11. Headings (intensity >= 40)
    if (intensity >= 40) {
      work = work.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
    }

    // 12. Bullet lists (intensity >= 20)
    if (intensity >= 20) {
      work = work.replace(/^[\s]*[-•*]\s+(.+)$/gm, "• $1");
    }

    // 13. Numbered steps (intensity >= 30) — GROUP consecutive steps into ONE blockquote
    if (intensity >= 30) {
      const numberEmojis = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

      // First, convert each numbered line to a step with emoji
      const lines = work.split("\n");
      const processedLines = [];
      let inStepGroup = false;
      let stepGroup = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const stepMatch = line.match(/^(\d+)[.)]\s+(.+)$/);

        if (stepMatch) {
          const num = parseInt(stepMatch[1]);
          const stepText = stepMatch[2];
          const emoji = (num >= 0 && num <= 10) ? numberEmojis[num] : `${num}.`;
          stepGroup.push(`${emoji} ${stepText}`);
          inStepGroup = true;
        } else {
          // End of step group — flush
          if (inStepGroup && stepGroup.length > 0) {
            // Group all steps into ONE blockquote
            processedLines.push(`<blockquote>${stepGroup.join("\n")}</blockquote>`);
            stepGroup = [];
            inStepGroup = false;
          }
          processedLines.push(line);
        }
      }
      // Flush remaining steps
      if (stepGroup.length > 0) {
        processedLines.push(`<blockquote>${stepGroup.join("\n")}</blockquote>`);
      }
      work = processedLines.join("\n");
    }

    // 14. Quote long paragraphs (intensity >= 30)
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

    // 15. Add emojis ONLY before headings (NOT at start of post)
    if (emojiLevel > 0 && intensity >= 40) {
      work = this.addEmojisToHeadings(work, emojiLevel);
    }

    // 16. Clean up extra blank lines
    work = work.replace(/\n{3,}/g, "\n\n");

    // 17. Append footer
    if (footer) {
      work = `${work}\n\n<blockquote>${footer}</blockquote>`;
    }

    return work.trim();
  },

  /**
   * Add emojis ONLY before headings (lines with <b>).
   * Does NOT add emoji at the start of the post.
   */
  addEmojisToHeadings(text, emojiLevel) {
    if (emojiLevel === 0) return text;

    const maxEmojis = emojiLevel <= 20 ? 2 : emojiLevel <= 50 ? 4 : 6;
    let emojiCount = 0;

    const headingEmojis = ["📚", "⚡", "🔒", "📦", "💡", "📝", "🎯", "🛠️", "🚀", "🤖"];
    text = text.replace(/<b>([^<]+)<\/b>/g, (match, content) => {
      // Don't add emoji if heading already has one
      if (/[\u{1F300}-\u{1FAFF}]/u.test(content)) return match;
      if (emojiCount >= maxEmojis) return match;
      emojiCount++;
      const emoji = headingEmojis[emojiCount % headingEmojis.length];
      return `${emoji} <b>${content}</b>`;
    });

    return text;
  },

  wrapFooter(text, footer) {
    return `${text}\n\n<blockquote>${footer}</blockquote>`;
  },
};

// Plain text engine
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

export function formatPost(text, ctx = {}) {
  const engine = getEngine(ctx.engineName || "html");
  const formatted = engine.format(text, ctx);
  return { text: formatted, parseMode: engine.parseMode };
}

export function extractUrls(text) {
  return [...new Set(text.match(URL_SPLIT_REGEX) || [])];
}
