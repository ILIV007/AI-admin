/**
 * src/formatter.js
 * Pluggable Format Engine.
 *
 * Architecture:
 *   - The AI processing pipeline NEVER calls formatter internals directly.
 *   - It calls `formatPost(text, ctx)` which dispatches to the active engine.
 *   - Engines are registered via `registerEngine()` — you can swap them
 *     at runtime without touching the AI pipeline.
 *
 * Default engines:
 *   - "html"        → legacy Telegram HTML (parse_mode=HTML)
 *   - "markdown"    → Telegram MarkdownV2 (parse_mode=MarkdownV2)
 *   - "plain"       → no formatting, plain text
 *
 * Each engine implements:
 *   {
 *     name: string,
 *     parseMode: "HTML" | "MarkdownV2" | null,
 *     format(text, ctx) -> string,
 *     wrapLink(url) -> string,
 *     wrapFooter(text, footer) -> string,
 *   }
 */

const LINK_REGEX = /https?:\/\/[^\s<>"']+/gi;

// ============================================================
// HTML ENGINE (default — most compatible with Telegram)
// ============================================================
// Improved URL regex: stops at the next "https://" or "http://" so that
// URLs stuck together (e.g. "https://a.comhttps://b.com") are split correctly.
const URL_SPLIT_REGEX = /https?:\/\/(?:(?!https?:\/\/)[^\s<>"'])+/gi;

const htmlEngine = {
  name: "html",
  parseMode: "HTML",

  /** Escape HTML special chars in body text (NOT in URLs we already trust) */
  escape(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },

  wrapLink(url) {
    // Telegram supports <blockquote> natively since 2023
    return `<blockquote>${url}</blockquote>`;
  },

  format(text, ctx = {}) {
    // 1. Protect code blocks (trim leading/trailing newlines inside the fence)
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

    // 3. Escape HTML in the remaining text
    work = this.escape(work);

    // 4. Replace each URL with a blockquote-wrapped link.
    //    Use URL_SPLIT_REGEX which stops at the next "https://" so that
    //    multiple URLs stuck together get split into separate blockquotes.
    work = work.replace(URL_SPLIT_REGEX, (url) => this.wrapLink(url));

    // 5. Restore inline code as <code>...</code>
    work = work.replace(/__INLINE_(\d+)__/g, (_, i) => `<code>${this.escape(inlineCodes[Number(i)])}</code>`);

    // 6. Restore code blocks as <pre><code>...</code></pre>
    work = work.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => `<pre><code>${this.escape(codeBlocks[Number(i)])}</code></pre>`);

    // 7. Convert simple bold (**text** or __text__) to <b>
    work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    work = work.replace(/__([^_]+)__/g, (m, p1) => (m.includes("CODEBLOCK") || m.includes("INLINE") ? m : `<b>${p1}</b>`));

    return work.trim();
  },

  wrapFooter(text, footer) {
    return `${text}\n\n<blockquote>${footer}</blockquote>`;
  },
};

// ============================================================
// RICH MARKDOWN ENGINE (placeholder for future Telegram format)
// ============================================================
// Per spec (PROMPT 4): "Architecture must support both legacy HTML formatting
// and FUTURE Telegram Rich Markdown/Rich Messages formats through a pluggable
// Format Engine."
//
// Telegram's MarkdownV2 does NOT support <blockquote>, so it cannot satisfy
// the spec's "all links in <blockquote>" rule. This engine is therefore a
// PLACEHOLDER — it falls back to HTML behavior until Telegram releases a
// proper Rich Markdown format that supports blockquotes.
//
// To implement a real Rich Markdown engine in the future:
//   1. Write a new engine object with the same interface (name, parseMode,
//      format, wrapLink, wrapFooter).
//   2. Call `registerEngine(myEngine)` at startup.
//   3. Switch the pipeline's `engineName` in src/index.js.
// No other code needs to change — that's the pluggable architecture.
// ============================================================
const richMarkdownEngine = {
  name: "richmarkdown",
  // Use HTML parse mode for now, since Telegram MarkdownV2 doesn't support blockquote.
  // When Telegram adds Rich Markdown with blockquote support, switch this to the new mode.
  parseMode: "HTML",

  escape(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  },

  wrapLink(url) {
    // SPEC COMPLIANCE: all links MUST be in <blockquote> (PROMPT 4 rule 6)
    return `<blockquote>${url}</blockquote>`;
  },

  format(text, ctx = {}) {
    // For now, behave identically to HTML engine.
    // Replace this body with real Rich Markdown logic when the format ships.
    const codeBlocks = [];
    let work = text.replace(/```([\s\S]*?)```/g, (_, code) => {
      codeBlocks.push(code.replace(/^\n+|\n+$/g, ""));
      return `__CODEBLOCK_${codeBlocks.length - 1}__`;
    });

    const inlineCodes = [];
    work = work.replace(/`([^`\n]+)`/g, (_, code) => {
      inlineCodes.push(code);
      return `__INLINE_${inlineCodes.length - 1}__`;
    });

    work = this.escape(work);
    work = work.replace(URL_SPLIT_REGEX, (url) => this.wrapLink(url));
    work = work.replace(/__INLINE_(\d+)__/g, (_, i) => `<code>${this.escape(inlineCodes[Number(i)])}</code>`);
    work = work.replace(/__CODEBLOCK_(\d+)__/g, (_, i) => `<pre><code>${this.escape(codeBlocks[Number(i)])}</code></pre>`);
    work = work.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

    return work.trim();
  },

  wrapFooter(text, footer) {
    return `${text}\n\n<blockquote>${footer}</blockquote>`;
  },
};

// ============================================================
// PLAIN TEXT ENGINE (no formatting — ultimate fallback)
// ============================================================
const plainEngine = {
  name: "plain",
  parseMode: null,

  wrapLink(url) {
    return url;
  },

  format(text, ctx = {}) {
    return text.trim();
  },

  wrapFooter(text, footer) {
    return `${text}\n\n${footer}`;
  },
};

// ============================================================
// REGISTRY
// ============================================================
const REGISTRY = new Map();
REGISTRY.set("html", htmlEngine);                   // default, spec-compliant
REGISTRY.set("richmarkdown", richMarkdownEngine);   // placeholder for future Telegram format
REGISTRY.set("plain", plainEngine);                 // ultimate fallback (no formatting)

/** Register a custom engine (for future Rich Markdown / Rich Messages) */
export function registerEngine(engine) {
  if (!engine?.name || typeof engine.format !== "function") {
    throw new Error("Invalid engine: must have { name, format() }");
  }
  REGISTRY.set(engine.name, engine);
}

/** Get the active engine by name (defaults to html) */
export function getEngine(name = "html") {
  return REGISTRY.get(name) || htmlEngine;
}

// ============================================================
// PUBLIC API — what the pipeline actually calls
// ============================================================

/**
 * Format a final post for publishing.
 * @param {string} text       - cleaned (and possibly rewritten) post text
 * @param {object} ctx        - { footer, engineName, links }
 * @returns {{ text: string, parseMode: string|null }}
 */
export function formatPost(text, ctx = {}) {
  const engine = getEngine(ctx.engineName || "html");
  let formatted = engine.format(text, ctx);

  // Always append the footer (mandatory rule)
  if (ctx.footer) {
    formatted = engine.wrapFooter(formatted, ctx.footer);
  }

  return { text: formatted, parseMode: engine.parseMode };
}

/**
 * Quick helper: detect all URLs in text (used for logging/stats)
 */
export function extractUrls(text) {
  return [...new Set(text.match(URL_SPLIT_REGEX) || [])];
}
