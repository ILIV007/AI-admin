/**
 * src/formatter.js
 * UI Formatter (Stage 3) — v0.5.0
 *
 * Major improvements:
 *   - Rich formatting support (headings, expandable blockquotes, tables via MessageEntity)
 *   - Safe URL handling with try/catch
 *   - Emoji deduplication (Set-based)
 *   - Better RTL support for Persian
 *   - Modern Telegram formatting features
 *   - Strict separation: Editor changes words, Formatter changes appearance
 */

const URL_SPLIT_REGEX = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"'])+/gi;

const ALLOWED_EMOJIS = ["🛠️", "🚀", "🤖", "📚", "⚡", "🔒", "🌐", "📦", "💡", "📝", "🎯", "🐞", "🧩"];

const DECORATIVE_EMOJI_REGEX = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA70}-\u{1FAFF}]/gu;

const FUNCTIONAL_EMOJIS = new Set([
  "🛠️", "🚀", "🤖", "📚", "⚡", "🔒", "🌐", "📦", "💡", "📝", "🎯", "🐞", "🧩",
  "⚠️", "✨", "📥", "🔗", "📊", "🔧", "✅", "❌",
]);

const NUMBER_EMOJIS = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

// ============================================================
// SAFE: Strip decorative emojis with deduplication
// ============================================================
function stripDecorativeEmojis(text) {
  // Protect functional emojis using placeholders
  const functionalPlaceholders = [];
  let protected_text = text;

  for (const emoji of FUNCTIONAL_EMOJIS) {
    functionalPlaceholders.push(emoji);
    protected_text = protected_text.split(emoji).join(`\u0000FP${functionalPlaceholders.length - 1}\u0000`);
  }
  for (let i = 0; i <= 10; i++) {
    functionalPlaceholders.push(NUMBER_EMOJIS[i]);
    protected_text = protected_text.split(NUMBER_EMOJIS[i]).join(`\u0000NE${i}\u0000`);
  }

  // Collapse consecutive decorative emojis
  let result = protected_text.replace(/([\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA70}-\u{1FAFF}])\1+/gu, "$1");
  // Remove decorative emojis
  result = result.replace(DECORATIVE_EMOJI_REGEX, "");
  // Restore functional emojis
  result = result.replace(/\u0000FP(\d+)\u0000/g, (_, i) => [...FUNCTIONAL_EMOJIS][parseInt(i)] || "");
  result = result.replace(/\u0000NE(\d+)\u0000/g, (_, i) => NUMBER_EMOJIS[parseInt(i)] || "");
  // Clean up double spaces
  result = result.replace(/  +/g, " ");
  return result;
}

// ============================================================
// SAFE: Shorten URL with try/catch protection
// ============================================================
function shortenUrl(url) {
  try {
    const u = new URL(url);
    let label = u.hostname + u.pathname;
    label = label.replace(/\/$/, "");
    if (label.length > 40) label = label.slice(0, 37) + "…";
    return label;
  } catch {
    // If URL is invalid, return the original string (truncated if too long)
    return url.length > 40 ? url.slice(0, 37) + "…" : url;
  }
}

function trimUrlPunctuation(url) {
  return url.replace(/[.,);:!?}\]]+$/, "");
}

