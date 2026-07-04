/**
 * src/formatter.js — v0.6.0
 *
 * FIXES:
 *   - <a href> tags no longer escaped (protected before escape)
 *   - Plain URLs → <a href> with shortened label (not blockquote)
 *   - First paragraph never quoted (two-pass)
 *   - Prompts detected and wrapped in <pre><code>
 *   - HTML validation: fix broken tags before returning
 *   - No emoji at start of post
 */

const URL_SPLIT_REGEX = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"'])+/gi;

const FUNCTIONAL_EMOJIS = new Set([
  "🛠️","🚀","🤖","📚","⚡","🔒","🌐","📦","💡","📝","🎯","🐞","🧩","⚠️","✨","📥","🔗","📊","🔧","✅","❌",
]);
const NUMBER_EMOJIS = ["0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣","8️⃣","9️⃣","🔟"];
const DECORATIVE_EMOJI_REGEX = /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1FA70}-\u{1FAFF}]/gu;

function stripDecorativeEmojis(text) {
  const fp = [];
  let p = text;
  for (const e of FUNCTIONAL_EMOJIS) { fp.push(e); p = p.split(e).join(`\u0000F${fp.length-1}\u0000`); }
  for (let i = 0; i <= 10; i++) { fp.push(NUMBER_EMOJIS[i]); p = p.split(NUMBER_EMOJIS[i]).join(`\u0000N${i}\u0000`); }
  let r = p.replace(DECORATIVE_EMOJI_REGEX, "");
  r = r.replace(/\u0000F(\d+)\u0000/g, (_, i) => [...FUNCTIONAL_EMOJIS][parseInt(i)] || "");
  r = r.replace(/\u0000N(\d+)\u0000/g, (_, i) => NUMBER_EMOJIS[parseInt(i)] || "");
  return r.replace(/  +/g, " ");
}

function shortenUrl(url) {
  try {
    const u = new URL(url);
    let label = u.hostname + u.pathname;
    label = label.replace(/\/$/, "");
    if (label.length > 40) label = label.slice(0, 37) + "…";
    return label;
  } catch { return url.length > 40 ? url.slice(0, 37) + "…" : url; }
}

function trimUrlPunctuation(url) { return url.replace(/[.,);:!?}\]]+$/, ""); }

