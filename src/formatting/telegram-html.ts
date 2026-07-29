/**
 * src/formatting/telegram-html.ts
 * -----------------------------------------------------------------------------
 * ContentBlock[] → Telegram-compatible HTML.
 *
 * CRITICAL FIX (V1 bug #9): the footer is ALWAYS HTML-escaped before being
 * wrapped in <blockquote>. V1 interpolated the raw footer string, which let
 * any "&", "<", ">" inside it corrupt the markup or inject tags.
 *
 * Task 28 (rewrite-formatting overhaul): Telegram supports both
 * `<blockquote>` and `<blockquote expandable>` (collapsible, Bot API 7.3+).
 * We now wrap:
 *   • paragraph  → spans joined; wrapped in <blockquote> when >200 chars,
 *                  or <blockquote expandable> when >400 chars.
 *   • heading    → <b>🌐 Text</b>\n  (🌐 prefix skipped if heading already
 *                  starts with a pictographic emoji, so AI-emitted "📦 Title"
 *                  headings don't get double-emoji'd)
 *   • code       → <pre><code class="language-xx">escaped</code></pre>.
 *                  SPECIAL: language="prompt" renders as
 *                  <blockquote expandable><pre><code>...</code></pre></blockquote>
 *                  — collapsible AND monospace (copyable). The prompt
 *                  block is produced by cleaner.restorePrompts which wraps
 *                  detected AI/image-gen prompts in a ```prompt fence.
 *   • quote      → <blockquote>spans</blockquote>
 *   • list       • items joined with \n; bullets "• " (unordered) or "1. " (ordered).
 *                  Multi-item unordered → wrapped in <blockquote>.
 *                  Multi-item ordered (step-by-step) → wrapped in
 *                  <blockquote expandable>.
 *   • divider    → skipped (separator line caused visual clutter).
 *   • footer     → appended as <blockquote>escaped footer</blockquote>.
 * -----------------------------------------------------------------------------
 */

import type { ContentBlock, Span } from "../types";

// ============================================================
// escapeHtml
// ============================================================

export function escapeHtml(s: string): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
// shortenUrl — condense long URLs into a compact inline link
// ============================================================

/**
 * Convert a long URL into a short display text while preserving the full URL
 * as the href. Example:
 *   https://chat.z.ai/c/0af503f3-60ee-4dc2-8772-e0e83fb8bb0d
 *   → "chat.z.ai/c/"
 *
 * Rules:
 *   - Strip protocol (https://, http://)
 *   - Strip trailing slash
 *   - If URL has a path, show "domain/first-path-segment/"
 *   - If URL is just domain, show "domain"
 *   - If original URL has query/fragment, append "…"
 */
export function shortenUrl(url: string): string {
  try {
    const u = new URL(url);
    const domain = u.hostname.replace(/^www\./, "");
    const pathParts = u.pathname.split("/").filter(Boolean);

    // Special case: GitHub repo links → "owner/repo" format with 🐙
    if (domain === "github.com" && pathParts.length >= 2) {
      const owner = pathParts[0];
      const repo = pathParts[1];
      // If it's just owner/repo or owner/repo/tree/... → show owner/repo
      return `🐙 ${owner}/${repo}`;
    }

    if (pathParts.length === 0) {
      return domain;
    }

    const firstSeg = pathParts[0];
    let short = `${domain}/${firstSeg}/`;

    if (pathParts.length > 1 || u.search || u.hash) {
      short += "…";
    }

    return short;
  } catch {
    return url.length > 40 ? url.slice(0, 37) + "…" : url;
  }
}

// ============================================================
// renderSpan — recursive
// ============================================================

