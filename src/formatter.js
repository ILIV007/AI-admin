/**
 * src/formatter.js
 * UI Formatter (Stage 3) — v0.4.0
 *
 * Complete rewrite based on audit findings:
 *   - Code/inline code restored AFTER all markdown transforms (fixes corruption)
 *   - Plain URLs → <a href> with shortened label (not ugly blockquote)
 *   - URL trailing punctuation trimmed
 *   - Emojis only before standalone heading lines (not first heading, not inline bold)
 *   - First long paragraph never quoted (two-pass algorithm)
 *   - Numbered steps grouped in one blockquote
 *   - Decorative emojis stripped deterministically (not by AI)
 */

const URL_SPLIT_REGEX = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"'])+/gi;

const COMMAND_PATTERNS = [
  /^\s*(npm|pip|yarn|pnpm|bun|cargo|go|git|docker|kubectl|terraform|wrangler|node|python|ruby|gem|brew|apt|yum|dnf)\s+/i,
  /^\s*(sudo|chmod|chown|cp|mv|rm|mkdir|cd|ls|cat|grep|find|curl|wget|ssh|scp|rsync)\s+/i,
  /^\s*(export|set|unset|alias|source|eval|exec)\s+/i,
];

// Decorative emoji ranges to strip (emotional, celebration, excessive sparkle, fire, etc.)
// Covers: emoticons, transport, symbols, pictographs, fire, sparkles, hearts, etc.
// Does NOT strip: functional emojis (defined in FUNCTIONAL_EMOJIS set) — those are checked separately
const DECORATIVE_EMOJI_REGEX = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA70}-\u{1FAFF}]/gu;

// Functional emojis that are allowed (navigation aids)
const FUNCTIONAL_EMOJIS = new Set([
  "🛠️", "🚀", "🤖", "📚", "⚡", "🔒", "🌐", "📦", "💡", "📝", "🎯", "🐞", "🧩",
  "⚠️", "✨", "📥", "🔗", "📊", "🔧", "✅", "❌",
]);

// Number emojis
const NUMBER_EMOJIS = ["0️⃣", "1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

/**
 * Strip decorative emojis from text (deterministic, not AI-dependent).
 * Keeps functional emojis and number emojis.
 */
function stripDecorativeEmojis(text) {
  // First, protect functional emojis by replacing them with placeholders
  const functionalPlaceholders = [];
  let protected_text = text;
  for (const emoji of FUNCTIONAL_EMOJIS) {
    const placeholder = `\u0000FP${functionalPlaceholders.length}\u0000`;
    functionalPlaceholders.push(emoji);
    protected_text = protected_text.split(emoji).join(placeholder);
  }

  // Also protect number emojis (1️⃣ 2️⃣ etc.)
  for (let i = 0; i <= 10; i++) {
    const placeholder = `\u0000NE${i}\u0000`;
    functionalPlaceholders.push(NUMBER_EMOJIS[i]);
    protected_text = protected_text.split(NUMBER_EMOJIS[i]).join(placeholder);
  }

  // Collapse consecutive decorative emojis to max 1
  let result = protected_text.replace(/([\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA70}-\u{1FAFF}])\1+/gu, "$1");

  // Remove decorative emojis
  result = result.replace(DECORATIVE_EMOJI_REGEX, "");

  // Restore functional emojis from placeholders
  for (let i = 0; i < functionalPlaceholders.length; i++) {
    const placeholder = `\u0000${i < 11 ? 'FP' : 'NE'}${i < 11 ? i : i - 11}\u0000`;
    // Actually, let's do it more simply — restore all placeholders
  }
  // Simple restore: replace all \u0000XXn\u0000 patterns
  result = result.replace(/\u0000FP(\d+)\u0000/g, (_, i) => {
    const idx = parseInt(i);
    const emojis = [...FUNCTIONAL_EMOJIS];
    return emojis[idx] || "";
  });
  result = result.replace(/\u0000NE(\d+)\u0000/g, (_, i) => {
    return NUMBER_EMOJIS[parseInt(i)] || "";
  });

  // Clean up double spaces left by removed emojis
  result = result.replace(/  +/g, " ");

  return result;
}

/**
 * Shorten a URL for display as clickable link text.
 * "https://github.com/user/repo/very/long/path" → "github.com/user/repo"
 */
function shortenUrl(url) {
  try {
    const u = new URL(url);
    let label = u.hostname + u.pathname;
    // Remove trailing slash
    label = label.replace(/\/$/, "");
    // If too long, truncate with ellipsis
    if (label.length > 40) {
      label = label.slice(0, 37) + "…";
    }
    return label;
  } catch {
    // If URL parsing fails, return original
    return url;
  }
}

/**
 * Trim trailing punctuation from URL.
 */
