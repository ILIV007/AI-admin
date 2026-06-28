/**
 * src/formatter.js
 * UI Formatter (Stage 3) — transforms plain text into beautiful Telegram HTML.
 *
 * v0.3.9 changes:
 *   - FIXED: code blocks use <pre><code> directly (NO blockquote wrapper — it broke rendering)
 *   - FIXED: inline code uses <code> only (stays inline, copyable, no blockquote)
 *   - FIXED: first paragraph NOT quoted (only subsequent paragraphs)
 *   - FIXED: prompts use <pre><code> with label (no expandable blockquote)
 *   - Kept: clickable links <a href> for [text](url) patterns
 *   - Kept: URLs in <blockquote> (they're clickable in Telegram)
 *   - Kept: numbered steps grouped in one <blockquote>
 */

const URL_SPLIT_REGEX = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"'])+/gi;

const COMMAND_PATTERNS = [
  /^\s*(npm|pip|yarn|pnpm|bun|cargo|go|git|docker|kubectl|terraform|wrangler|node|python|ruby|gem|brew|apt|yum|dnf)\s+/i,
  /^\s*(sudo|chmod|chown|cp|mv|rm|mkdir|cd|ls|cat|grep|find|curl|wget|ssh|scp|rsync)\s+/i,
  /^\s*(export|set|unset|alias|source|eval|exec)\s+/i,
];