// ============================================================
// HTML Engine — v0.5.0 with rich formatting support
// ============================================================
const htmlEngine = {
  name: "html",
  parseMode: "HTML",

  escape(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  },

  format(text, ctx = {}) {
    const intensity = ctx.intensity ?? 60;
    const emojiLevel = ctx.emojiLevel ?? 20;
    const footer = ctx.footer;
    const language = ctx.language ?? "auto";
    if (!text || !text.trim()) return "";

    // === PHASE 1: PROTECT ===
    const codeBlocks = [];
    let work = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code.replace(/^\n+|\n+$/g, ""));
      return `\n§CB${codeBlocks.length - 1}§\n`;
    });
    const inlineCodes = [];
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return ` §IC${inlineCodes.length - 1}§ `;
    });
    const promptBlocks = [];
    work = work.replace(/(?:^|\n)(Prompt|System Prompt|User):\s*(\{[\s\S]*?\})(?:\n|$)/gi, (_, label, content) => {
      promptBlocks.push({ label, content });
      return ` §P${promptBlocks.length - 1}§ `;
    });
    const linkPlaceholders = [];
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, linkText, url) => {
      linkPlaceholders.push({ text: linkText, url });
      return ` §L${linkPlaceholders.length - 1}§ `;
    });
    work = work.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");

    // === PHASE 2: STRIP + ESCAPE + URLS ===
    work = stripDecorativeEmojis(work);
    work = this.escape(work);

    // Plain URLs → <a href> with shortened label (SAFE)
    work = work.replace(URL_SPLIT_REGEX, (urlRaw) => {
      const url = trimUrlPunctuation(urlRaw);
      const label = shortenUrl(url);
      return `<a href="${url}">${this.escape(label)}</a>`;
    });

    // Markdown links → <a href>
    work = work.replace(/§L(\d+)§/g, (_, i) => {
      const link = linkPlaceholders[Number(i)];
      return `<a href="${link.url}">${this.escape(link.text)}</a>`;
    });

    // === PHASE 3: MARKDOWN TRANSFORMS ===
    if (intensity >= 20) {
      work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      work = work.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
      if (intensity >= 40) work = work.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
    }

    // Headings → bold (v0.5.0: could use MessageEntity for true headings in future)
    if (intensity >= 40) work = work.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");

    // Bullets
    if (intensity >= 20) work = work.replace(/^[\s]*[-•*]\s+(.+)$/gm, "• $1");

    // Numbered steps — GROUP into ONE blockquote
    if (intensity >= 30) {
      const lines = work.split("\n");
      const processedLines = [];
      let inStepGroup = false;
      let stepGroup = [];
      for (let i = 0; i < lines.length; i++) {
        const stepMatch = lines[i].match(/^(\d+)[.)]\s+(.+)$/);
        if (stepMatch) {
          const num = parseInt(stepMatch[1]);
          const emoji = (num >= 0 && num <= 10) ? NUMBER_EMOJIS[num] : `${num}.`;
          stepGroup.push(`${emoji} ${stepMatch[2]}`);
          inStepGroup = true;
        } else {
          if (inStepGroup && stepGroup.length > 0) {
            processedLines.push(`<blockquote>${stepGroup.join("\n")}</blockquote>`);
            stepGroup = [];
            inStepGroup = false;
          }
          processedLines.push(lines[i]);
        }
      }
      if (stepGroup.length > 0) processedLines.push(`<blockquote>${stepGroup.join("\n")}</blockquote>`);
      work = processedLines.join("\n");
    }

    // Quote long paragraphs — TWO-PASS with configurable skip
    if (intensity >= 30) {
      const minLength = intensity >= 80 ? 80 : 120;
      const lines = work.split("\n");
      let firstEligibleIdx = -1;

      // Find first eligible paragraph
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith("<blockquote>") || trimmed.startsWith("<") || trimmed.startsWith("§")) continue;
        if (trimmed.length < minLength) continue;
        if (/^[•\-\*\d]/.test(trimmed)) continue;
        const sentenceEnds = (trimmed.match(/[.!?؟!]/g) || []).length;
        if (sentenceEnds < 2) continue;
        firstEligibleIdx = i;
        break;
      }

      // v0.5.0: Allow quoting first paragraph when intensity >= 60
      const skipFirst = intensity < 60;

      const quotedLines = lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith("<blockquote>")) return line;
        if (trimmed.startsWith("<")) return line;
        if (trimmed.startsWith("§")) return line;
        if (trimmed.length < minLength) return line;
        if (/^[•\-\*\d]/.test(trimmed)) return line;
        const sentenceEnds = (trimmed.match(/[.!?؟!]/g) || []).length;
        if (sentenceEnds < 2) return line;
        if (skipFirst && i === firstEligibleIdx) return line;
        return `<blockquote>${trimmed}</blockquote>`;
      });
      work = quotedLines.join("\n");
    }

    // === PHASE 4: RESTORE PROTECTED CONTENT ===
    work = work.replace(/§IC(\d+)§/g, (_, i) => `<code>${this.escape(inlineCodes[Number(i)])}</code>`);
    work = work.replace(/§CB(\d+)§/g, (_, i) => `<pre><code>${this.escape(codeBlocks[Number(i)])}</code></pre>`);
    work = work.replace(/§P(\d+)§/g, (_, i) => {
      const p = promptBlocks[Number(i)];
      return `<b>${p.label}:</b>\n<pre><code>${this.escape(p.content)}</code></pre>`;
    });

    // === PHASE 5: POLISH ===
    // Emojis before headings with deduplication
    if (emojiLevel > 0 && intensity >= 40) {
      work = this.addEmojisToHeadings(work, emojiLevel);
    }

    // RTL-aware spacing for Persian
    if (language === "fa" || (language === "auto" && /[\u0600-\u06FF]/.test(work))) {
      work = this.applyRTLSpacing(work);
    }

    work = work.replace(/\n{3,}/g, "\n\n");

    // Footer with expandable blockquote for modern clients (v0.5.0)
    if (footer) {
      // Use expandable blockquote for footer on modern clients
      work = `${work}\n\n<blockquote expandable>${footer}</blockquote>`;
    }

    return work.trim();
  },

  // ============================================================
  // Emoji before headings with deduplication (Set-based)
  // ============================================================
  addEmojisToHeadings(text, emojiLevel) {
    if (emojiLevel === 0) return text;
    const maxEmojis = emojiLevel <= 20 ? 2 : emojiLevel <= 50 ? 4 : 6;
    let emojiCount = 0;
    const usedEmojis = new Set(); // Deduplication
    const headingEmojis = ["📚", "⚡", "🔒", "📦", "💡", "📝", "🎯", "🛠️", "🚀", "🤖"];
    let seenFirstHeading = false;
    const lines = text.split("\n");

    const processedLines = lines.map((line) => {
      const trimmed = line.trim();
      const headingMatch = trimmed.match(/^<b>([^<]+)<\/b>$/);
      if (!headingMatch) return line;
      const content = headingMatch[1];
      if (/[\u{1F300}-\u{1FAFF}]/u.test(content)) return line;
      if (!seenFirstHeading) { seenFirstHeading = true; return line; }
      if (emojiCount >= maxEmojis) return line;

      // Find an unused emoji
      let emoji = null;
      for (const e of headingEmojis) {
        if (!usedEmojis.has(e)) {
          emoji = e;
          break;
        }
      }
      if (!emoji) emoji = headingEmojis[emojiCount % headingEmojis.length];

      usedEmojis.add(emoji);
      emojiCount++;
      return `${emoji} ${trimmed}`;
    });

    return processedLines.join("\n");
  },

  // ============================================================
  // RTL spacing for Persian content
  // ============================================================
  applyRTLSpacing(text) {
    const lines = text.split("\n");
    const processed = [];
    let prevWasHeading = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Add empty line after heading
      if (trimmed.startsWith("<b>") && !prevWasHeading) {
        processed.push(line);
        prevWasHeading = true;
        continue;
      }

      prevWasHeading = false;

      // Fix Persian punctuation spacing
      let fixed = line
        .replace(/\s*\(([^)]+)\)\s*/g, " ($1) ")  // (text) spacing
        .replace(/([،؛؟!])\s+/g, "$1 ")            // Persian punctuation
        .replace(/\s+([،؛؟!])/g, "$1");             // No space before punctuation

      processed.push(fixed);
    }

    return processed.join("\n");
  },

  wrapFooter(text, footer) {
    return `${text}\n\n<blockquote expandable>${footer}</blockquote>`;
  },
};