function trimUrlPunctuation(url) {
  return url.replace(/[.,);:!?}\]]+$/, "");
}

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

    // === PHASE 1: PROTECT special content ===

    // 1. Protect code blocks
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

    // 3. Detect PROMPTS
    const promptBlocks = [];
    work = work.replace(/(?:^|\n)(Prompt|System Prompt|User):\s*(\{[\s\S]*?\})(?:\n|$)/gi, (match, label, content) => {
      promptBlocks.push({ label, content });
      return ` §P${promptBlocks.length - 1}§ `;
    });

    // 4. Convert markdown links [text](url) → placeholder
    const linkPlaceholders = [];
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, linkText, url) => {
      linkPlaceholders.push({ text: linkText, url: url });
      return ` §L${linkPlaceholders.length - 1}§ `;
    });

    // 5. Remove angle brackets around URLs
    work = work.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");

    // 6. Strip decorative emojis (deterministic)
    work = stripDecorativeEmojis(work);

    // === PHASE 2: HTML ESCAPE + URL/LINK HANDLING ===

    // 7. Escape HTML
    work = this.escape(work);

    // 8. Replace plain URLs with clickable <a> tags (shortened label)
    work = work.replace(URL_SPLIT_REGEX, (urlRaw) => {
      const url = trimUrlPunctuation(urlRaw);
      const label = shortenUrl(url);
      return `<a href="${url}">${this.escape(label)}</a>`;
    });

    // 9. Restore link placeholders as <a> tags
    work = work.replace(/§L(\d+)§/g, (_, i) => {
      const link = linkPlaceholders[Number(i)];
      return `<a href="${link.url}">${this.escape(link.text)}</a>`;
    });

    // === PHASE 3: MARKDOWN TRANSFORMS (on text WITHOUT code) ===

    // 10. Bold (intensity >= 20)
    if (intensity >= 20) {
      work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      work = work.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
      if (intensity >= 40) {
        work = work.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
      }
    }

    // 11. Headings (intensity >= 40) — only standalone lines
    if (intensity >= 40) {
      work = work.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
    }

    // 12. Bullet lists (intensity >= 20)
    if (intensity >= 20) {
      work = work.replace(/^[\s]*[-•*]\s+(.+)$/gm, "• $1");
    }

    // 13. Numbered steps (intensity >= 30) — GROUP into ONE blockquote
    if (intensity >= 30) {
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
          const emoji = (num >= 0 && num <= 10) ? NUMBER_EMOJIS[num] : `${num}.`;
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

    // 14. Quote long paragraphs (intensity >= 30) — TWO-PASS algorithm
    if (intensity >= 30) {
      const minLength = intensity >= 80 ? 80 : 120;
      const lines = work.split("\n");

      // Pass 1: find index of first quote-eligible paragraph
      let firstEligibleIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("<blockquote>")) continue;
        if (trimmed.startsWith("<")) continue;
        if (trimmed.startsWith("§")) continue;
        if (trimmed.length < minLength) continue;
        if (/^[•\-\*\d]/.test(trimmed)) continue;
        const sentenceEnds = (trimmed.match(/[.!?؟!]/g) || []).length;
        if (sentenceEnds < 2) continue;
        firstEligibleIdx = i;
        break;
      }

      // Pass 2: quote all eligible paragraphs EXCEPT the first one
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
        // Skip the first eligible paragraph (the hook)
        if (i === firstEligibleIdx) return line;
        return `<blockquote>${trimmed}</blockquote>`;
      });
      work = quotedLines.join("\n");
    }

    // === PHASE 4: RESTORE PROTECTED CONTENT (AFTER all transforms) ===

    // 15. Restore inline code → <code> (inline, copyable)
    work = work.replace(/§IC(\d+)§/g, (_, i) => {
      return `<code>${this.escape(inlineCodes[Number(i)])}</code>`;
    });

    // 16. Restore code blocks → <pre><code> (copyable, monospace)
    work = work.replace(/§CB(\d+)§/g, (_, i) => {
      return `<pre><code>${this.escape(codeBlocks[Number(i)])}</code></pre>`;
    });

    // 17. Restore prompt blocks → <b>label</b> + <pre><code>
    work = work.replace(/§P(\d+)§/g, (_, i) => {
      const prompt = promptBlocks[Number(i)];
      return `<b>${prompt.label}:</b>\n<pre><code>${this.escape(prompt.content)}</code></pre>`;
    });

    // === PHASE 5: FINAL POLISH ===

    // 18. Add emojis ONLY before standalone heading lines (NOT first heading, NOT inline bold)
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

  /**
   * Add emojis ONLY before standalone heading lines.
   * A "standalone heading" is a line that is exactly <b>...</b> (nothing else on the line).
   * Skip the first heading if it's the first content line.
   * Do NOT add emojis to inline bold (e.g., "text <b>word</b> more text").
   */
  addEmojisToHeadings(text, emojiLevel) {
    if (emojiLevel === 0) return text;

    const maxEmojis = emojiLevel <= 20 ? 2 : emojiLevel <= 50 ? 4 : 6;
    let emojiCount = 0;
    const headingEmojis = ["📚", "⚡", "🔒", "📦", "💡", "📝", "🎯", "🛠️", "🚀", "🤖"];
    let seenFirstHeading = false;

    const lines = text.split("\n");
    const processedLines = lines.map((line) => {
      const trimmed = line.trim();
      // Match ONLY standalone heading lines: entire line is <b>...</b>
      const headingMatch = trimmed.match(/^<b>([^<]+)<\/b>$/);
      if (!headingMatch) return line;

      // Skip if heading already has an emoji
      const content = headingMatch[1];
      if (/[\u{1F300}-\u{1FAFF}]/u.test(content)) return line;

      // Skip the first heading (don't add emoji to it)
      if (!seenFirstHeading) {
        seenFirstHeading = true;
        return line;
      }

      // Limit number of emojis
      if (emojiCount >= maxEmojis) return line;

      emojiCount++;
      const emoji = headingEmojis[emojiCount % headingEmojis.length];
      return `${emoji} ${trimmed}`;
    });

    return processedLines.join("\n");
  },

  wrapFooter(text, footer) {
    return `${text}\n\n<blockquote>${footer}</blockquote>`;
  },
};

const plainEngine = {
  name: "plain",
  parseMode: null,
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