function validateAndFixHtml(html) {
  let r = html;
  const tags = ["blockquote", "a", "b", "i", "code", "pre", "s", "u"];
  for (const tag of tags) {
    const open = tag === "a" ? (r.match(/<a\s/g) || []).length : (r.match(new RegExp(`<${tag}>`, "g")) || []).length;
    const close = (r.match(new RegExp(`</${tag}>`, "g")) || []).length;
    if (open > close) r += `</${tag}>`.repeat(open - close);
  }
  // Remove nested blockquotes
  r = r.replace(/<blockquote>([^<]*?)<blockquote>/g, "$1");
  r = r.replace(/<\/blockquote>([^<]*?)<\/blockquote>/g, "$1</blockquote>");
  return r;
}

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
    if (!text || !text.trim()) return "";

    // === PHASE 1: PROTECT ===
    
    // 1. Code blocks
    const codeBlocks = [];
    let work = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code.replace(/^\n+|\n+$/g, ""));
      return `\n§CB${codeBlocks.length - 1}§\n`;
    });

    // 2. Inline code
    const inlineCodes = [];
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return ` §IC${inlineCodes.length - 1}§ `;
    });

    // 3. Prompt blocks — v0.5.20: Two detection methods:
    //    A) §PROMPT_START§...§PROMPT_END§ markers (from restorePrompts — no label needed)
    //    B) Traditional label-based: "Prompt:", "System:", "🎨 AI Prompt:", etc.
    const promptBlocks = [];

    // v0.5.20: Method A — detect marker-wrapped prompts (no label shown to user)
    work = work.replace(/§PROMPT_START§([\s\S]*?)§PROMPT_END§/g, (_, content) => {
      if (content.trim().length > 20) {
        promptBlocks.push({ label: "", content: content.trim() }); // Empty label = no label shown
        return ` §P${promptBlocks.length - 1}§ `;
      }
      return content;
    });

    // Method B — traditional label-based detection
    // Catches: "### Prompt:", "**Prompt:**", "Prompt:", "🎨 AI Prompt:", Persian keywords
    work = work.replace(/(?:^|\n)(?:#{1,3}\s+|\*\*)?(🎨\s*)?(Prompt|System Prompt|System|User|INSTRUCTIONS?|ROLE|Query|Question|Task|AI Prompt|پرامپت|سیستم)(?:\*\*)?(?:\s*[:：])?\s*\n([\s\S]*?)(?=\n\n|\n#|\n\*\*|$)/gi, (_, emoji, label, content) => {
      if (content.trim().length > 20) {
        promptBlocks.push({ label: (label || "Prompt").trim(), content: content.trim() });
        return ` §P${promptBlocks.length - 1}§ `;
      }
      return _;
    });
    // Also detect: ```prompt ... ``` or ```system ... ``` code blocks already captured as §CB§
    // Those will be restored as <pre><code> which is fine.

    // 4. Markdown links [text](url) → placeholder
    const linkPlaceholders = [];
    work = work.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, linkText, url) => {
      linkPlaceholders.push({ text: linkText, url });
      return ` §L${linkPlaceholders.length - 1}§ `;
    });

    // 5. CRITICAL FIX: Protect EXISTING HTML tags from AI output
    //    Extract complete HTML tags (including < and >) BEFORE escape
    //    This prevents <a href="url">text</a> from being escaped to &lt;a href=...
    const htmlTags = [];
    // Match: <a href="...">text</a> (complete link), or any standalone HTML tag
    work = work.replace(/<a\s+[^>]*>[\s\S]*?<\/a>/gi, (match) => {
      htmlTags.push(match);
      return ` §H${htmlTags.length - 1}§ `;
    });
    // Match other HTML tags: <b>, </b>, <i>, </i>, <code>, </code>, <pre>, </pre>, <blockquote>, </blockquote>, <br>, <s>, </s>
    work = work.replace(/<\/?(?:b|i|u|s|code|pre|blockquote|br)\s*\/?>/gi, (match) => {
      htmlTags.push(match);
      return ` §H${htmlTags.length - 1}§ `;
    });

    // 6. Remove angle brackets around bare URLs
    work = work.replace(/<(https?:\/\/[^\s>]+)>/g, "$1");

    // === PHASE 2: STRIP + ESCAPE + URLS ===
    work = stripDecorativeEmojis(work);
    work = this.escape(work);

    // 7. Plain URLs → <a href> with shortened label
    work = work.replace(URL_SPLIT_REGEX, (urlRaw) => {
      const url = trimUrlPunctuation(urlRaw);
      const label = shortenUrl(url);
      return `<a href="${url}">${this.escape(label)}</a>`;
    });

    // 8. Restore markdown links as <a href>
    work = work.replace(/§L(\d+)§/g, (_, i) => {
      const link = linkPlaceholders[Number(i)];
      return `<a href="${link.url}">${this.escape(link.text)}</a>`;
    });

    // v0.5.24: Standalone links (on their own line, between paragraphs) → wrap in blockquote
    // Only wraps links that are ALONE on their line (not inline with other text)
    work = work.split("\n").map((line) => {
      const trimmed = line.trim();
      // Check if the line is ONLY a link (nothing else except whitespace)
      const linkMatch = trimmed.match(/^<a\s+href="[^"]+">[^<]*<\/a>$/i);
      if (linkMatch) {
        return `<blockquote>${trimmed}</blockquote>`;
      }
      return line;
    }).join("\n");

    // 9. Restore protected HTML tags (after escape — they're real HTML)
    work = work.replace(/§H(\d+)§/g, (_, i) => htmlTags[Number(i)] || "");

    // === PHASE 3: MARKDOWN TRANSFORMS ===
    if (intensity >= 20) {
      work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      work = work.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
      if (intensity >= 40) work = work.replace(/~~([^~\n]+)~~/g, "<s>$1</s>");
    }
    if (intensity >= 40) work = work.replace(/^#{1,3}\s+(.+)$/gm, "<b>$1</b>");
    if (intensity >= 20) work = work.replace(/^[\s]*[-•*]\s+(.+)$/gm, "• $1");

    // 10. Numbered steps — GROUP into ONE blockquote
    if (intensity >= 30) {
      const lines = work.split("\n");
      const out = [];
      let group = [];
      for (const line of lines) {
        const m = line.match(/^(\d+)[.)]\s+(.+)$/);
        if (m) {
          const n = parseInt(m[1]);
          const emoji = (n >= 0 && n <= 10) ? NUMBER_EMOJIS[n] : `${n}.`;
          group.push(`${emoji} ${m[2]}`);
        } else {
          if (group.length > 0) { out.push(`<blockquote>${group.join("\n")}</blockquote>`); group = []; }
          out.push(line);
        }
      }
      if (group.length > 0) out.push(`<blockquote>${group.join("\n")}</blockquote>`);
      work = out.join("\n");
    }

    // 11. Quote long paragraphs — TWO-PASS (skip first eligible)
    if (intensity >= 30) {
      const minLen = intensity >= 80 ? 80 : 120;
      const lines = work.split("\n");
      let firstIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t || t.startsWith("<") || t.startsWith("§")) continue;
        if (t.length < minLen) continue;
        if (/^[•\-\*\d]/.test(t)) continue;
        if ((t.match(/[.!?؟!]/g) || []).length < 2) continue;
        firstIdx = i; break;
      }
      work = lines.map((line, i) => {
        const t = line.trim();
        if (!t || t.startsWith("<") || t.startsWith("§")) return line;
        if (t.length < minLen) return line;
        if (/^[•\-\*\d]/.test(t)) return line;
        if ((t.match(/[.!?؟!]/g) || []).length < 2) return line;
        if (i === firstIdx) return line;
        return `<blockquote expandable="true">${t}</blockquote>`;
      }).join("\n");
    }

    // v0.6.1: Quote list items that follow a heading (line ending with ":")
    // Groups consecutive non-heading lines after a heading into a blockquote
    if (intensity >= 20) {
      const lines = work.split("\n");
      const result = [];
      let inListSection = false;
      let listBuffer = [];

      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        const isHeading = t.length > 3 && t.length < 100 && /[:：]\s*$/.test(t) && !t.startsWith("<");

        if (isHeading) {
          if (listBuffer.length > 0) {
            result.push(`<blockquote>${listBuffer.join("\n")}</blockquote>`);
            listBuffer = [];
          }
          result.push(lines[i]);
          inListSection = true;
          continue;
        }

        if (inListSection) {
          if (t && !t.startsWith("<") && !t.startsWith("§") && !/[:：]\s*$/.test(t) && t.length > 5 && t.length < 500) {
            listBuffer.push(t);
            const nextLine = (i + 1 < lines.length) ? lines[i + 1].trim() : "";
            const nextIsEmpty = !nextLine;
            const nextIsHeading = nextLine.length > 3 && nextLine.length < 100 && /[:：]\s*$/.test(nextLine);
            if (nextIsEmpty || nextIsHeading) {
              if (listBuffer.length > 0) {
                result.push(`<blockquote>${listBuffer.join("\n")}</blockquote>`);
                listBuffer = [];
              }
              inListSection = nextIsHeading;
            }
          } else {
            if (listBuffer.length > 0) {
              result.push(`<blockquote>${listBuffer.join("\n")}</blockquote>`);
              listBuffer = [];
            }
            inListSection = false;
            result.push(lines[i]);
          }
        } else {
          result.push(lines[i]);
        }
      }
      if (listBuffer.length > 0) {
        result.push(`<blockquote>${listBuffer.join("\n")}</blockquote>`);
      }
      work = result.join("\n");
    }

    // === PHASE 4: RESTORE PROTECTED CONTENT ===
    work = work.replace(/§IC(\d+)§/g, (_, i) => `<code>${this.escape(inlineCodes[Number(i)])}</code>`);
    work = work.replace(/§CB(\d+)§/g, (_, i) => `<pre><code>${this.escape(codeBlocks[Number(i)])}</code></pre>`);
    work = work.replace(/§P(\d+)§/g, (_, i) => {
      const p = promptBlocks[Number(i)];
      if (!p) return ''; // Safety check
      // v0.5.20: Only show label if it's non-empty (marker-based prompts have empty label)
      const labelHtml = p.label ? `<b>${this.escape(p.label)}:</b>\n` : "";
      return `${labelHtml}<blockquote expandable="true"><code>${this.escape(p.content)}</code></blockquote>`;
    });

    // === PHASE 5: POLISH ===
    if (emojiLevel > 0 && intensity >= 40) {
      work = this.addEmojisToHeadings(work, emojiLevel);
    }

    // v0.5.19: RTL fix — if a line starts with English/Latin chars but contains Persian,
    // prepend U+200F (Right-to-Left Mark) to force correct bidirectional rendering.
    // This prevents the "English word at start → entire line goes LTR" bug.
    work = work.split("\n").map((line) => {
      // Skip empty lines, HTML tags, or placeholders
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("§")) return line;

      // Check if line starts with Latin chars and contains Persian/Arabic
      const startsWithLatin = /^[A-Za-z0-9\-_/.]/.test(trimmed);
      const hasPersian = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(line);
      const hasLatin = /[A-Za-z]/.test(line);

      // If line has both Persian and Latin, and starts with Latin → needs RTL mark
      if (startsWithLatin && hasPersian && hasLatin) {
        return "\u200F" + line;
      }
      return line;
    }).join("\n");

    work = work.replace(/\n{3,}/g, "\n\n");
    if (footer) work = `${work}\n\n<blockquote>${footer}</blockquote>`;

    return validateAndFixHtml(work.trim());
  },

  addEmojisToHeadings(text, emojiLevel) {
    if (emojiLevel === 0) return text;
    const max = emojiLevel <= 20 ? 2 : emojiLevel <= 50 ? 4 : 6;
    let count = 0;
    const used = new Set();
    const emojis = ["📚","⚡","🔒","📦","💡","📝","🎯","🛠️","🚀","🤖"];
    let first = true;
    return text.split("\n").map((line) => {
      const t = line.trim();
      const m = t.match(/^<b>([^<]+)<\/b>$/);
      if (!m) return line;
      if (/[\u{1F300}-\u{1FAFF}]/u.test(m[1])) return line;
      if (first) { first = false; return line; }
      if (count >= max) return line;
      let emoji = emojis.find(e => !used.has(e)) || emojis[count % emojis.length];
      used.add(emoji); count++;
      return `${emoji} ${t}`;
    }).join("\n");
  },

  wrapFooter(text, footer) { return `${text}\n\n<blockquote>${footer}</blockquote>`; },
};

const plainEngine = {
  name: "plain", parseMode: null,
  format(text, ctx = {}) { let w = text.trim(); if (ctx.footer) w += `\n\n${ctx.footer}`; return w; },
  wrapFooter(text, footer) { return `${text}\n\n${footer}`; },
};

const REGISTRY = new Map();
REGISTRY.set("html", htmlEngine);
REGISTRY.set("plain", plainEngine);

export function registerEngine(e) { if (!e?.name || typeof e.format !== "function") throw new Error("Invalid"); REGISTRY.set(e.name, e); }
export function getEngine(n = "html") { return REGISTRY.get(n) || htmlEngine; }
export function formatPost(text, ctx = {}) { const e = getEngine(ctx.engineName || "html"); return { text: e.format(text, ctx), parseMode: e.parseMode }; }
export function extractUrls(text) { return [...new Set(text.match(URL_SPLIT_REGEX) || [])]; }
