/**
 * src/formatter.js — v0.4.9
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

    // 3. Prompt blocks (System: ..., Prompt: ..., User: ... followed by multi-line content)
    const promptBlocks = [];
    work = work.replace(/(?:^|\n)(Prompt|System Prompt|System|User|INSTRUCTIONS?|ROLE):\s*\n([\s\S]*?)(?=\n\n|\n#|$)/gi, (_, label, content) => {
      if (content.trim().length > 30) { // Only treat as prompt if content is substantial
        promptBlocks.push({ label: label.trim(), content: content.trim() });
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

    // 10.5. v0.6.2: Quote list items — numbered items with dash, راه‌حل: lines,
    //       and HTML-wrapped headings ending with `:`. Collects heading +
    //       following description lines (until blank line OR next numbered item)
    //       into a blockquote.
    //
    //       Patterns detected (using INNER text after stripping HTML tags):
    //       1. `^\d+\s*[–\-—]\s+`  — numbered items with dash (e.g., "400 – Bad Request")
    //       2. `^راه[\-\s]?حل\s*[:：]`  — Persian "Solution:" lines
    //       3. HTML-wrapped headings ending with `:` (e.g., "<b>عکاسی و ویدیو:</b>")
    //
    //       Bug fix: previously, lines starting with `<` were skipped in step 11,
    //       but after markdown transforms, headings like `<b>...</b>` start with
    //       `<` and weren't detected. We now check the INNER text by stripping HTML.
    if (intensity >= 30) {
      const stripTags = (s) => s.replace(/<[^>]+>/g, "");

      // Numbered item with dash (e.g., "400 –", "401 -", "402 —")
      const isNumberedDashItem = (line) => {
        const t = line.trim();
        if (!t) return false;
        if (t.startsWith("<blockquote>") || t.startsWith("</blockquote>")) return false;
        if (t.startsWith("§")) return false;
        const inner = stripTags(t).trim();
        return /^\d+\s*[–\-—]\s+/.test(inner);
      };

      // راه‌حل: line OR HTML-wrapped heading ending with `:`
      const isRaholOrColonHeading = (line) => {
        const t = line.trim();
        if (!t) return false;
        if (t.startsWith("<blockquote>") || t.startsWith("</blockquote>")) return false;
        if (t.startsWith("§")) return false;
        const inner = stripTags(t).trim();
        if (!inner) return false;
        // Persian "Solution:" lines (راه‌حل:, راه حل:, راهحل:, راه-حل:)
        // Note: \u200C = ZWNJ (Zero Width Non-Joiner) — used in "راه‌حل"
        if (/^راه[\-\s\u200C]?حل\s*[:：]/.test(inner)) return true;
        // HTML-wrapped heading ending with `:` (only if line contains HTML tags,
        // to avoid quoting every plain-text line that happens to end with `:`)
        if (/<[^>]+>/.test(t) && (inner.endsWith(":") || inner.endsWith("："))) return true;
        return false;
      };

      const isListHeading = (line) => isNumberedDashItem(line) || isRaholOrColonHeading(line);

      const lines = work.split("\n");
      const out = [];
      let i = 0;
      while (i < lines.length) {
        if (isListHeading(lines[i])) {
          const startsNumbered = isNumberedDashItem(lines[i]);
          const block = [lines[i]];
          i++;
          while (i < lines.length) {
            const t = lines[i].trim();
            if (t === "") break;  // blank line ends the block
            // Next numbered item ALWAYS ends the block
            if (isNumberedDashItem(lines[i])) break;
            if (startsNumbered) {
              // Inside a numbered-item block: راه‌حل: and colon headings are
              // treated as description (do NOT terminate the block)
              block.push(lines[i]);
              i++;
            } else {
              // Inside a راه‌حل/colon block: another راه‌حل/colon heading ends it
              if (isRaholOrColonHeading(lines[i])) break;
              block.push(lines[i]);
              i++;
            }
          }
          out.push(`<blockquote>${block.join("\n")}</blockquote>`);
        } else {
          out.push(lines[i]);
          i++;
        }
      }
      work = out.join("\n");
    }

    // 11. Quote long paragraphs — TWO-PASS (skip first eligible)
    //     v0.6.2: Fixed bug where HTML-wrapped headings (e.g., "<b>title</b>")
    //     were skipped because they start with `<`. Now checks INNER text by
    //     stripping HTML tags. Already-quoted blockquote lines are still skipped.
    if (intensity >= 30) {
      const minLen = intensity >= 80 ? 80 : 120;
      const stripTags = (s) => s.replace(/<[^>]+>/g, "");
      const lines = work.split("\n");
      let firstIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        const t = lines[i].trim();
        if (!t || t.startsWith("§")) continue;
        if (t.startsWith("<blockquote>") || t.startsWith("</blockquote>")) continue;
        // v0.6.2: Check inner text (strip HTML tags) instead of raw line
        const inner = stripTags(t).trim();
        if (inner.length < minLen) continue;
        if (/^[•\-\*\d]/.test(inner)) continue;
        if ((inner.match(/[.!?؟!]/g) || []).length < 2) continue;
        firstIdx = i; break;
      }
      work = lines.map((line, i) => {
        const t = line.trim();
        if (!t || t.startsWith("§")) return line;
        if (t.startsWith("<blockquote>") || t.startsWith("</blockquote>")) return line;
        const inner = stripTags(t).trim();
        if (inner.length < minLen) return line;
        if (/^[•\-\*\d]/.test(inner)) return line;
        if ((inner.match(/[.!?؟!]/g) || []).length < 2) return line;
        if (i === firstIdx) return line;
        return `<blockquote>${t}</blockquote>`;
      }).join("\n");
    }

    // === PHASE 4: RESTORE PROTECTED CONTENT ===
    work = work.replace(/§IC(\d+)§/g, (_, i) => `<code>${this.escape(inlineCodes[Number(i)])}</code>`);
    work = work.replace(/§CB(\d+)§/g, (_, i) => `<pre><code>${this.escape(codeBlocks[Number(i)])}</code></pre>`);
    work = work.replace(/§P(\d+)§/g, (_, i) => {
      const p = promptBlocks[Number(i)];
      return `<b>${this.escape(p.label)}:</b>\n<pre><code>${this.escape(p.content)}</code></pre>`;
    });

    // === PHASE 5: POLISH ===
    if (emojiLevel > 0 && intensity >= 40) {
      work = this.addEmojisToHeadings(work, emojiLevel);
    }
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
