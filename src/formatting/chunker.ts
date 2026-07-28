/**
 * src/formatting/chunker.ts
 * -----------------------------------------------------------------------------
 * Safe chunking of Telegram HTML by VISIBLE length (not HTML byte length).
 *
 * V1 bug #10: `slice()` was called on the HTML string, splitting tags and
 * entities in half. V1 bug #11: the footer was appended to EVERY chunk,
 * duplicating it across multi-part posts. V2 fixes both:
 *
 *   • Visible length = chars outside HTML tags, with entities counted as 1.
 *   • Splits happen only at block boundaries (paragraph / sentence / word)
 *     that lie OUTSIDE tags and entities.
 *   • Each chunk is tag-balanced via closeOpenTags + reopenTags so an open
 *     <b> at the end of chunk N is reopened at the start of chunk N+1.
 *   • The footer is stripped from the input (if present) and appended ONLY
 *     to the LAST chunk.
 *   • If a single paragraph exceeds maxVisible, it is split at sentence
 *     boundaries (. ! ? ۔), then word boundaries, then hard visible-truncated.
 *
 * Public surface:
 *   • chunkHtml(html, maxVisible, footer) — main entrypoint
 *   • closeOpenTags(html)                 — append closing tags for any open
 *   • reopenTags(closedSuffix)            — produce matching reopen tags
 * -----------------------------------------------------------------------------
 */

import { escapeHtml } from "./telegram-html";

// ============================================================
// Tokenization — split HTML into tag vs text tokens
// ============================================================

type Token =
  | { type: "tag"; html: string }
  | { type: "text"; html: string };

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end < 0) {
        // Unterminated "<..." — treat the rest as text (no tag).
        tokens.push({ type: "text", html: html.slice(i) });
        break;
      }
      tokens.push({ type: "tag", html: html.slice(i, end + 1) });
      i = end + 1;
    } else {
      const next = html.indexOf("<", i);
      if (next < 0) {
        tokens.push({ type: "text", html: html.slice(i) });
        break;
      }
      tokens.push({ type: "text", html: html.slice(i, next) });
      i = next;
    }
  }
  return tokens;
}

// ============================================================
// visibleLength — chars outside tags, entities counted as 1
// ============================================================

export function visibleLength(html: string): number {
  let len = 0;
  let inTag = false;
  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if (ch === "<") {
      inTag = true;
    } else if (ch === ">") {
      inTag = false;
    } else if (!inTag) {
      if (ch === "&") {
        const semi = html.indexOf(";", i);
        if (semi > i && semi < i + 10) {
          // Whole entity counts as 1 visible char.
          len += 1;
          i = semi; // for-loop's i++ moves past the ';'
          continue;
        }
      }
      len += 1;
    }
  }
  return len;
}

// ============================================================
// Tag balance — closeOpenTags / reopenTags
// ============================================================

const VOID_TAGS = new Set([
  "br",
  "img",
  "hr",
  "input",
  "meta",
  "link",
  "area",
  "base",
  "col",
  "embed",
  "source",
  "track",
  "wbr",
]);

/**
 * Scan HTML, return the stack of currently-open non-void tag names
 * (in open order, outermost first).
 */
function computeOpenStack(html: string): string[] {
  const stack: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^>]*)?)\s*(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const full = m[0];
    const name = m[1].toLowerCase();
    const isClose = full.startsWith("</");
    const selfClose = m[3] === "/" || VOID_TAGS.has(name);
    if (isClose) {
      // Pop everything up to and including the matching open tag.
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) {
        stack.length = idx;
      }
    } else if (!selfClose) {
      stack.push(name);
    }
  }
  return stack;
}

/**
 * Append closing tags for any unclosed open tags in the HTML.
 * Closing order is innermost-first (reverse of open order).
 */
export function closeOpenTags(html: string): string {
  const stack = computeOpenStack(html);
  const closingTags = stack
    .slice()
    .reverse()
    .map((t) => `</${t}>`)
    .join("");
  return html + closingTags;
}

/**
 * Given a suffix of closing tags appended by closeOpenTags (e.g. "</i></b>"),
 * produce the matching opening tags for the next chunk (e.g. "<b><i>").
 */