export function renderSpan(span: Span): string {
  switch (span.kind) {
    case "text":
      return escapeHtml(span.text);
    case "bold":
      return `<b>${span.spans.map(renderSpan).join("")}</b>`;
    case "italic":
      return `<i>${span.spans.map(renderSpan).join("")}</i>`;
    case "underline":
      return `<u>${span.spans.map(renderSpan).join("")}</u>`;
    case "strikethrough":
      return `<s>${span.spans.map(renderSpan).join("")}</s>`;
    case "spoiler":
      return `<span class="tg-spoiler">${span.spans.map(renderSpan).join("")}</span>`;
    case "code":
      return `<code>${escapeHtml(span.code)}</code>`;
    case "link": {
      // If the link has custom text (like [text](url)), preserve the text EXACTLY.
      // Only shorten BARE URLs (where text === url or text is the URL without
      // protocol, e.g. text="github.com/owner/repo" url="https://github.com/owner/repo").
      // Wrap decodeURIComponent in try-catch: a URL containing a literal `%`
      // followed by non-hex chars (e.g. `50%off`, `%ZZ`) throws URIError.
      let decoded = span.url;
      try { decoded = decodeURIComponent(span.url); } catch { /* malformed %, keep raw */ }
      const urlNoProto = span.url.replace(/^https?:\/\//, "");
      const decodedNoProto = decoded.replace(/^https?:\/\//, "");
      const isBareUrl =
        !span.text ||
        span.text === span.url ||
        span.text === decoded ||
        span.text === urlNoProto ||           // "github.com/owner/repo"
        span.text === decodedNoProto ||
        span.url.endsWith(span.text) ||       // text is the tail of the URL
        (span.text.includes("/") && span.url.includes(span.text)); // text is a path segment of the URL
      const linkText = isBareUrl
        ? shortenUrl(span.url)  // Bare URL — shorten for display
        : span.text;            // Custom text — preserve EXACTLY
      return `<a href="${escapeHtml(span.url)}">${escapeHtml(linkText)}</a>`;
    }
    case "mention": {
      if (span.userId !== undefined) {
        return `<a href="tg://user?id=${span.userId}">${escapeHtml(span.text)}</a>`;
      }
      const username = span.text.replace(/^@/, "");
      return `<a href="https://t.me/${username}">${escapeHtml(span.text)}</a>`;
    }
  }
}

// ============================================================
// spanTextLength — total visible text length of a span tree
// ============================================================

/**
 * Sum the visible text length of a span tree. Used to decide whether a
 * paragraph should be wrapped in <blockquote> (>200) or <blockquote
 * expandable> (>400). For `link` spans we count `span.text` (which is the
 * original URL for bare URLs, or the display text for `[text](url)`) — this
 * is intentionally the SOURCE length, not the rendered-shortened length, so
 * long-link paragraphs get wrapped even though their visible rendering is
 * compact.
 */
function spanTextLength(spans: Span[]): number {
  let len = 0;
  for (const s of spans) {
    switch (s.kind) {
      case "text":
        len += s.text.length;
        break;
      case "link":
        len += s.text.length;
        break;
      case "mention":
        len += s.text.length;
        break;
      case "code":
        len += s.code.length;
        break;
      case "bold":
      case "italic":
      case "underline":
      case "strikethrough":
      case "spoiler":
        len += spanTextLength(s.spans);
        break;
    }
  }
  return len;
}

// ============================================================
// blocksToTelegramHtml
// ============================================================

// Detects whether the rendered heading text already starts with a pictographic
// emoji, so we don't double-prefix with 🌐.
const EMOJI_PREFIX_RE = /^\p{Extended_Pictographic}/u;

export function blocksToTelegramHtml(
  blocks: ContentBlock[],
  footer: string,
): string {
  const parts: string[] = [];
  let paragraphIndex = 0; // Track which paragraph we're on (for first-paragraph rule)
  let hasBlockquote = false; // Track if we've added at least one blockquote

  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph": {
        const rendered = block.spans.map(renderSpan).join("");
        const textLen = spanTextLength(block.spans);
        paragraphIndex++;

        // RULE: First paragraph is NEVER quoted
        if (paragraphIndex === 1) {
          parts.push(rendered);
          break;
        }

        // RULE: Only quote SOME paragraphs, not all
        // - Paragraphs that are JUST a link → always quote (also handle
        //   surrounding whitespace-only text spans)
        // - Very long (>400 chars) → collapsible blockquote
        // - Long (>200 chars) → regular blockquote
        // - Medium (>80 chars) → regular blockquote ONLY if we don't have one yet
        // - Short → no quote (just text)
        const isJustLink =
          block.spans.some((s) => s.kind === "link") &&
          block.spans.every(
            (s) => s.kind === "link" || (s.kind === "text" && s.text.trim() === ""),
          );
        if (isJustLink) {
          parts.push(`<blockquote>${rendered}</blockquote>`);
          hasBlockquote = true;
        } else if (textLen > 400) {
          parts.push(`<blockquote expandable>${rendered}</blockquote>`);
          hasBlockquote = true;
        } else if (textLen > 200) {
          parts.push(`<blockquote>${rendered}</blockquote>`);
          hasBlockquote = true;
        } else if (textLen > 80 && !hasBlockquote) {
          parts.push(`<blockquote>${rendered}</blockquote>`);
          hasBlockquote = true;
        } else {
          parts.push(rendered);
        }
        break;
      }

      case "heading": {
        const rendered = block.spans.map(renderSpan).join("");
        const prefix = EMOJI_PREFIX_RE.test(rendered) ? "" : "🌐 ";
        parts.push(`<b>${prefix}${rendered}</b>\n`);
        break;
      }

      case "code": {
        if (block.language === "prompt") {
          // Prompt block: collapsible blockquote + <code> (monospace, copyable)
          // NO <pre> wrapper — user requested mono only, not code-block format.
          // <code> in Telegram is inline monospace (tap-to-copy on mobile).
          // <blockquote expandable> makes it collapsible.
          parts.push(
            `<blockquote expandable><code>${escapeHtml(block.code)}</code></blockquote>`,
          );
          hasBlockquote = true;
        } else {
          const lang = block.language ? escapeHtml(block.language) : "";
          parts.push(
            `<pre><code class="language-${lang}">${escapeHtml(block.code)}</code></pre>`,
          );
        }
        break;
      }

      case "quote":
        // User explicitly used > markdown quote
        parts.push(
          `<blockquote>${block.spans.map(renderSpan).join("")}</blockquote>`,
        );
        hasBlockquote = true;
        break;

      case "list": {
        const items = block.items.map((item, idx) => {
          const rendered = item.map(renderSpan).join("");
          return block.ordered ? `${idx + 1}. ${rendered}` : `• ${rendered}`;
        });
        const inner = items.join("\n");
        const listLen = inner.length;
        // Ordered lists (steps) with >2 items → collapsible if very long
        if (block.ordered && block.items.length > 2 && listLen > 300) {
          parts.push(`<blockquote expandable>${inner}</blockquote>`);
          hasBlockquote = true;
        } else if (block.items.length > 1) {
          // Regular list → blockquote (not collapsible unless very long)
          if (listLen > 400) {
            parts.push(`<blockquote expandable>${inner}</blockquote>`);
          } else {
            parts.push(`<blockquote>${inner}</blockquote>`);
          }
          hasBlockquote = true;
        } else {
          parts.push(inner);
        }
        break;
      }

      case "divider":
        break;
    }
  }

  // Footer — ALWAYS escaped, always with \n spacing before it
  parts.push(`<blockquote>${escapeHtml(footer)}</blockquote>`);

  // Join parts:
  // - Text ending with ":" → next is a quote: single \n (connected, no gap)
  // - Everything else: \n\n (normal paragraph spacing)
  // - Footer: \n (single newline, it's a small blockquote)
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    result.push(parts[i]);
    if (i < parts.length - 1) {
      const currentEndsColon = /[:：]\s*$/.test(parts[i].replace(/<[^>]+>$/g, "").trim());
      const nextIsQuote = parts[i + 1].startsWith("<blockquote>");
      const isFooter = i === parts.length - 2; // last content before footer
      if (currentEndsColon && nextIsQuote) {
        result.push("\n"); // colon → adjacent quote (connected, no gap)
      } else if (isFooter) {
        result.push("\n"); // footer: single newline before it
      } else {
        result.push("\n\n"); // normal spacing between all other parts
      }
    }
  }
  return result.join("");
}