const htmlEngine = {
  name: "html",
  parseMode: "HTML",

  escape(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },

  format(text, ctx = {}) {
    const intensity = ctx.intensity ?? 60;
    const emojiLevel = ctx.emojiLevel ?? 20;
    const footer = ctx.footer;

    if (!text || !text.trim()) return "";

    // 1. Protect code blocks FIRST
    const codeBlocks = [];
    let work = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code.replace(/^\n+|\n+$/g, ""));
      return `\n§CB${codeBlocks.length - 1}§\n`;
    });

    // 2. Protect inline code
    const inlineCodes = [];
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return ` §IC${inlineCodes.length - 1}§ `;
    });

    // 3. Detect PROMPTS (long text blocks that look like AI prompts)
    const promptBlocks = [];
    work = work.replace(/(?:^|\n)(Prompt|System Prompt|User):\s*(\{[\s\S]*?\})(?:\n|$)/gi, (match, label, content) => {
      promptBlocks.push({ label, content });
      return ` §P${promptBlocks.length - 1}§ `;
    });

    // 4. Convert markdown links [text](url) → placeholder (protect from escaping & URL regex)
    const linkPlaceholders = [];
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, linkText, url) => {
      linkPlaceholders.push({ text: linkText, url: url });
      return ` §L${linkPlaceholders.length - 1}§ `;
    });

    // 5. Remove angle brackets around URLs
    work = work.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");

    // 6. Escape HTML
    work = this.escape(work);

    // 7. Replace plain URLs with blockquotes (they're clickable in Telegram)
    work = work.replace(URL_SPLIT_REGEX, (url) => `<blockquote>${url}</blockquote>`);

    // 8. Restore link placeholders as <a> tags (clickable, no ugly URL)
    work = work.replace(/§L(\d+)§/g, (_, i) => {
      const link = linkPlaceholders[Number(i)];
      return `<a href="${link.url}">${this.escape(link.text)}</a>`;
    });

    // 9. Restore inline code → <code> ONLY (inline, copyable, NO blockquote)
    work = work.replace(/§IC(\d+)§/g, (_, i) => {
      return `<code>${this.escape(inlineCodes[Number(i)])}</code>`;
    });

    // 10. Restore code blocks → <pre><code> directly (NO blockquote wrapper)
    //     blockquote expandable breaks <pre><code> rendering in Telegram
    work = work.replace(/§CB(\d+)§/g, (_, i) => {
      return `<pre><code>${this.escape(codeBlocks[Number(i)])}</code></pre>`;
    });

    // 11. Restore prompt blocks → <pre><code> with bold label (NO expandable blockquote)
    work = work.replace(/§P(\d+)§/g, (_, i) => {
      const prompt = promptBlocks[Number(i)];
      return `<b>${prompt.label}:</b>\n<pre><code>${this.escape(prompt.content)}</code></pre>`;
    });

    // 12. Detect inline commands (lines starting with command keywords) → <code> (inline, not blockquote)
    if (intensity >= 30) {
      const lines = work.split("\n");
      let insidePre = false;
      const processedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (trimmed.includes("<pre>")) insidePre = true;
        if (trimmed.includes("</pre>")) { insidePre = false; return line; }
        if (insidePre) return line;
        if (trimmed.startsWith("<")) return line;
        for (const pattern of COMMAND_PATTERNS) {
          if (pattern.test(trimmed)) {
            return `<code>${trimmed}</code>`;
          }
        }
        return line;
      });
      work = processedLines.join("\n");
    }

    // 13. Bold (intensity >= 20)
    if (intensity >= 20) {
      work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      work = work.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
      if (intensity >= 40) {
        work = work.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
      }
    }

    // 14. Headings (intensity >= 40)
    if (intensity >= 40) {
      work = work.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
    }

    // 15. Bullet lists (intensity >= 20)
    if (intensity >= 20) {
      work = work.replace(/^[\s]*[-•*]\s+(.+)$/gm, "• $1");
    }

    // 16. Numbered steps (intensity >= 30) — GROUP into ONE blockquote
    if (intensity >= 30) {
      const numberEmojis = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
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
          if (inStepGroup && stepGroup.length > 0) {
            processedLines.push(`<blockquote>${stepGroup.join("\n")}</blockquote>`);
            stepGroup = [];
            inStepGroup = false;
          }
          processedLines.push(line);
        }
      }
      if (stepGroup.length > 0) {
        processedLines.push(`<blockquote>${stepGroup.join("\n")}</blockquote>`);
      }
      work = processedLines.join("\n");
    }

    // 17. Quote long paragraphs (intensity >= 30)
    //     BUT: do NOT quote the FIRST paragraph (it should be the visible hook)
    if (intensity >= 30) {
      const minLength = intensity >= 80 ? 80 : 120;
      const lines = work.split("\n");
      let isFirstContentLine = true;
      const quotedLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("<blockquote>")) return line;
        if (/<[a-z/]/i.test(trimmed)) return line;
        if (trimmed.length < minLength) { isFirstContentLine = false; return line; }
        if (/^[•\-\*\d]/.test(trimmed)) { isFirstContentLine = false; return line; }
        if (trimmed.startsWith("§")) return line;
        const sentenceEnds = (trimmed.match(/[.!?؟!]/g) || []).length;
        if (sentenceEnds < 2) { isFirstContentLine = false; return line; }
        // Skip quoting for the first content paragraph
        if (isFirstContentLine) {
          isFirstContentLine = false;
          return line;
        }
        return `<blockquote>${trimmed}</blockquote>`;
      });
      work = quotedLines.join("\n");
    }

    // 18. Add emojis ONLY before headings (NOT at start of post)
    if (emojiLevel > 0 && intensity >= 40) {
      work = this.addEmojisToHeadings(work, emojiLevel);
    }

    // 19. Clean up extra blank lines
    work = work.replace(/\n{3,}/g, "\n\n");

    // 20. Append footer
    if (footer) {
      work = `${work}\n\n<blockquote>${footer}</blockquote>`;
    }

    return work.trim();
  },

  addEmojisToHeadings(text, emojiLevel) {
    if (emojiLevel === 0) return text;
    const maxEmojis = emojiLevel <= 20 ? 2 : emojiLevel <= 50 ? 4 : 6;
    let emojiCount = 0;
    const headingEmojis = ["📚", "⚡", "🔒", "📦", "💡", "📝", "🎯", "🛠️", "🚀", "🤖"];
    text = text.replace(/<b>([^<]+)<\/b>/g, (match, content) => {
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
  if (!engine?.name || typeof engine.format !== "function") throw new Error("Invalid engine");
  REGISTRY.set(engine.name, engine);
}

export function getEngine(name = "html") { return REGISTRY.get(name) || htmlEngine; }

export function formatPost(text, ctx = {}) {
  const engine = getEngine(ctx.engineName || "html");
  const formatted = engine.format(text, ctx);
  return { text: formatted, parseMode: engine.parseMode };
}

export function extractUrls(text) {
  return [...new Set(text.match(URL_SPLIT_REGEX) || [])];
}