export function reopenTags(closedSuffix: string): string {
  const tags: string[] = [];
  const re = /<\/([a-zA-Z][a-zA-Z0-9]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(closedSuffix)) !== null) {
    tags.push(m[1].toLowerCase());
  }
  // closedSuffix is innermost-first; reopen must be outermost-first.
  return tags.reverse().map((t) => `<${t}>`).join("");
}

// ============================================================
// Visible-boundary cut helpers
// ============================================================

/**
 * Find a safe cut position ≤ maxPos in a text token. Avoids cutting inside an
 * HTML entity, and prefers a word boundary (last space).
 */
function findSafeCut(text: string, maxPos: number): number {
  let pos = maxPos;

  // Don't cut inside an entity (&amp; | &#39; | &lt; | ...).
  const entityStart = text.lastIndexOf("&", pos);
  if (entityStart >= 0) {
    const entityEnd = text.indexOf(";", entityStart);
    if (entityEnd >= pos) {
      pos = entityStart; // cut before the '&'
    }
  }

  // Prefer a word boundary (last whitespace at or before pos).
  const wordCut = text.lastIndexOf(" ", pos);
  if (wordCut > 0) return wordCut;
  // No word boundary — hard cut.
  return Math.max(0, pos);
}

/**
 * Find the last sentence boundary (. ! ? ۔) at or before maxPos.
 * Requires the punctuation to be followed by whitespace or end-of-string so
 * that dots inside URLs ("example.com/page.html") are NOT treated as sentence
 * ends.
 */
function findSentenceBoundary(text: string, maxPos: number): number {
  for (let i = Math.min(maxPos, text.length - 1); i >= 0; i--) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "۔") {
      const nextCh = text[i + 1];
      if (nextCh === undefined || /\s/.test(nextCh)) {
        return i + 1;
      }
    }
  }
  return -1;
}

// ============================================================
// truncateVisible — hard cap a chunk to maxVisible chars
// ============================================================

function truncateVisible(html: string, maxVisible: number): string {
  if (visibleLength(html) <= maxVisible) return html;
  const tokens = tokenize(html);
  const out: string[] = [];
  let vis = 0;
  for (const tok of tokens) {
    if (tok.type === "tag") {
      out.push(tok.html);
      continue;
    }
    const remaining = maxVisible - vis;
    if (remaining <= 0) break;
    if (tok.html.length <= remaining) {
      out.push(tok.html);
      vis += tok.html.length;
    } else {
      const cut = findSafeCut(tok.html, remaining);
      out.push(tok.html.slice(0, cut));
      break;
    }
  }
  return closeOpenTags(out.join(""));
}

// ============================================================
// splitParagraphVisible — split an oversized paragraph
// ============================================================

function splitParagraphVisible(para: string, maxVisible: number): string[] {
  const tokens = tokenize(para);
  const parts: string[] = [];
  let current: string[] = [];
  let currentVis = 0;

  for (const tok of tokens) {
    if (tok.type === "tag") {
      current.push(tok.html);
      continue;
    }
    let remaining = tok.html;
    while (remaining.length > 0) {
      const space = maxVisible - currentVis;
      if (remaining.length <= space) {
        current.push(remaining);
        currentVis += remaining.length;
        remaining = "";
      } else {
        // Try sentence boundary first.
        let cut = findSentenceBoundary(remaining, space);
        if (cut <= 0) cut = findSafeCut(remaining, space);
        if (cut <= 0) cut = Math.max(1, space);
        current.push(remaining.slice(0, cut));
        parts.push(current.join(""));
        current = [];
        currentVis = 0;
        remaining = remaining.slice(cut).replace(/^\s+/, "");
      }
    }
  }
  if (current.length > 0) {
    parts.push(current.join(""));
  }
  return parts;
}

// ============================================================
// Split into paragraphs, treating <pre> and <blockquote> as atomic
// (their contents may contain \n\n that must NOT be split on).
// ============================================================