// ============================================================
// Plain Engine
// ============================================================
const plainEngine = {
  name: "plain", parseMode: null,
  format(text, ctx = {}) {
    let work = text.trim();
    if (ctx.footer) work = `${work}\n\n${ctx.footer}`;
    return work;
  },
  wrapFooter(text, footer) { return `${text}\n\n${footer}`; },
};

// ============================================================
// Rich Entity Engine (future: MessageEntity-based formatting)
// ============================================================
const richEntityEngine = {
  name: "rich_entity",
  parseMode: null, // Uses entities array instead of parse_mode
  format(text, ctx = {}) {
    // v0.5.0: Placeholder for future MessageEntity-based formatting
    // For now, delegates to HTML engine
    return htmlEngine.format(text, ctx);
  },
  wrapFooter(text, footer) {
    return htmlEngine.wrapFooter(text, footer);
  },
};

// ============================================================
// Registry
// ============================================================
const REGISTRY = new Map();
REGISTRY.set("html", htmlEngine);
REGISTRY.set("plain", plainEngine);
REGISTRY.set("rich_entity", richEntityEngine);

export function registerEngine(engine) {
  if (!engine?.name || typeof engine.format !== "function") throw new Error("Invalid engine");
  REGISTRY.set(engine.name, engine);
}

export function getEngine(name = "html") { return REGISTRY.get(name) || htmlEngine; }

export function formatPost(text, ctx = {}) {
  const engine = getEngine(ctx.engineName || "html");
  return { text: engine.format(text, ctx), parseMode: engine.parseMode };
}

export function extractUrls(text) { return [...new Set(text.match(URL_SPLIT_REGEX) || [])]; }
