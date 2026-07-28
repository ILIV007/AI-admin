/**
 * src/formatting/telegram-html.ts
 * -----------------------------------------------------------------------------
 * ContentBlock[] → Telegram-compatible HTML.
 *
 * CRITICAL FIX (V1 bug #9): the footer is ALWAYS HTML-escaped before being
 * wrapped in <blockquote>. V1 interpolated the raw footer string, which let
 * any "&", "<", ">" inside it corrupt the markup or inject tags.
 *
 * Block rendering rules:
 *   • paragraph  → spans joined, blocks separated by "\n\n"
 *   • heading    → <b>🌐 Text</b>\n  (🌐 prefix skipped if heading already
 *                  starts with a pictographic emoji, so AI-emitted "📦 Title"
 *                  headings don't get double-emoji'd)
 *   • code       → <pre><code class="language-xx">escaped</code></pre>
 *   • quote      → <blockquote>spans</blockquote>
 *   • list       • items joined with \n; bullets "• " (unordered) or "1. " (ordered)
 *   • divider    → "\n─────────\n"
 *   • footer     → appended as <blockquote>escaped footer</blockquote>
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

    if (pathParts.length === 0) {
      // Just domain
      return domain;
    }

    // Show domain + first path segment + trailing slash
    const firstSeg = pathParts[0];
    let short = `${domain}/${firstSeg}/`;

    // If there's more to the URL, indicate truncation
    if (pathParts.length > 1 || u.search || u.hash) {
      short += "…";
    }

    return short;
  } catch {
    // Not a valid URL — return as-is (truncated to 40 chars)
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
    case "link":
      // Shorten long URLs into compact inline links, wrapped in blockquote
      return `<a href="${escapeHtml(span.url)}">${escapeHtml(shortenUrl(span.url))}</a>`;
    case "mention": {
      if (span.userId !== undefined) {
        return `<a href="tg://user?id=${span.userId}">${escapeHtml(span.text)}</a>`;
      }
      const username = span.text.replace(/^@/, "");
      return `<a href="t.me/${username}">${escapeHtml(span.text)}</a>`;
    }
  }
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

  for (const block of blocks) {
    switch (block.kind) {
      case "paragraph":
        parts.push(block.spans.map(renderSpan).join(""));
        break;

      case "heading": {
        const rendered = block.spans.map(renderSpan).join("");
        const prefix = EMOJI_PREFIX_RE.test(rendered) ? "" : "🌐 ";
        parts.push(`<b>${prefix}${rendered}</b>\n`);
        break;
      }

      case "code": {
        const lang = block.language ? escapeHtml(block.language) : "";
        parts.push(
          `<pre><code class="language-${lang}">${escapeHtml(block.code)}</code></pre>`,
        );
        break;
      }

      case "quote":
        parts.push(
          `<blockquote>${block.spans.map(renderSpan).join("")}</blockquote>`,
        );
        break;

      case "list": {
        const items = block.items.map((item, idx) => {
          const rendered = item.map(renderSpan).join("");
          return block.ordered ? `${idx + 1}. ${rendered}` : `• ${rendered}`;
        });
        parts.push(items.join("\n"));
        break;
      }

      case "divider":
        // Removed: separator line caused visual clutter. Use blockquote instead.
        break;
    }
  }

  // Footer — ALWAYS escaped. Fixes V1 injection bug.
  parts.push(`<blockquote>${escapeHtml(footer)}</blockquote>`);

  return parts.join("\n\n");
}