function splitParagraphsSafe(html: string): string[] {
  const pres: string[] = [];
  const bqs: string[] = [];

  // Task 28: also match <blockquote expandable> (collapsible blockquotes
  // emitted by the renderer for long paragraphs, step-by-step lists, and
  // prompt blocks). Both forms are treated as atomic — their contents may
  // contain \n\n that must NOT be split on.
  let protected_ = html
    .replace(/<pre>[\s\S]*?<\/pre>/g, (m) => {
      pres.push(m);
      return `\u0000PRE${pres.length - 1}\u0000`;
    })
    .replace(/<blockquote(?:\s+expandable)?>[\s\S]*?<\/blockquote>/g, (m) => {
      bqs.push(m);
      return `\u0000BQ${bqs.length - 1}\u0000`;
    });

  const parts = protected_
    .split(/\n\n+/)
    .filter((p) => p.trim().length > 0);

  // Task 28: restore BQ FIRST, then PRE. Reason: BQ placeholders may
  // contain PRE placeholders (e.g. prompt blocks render as
  // <blockquote expandable><pre><code>...</code></pre></blockquote>, and
  // the protection pass already replaced the inner <pre>...</pre> with a
  // \u0000PRE_N\u0000 placeholder BEFORE wrapping the outer BQ). Doing PRE
  // first would leave the PRE placeholder stranded inside the restored BQ.
  return parts.map(
    (p) =>
      p
        .replace(/\u0000BQ(\d+)\u0000/g, (_, i) => bqs[Number(i)] ?? "")
        .replace(/\u0000PRE(\d+)\u0000/g, (_, i) => pres[Number(i)] ?? ""),
  );
}

// ============================================================
// chunkHtml — main entrypoint
// ============================================================

export function chunkHtml(
  html: string,
  maxVisible: number,
  footer: string,
): string[] {
  const footerBlock = footer
    ? `<blockquote>${escapeHtml(footer)}</blockquote>`
    : "";

  // Empty input → just the footer (or empty array if no footer).
  if (!html) {
    return footerBlock ? [footerBlock] : [];
  }

  // Strip the footer from the input if it was already embedded (which is what
  // blocksToTelegramHtml does). The footer is appended ONLY to the last chunk.
  let bodyHtml = html;
  if (footerBlock && html.endsWith(footerBlock)) {
    bodyHtml = html.slice(0, -footerBlock.length).replace(/\s+$/, "");
  }

  const bodyVis = visibleLength(bodyHtml);
  const footerVis = visibleLength(footerBlock);
  const sepVis = bodyVis > 0 && footerBlock ? 2 : 0; // the "\n\n" between body & footer

  // --- Single-chunk fast path ---
  if (bodyVis + sepVis + footerVis <= maxVisible) {
    if (!bodyHtml) return footerBlock ? [footerBlock] : [];
    return [bodyHtml + (footerBlock ? "\n\n" + footerBlock : "")];
  }

  // --- Multi-chunk path ---
  let paragraphs = splitParagraphsSafe(bodyHtml);

  // Further split oversized paragraphs at sentence / word boundaries.
  const finalParagraphs: string[] = [];
  for (const p of paragraphs) {
    if (visibleLength(p) <= maxVisible) {
      finalParagraphs.push(p);
    } else {
      finalParagraphs.push(...splitParagraphVisible(p, maxVisible));
    }
  }
  paragraphs = finalParagraphs;

  // Greedy packing: accumulate paragraphs into chunks while they fit.
  const rawChunks: string[] = [];
  let cur = "";
  let curVis = 0;
  for (const p of paragraphs) {
    const pVis = visibleLength(p);
    const sep = cur ? 2 : 0;
    if (curVis + sep + pVis <= maxVisible) {
      cur = cur ? cur + "\n\n" + p : p;
      curVis += sep + pVis;
    } else {
      if (cur) rawChunks.push(cur);
      cur = p;
      curVis = pVis;
    }
  }
  if (cur) rawChunks.push(cur);

  // Balance tags across chunks: prepend reopen tags, append close tags.
  const balancedChunks: string[] = [];
  let reopen = "";
  for (const raw of rawChunks) {
    const prefixed = reopen + raw;
    let safe = prefixed;
    if (visibleLength(safe) > maxVisible) {
      safe = truncateVisible(safe, maxVisible);
    }
    const closed = closeOpenTags(safe);
    const addedSuffix = closed.slice(safe.length);
    balancedChunks.push(closed);
    reopen = reopenTags(addedSuffix);
  }

  // Append the footer ONLY to the LAST chunk. Fixes V1 double-footer bug.
  const lastIdx = balancedChunks.length - 1;
  if (lastIdx >= 0) {
    balancedChunks[lastIdx] = balancedChunks[lastIdx] + (footerBlock ? "\n\n" + footerBlock : "");
  } else if (footerBlock) {
    balancedChunks.push(footerBlock);
  }

  return balancedChunks;
}
