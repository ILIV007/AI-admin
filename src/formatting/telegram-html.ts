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
 * Current rendering rules (synced v2.15.6 — previous header was stale):
 *   • paragraph  → first paragraph NEVER quoted (unless it's just a link).
 *                  Just-a-link → always <blockquote> (or expandable if >200).
 *                  Other paragraphs: >300 chars → expandable; >150 → blockquote;
 *                  >80 (if no blockquote yet) → blockquote; else plain text.
 *   • heading    → <b>Text</b> (plain bold, NO emoji prefix — user requested
 *                  plain text headings).
 *   • code       → <pre><code class="language-xx">escaped</code></pre>.
 *                  SPECIAL: language="prompt" renders as
 *                  <blockquote expandable><code>...</code></blockquote>
 *                  — collapsible AND monospace (copyable).
 *   • quote      → <blockquote>spans</blockquote> (expandable if >300 chars).
 *   • list       → "• " (unordered) or "N. " (ordered) items joined with \n.
 *                  Multi-item → <blockquote> (expandable if >150 chars).
 *                  Single-item >20 chars → <blockquote>. Else plain.
 *   • divider    → skipped (separator line caused visual clutter).
 *   • footer     → appended as <blockquote>escaped footer</blockquote>
 *                  (guarded: skipped if footer is empty/whitespace).
 * -----------------------------------------------------------------------------
 */

import type { ContentBlock, Span } from "../types";

// ============================================================
// escapeHtml / decodeHtmlEntities
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

/**
 * Decode common HTML entities back to their literal characters.
 * Used to NORMALIZE URLs before re-escaping — prevents double-escaping.
 *
 * CRITICAL FIX (v2.15.8): when the AI outputs URLs with `&amp;` (HTML entity
 * encoding for `&`, common in Google Play links like
 * `?id=com.example&amp;hl=fa`), the old code would call escapeHtml on the
 * URL, producing `&amp;amp;` — a double-escaped broken URL. Telegram would
 * then reject the `<a>` tag (invalid href) and show the link text as plain
 * non-clickable text. If the text was inside `<b>`, it appeared BOLD but
 * NOT clickable — exactly the user-reported bug.
 *
 * Now we decode entities FIRST (`&amp;` → `&`), then escapeHtml produces
 * the correct single-escaped `&amp;`.
 */
export function decodeHtmlEntities(s: string): string {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
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
      // CRITICAL FIX (v2.15.8): decode HTML entities in the URL BEFORE
      // re-escaping. This prevents double-escaping: if the AI output
      // contained `&amp;` in the URL (common in Google Play links),
      // escapeHtml would produce `&amp;amp;` — a broken URL that Telegram
      // rejects, causing the link to appear as plain non-clickable text.
      const rawUrl = decodeHtmlEntities(span.url);

      // If the link has custom text (like [text](url)), preserve the text EXACTLY.
      // Only shorten BARE URLs (where text === url or text is the URL without
      // protocol, e.g. text="github.com/owner/repo" url="https://github.com/owner/repo").
      // Wrap decodeURIComponent in try-catch: a URL containing a literal `%`
      // followed by non-hex chars (e.g. `50%off`, `%ZZ`) throws URIError.
      let decoded = rawUrl;
      try { decoded = decodeURIComponent(rawUrl); } catch { /* malformed %, keep raw */ }
      const urlNoProto = rawUrl.replace(/^https?:\/\//, "");
      const decodedNoProto = decoded.replace(/^https?:\/\//, "");
      const isBareUrl =
        !span.text ||
        span.text === span.url ||
        span.text === rawUrl ||
        span.text === decoded ||
        span.text === urlNoProto ||           // "github.com/owner/repo"
        span.text === decodedNoProto ||
        rawUrl.endsWith(span.text) ||         // text is the tail of the URL
        (span.text.includes("/") && rawUrl.includes(span.text)); // text is a path segment of the URL
      const linkText = isBareUrl
        ? shortenUrl(rawUrl)   // Bare URL — shorten for display
        : span.text;           // Custom text — preserve EXACTLY
      return `<a href="${escapeHtml(rawUrl)}">${escapeHtml(linkText)}</a>`;
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

        // RULE: First paragraph is NEVER quoted — EXCEPT if it's a link.
        // Links should ALWAYS be quoted (even as first paragraph) because
        // they look better in a blockquote and the user expects it.
        const hasLink = block.spans.some((s) => s.kind === "link");
        const isJustLink =
          hasLink &&
          block.spans.every(
            (s) => s.kind === "link" || (s.kind === "text" && s.text.trim() === ""),
          );
        if (paragraphIndex === 1 && !isJustLink) {
          parts.push(rendered);
          break;
        }

        // RULE: Only quote SOME paragraphs, not all
        // - Paragraphs that are JUST a link → always quote (even first)
        // - Very long (>400 chars) → collapsible blockquote
        // - Long (>200 chars) → regular blockquote
        // - Medium (>80 chars) → regular blockquote ONLY if we don't have one yet
        // - Short → no quote (just text)
        if (isJustLink) {
          if (textLen > 200) {
            parts.push(`<blockquote expandable>${rendered}</blockquote>`);
          } else {
            parts.push(`<blockquote>${rendered}</blockquote>`);
          }
          hasBlockquote = true;
        } else if (textLen > 300) {
          parts.push(`<blockquote expandable>${rendered}</blockquote>`);
          hasBlockquote = true;
        } else if (textLen > 150) {
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
        // No emoji prefix — user requested plain text headings.
        // No trailing \n — the join logic handles spacing between parts.
        parts.push(`<b>${rendered}</b>`);
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
        {
          const quoteText = block.spans.map(renderSpan).join("");
          const quoteLen = spanTextLength(block.spans);
          if (quoteLen > 300) {
            parts.push(`<blockquote expandable>${quoteText}</blockquote>`);
          } else {
            parts.push(`<blockquote>${quoteText}</blockquote>`);
          }
          hasBlockquote = true;
        }
        break;

      case "list": {
        const items = block.items.map((item, idx) => {
          const rendered = item.map(renderSpan).join("");
          return block.ordered ? `${idx + 1}. ${rendered}` : `• ${rendered}`;
        });
        const inner = items.join("\n");
        const listLen = inner.length;
        // ALL multi-item lists are wrapped in <blockquote>.
        // Long lists (>150 chars) → collapsible (expandable).
        // Single-item lists with substance (>20 chars) → quoted.
        if (block.items.length > 1) {
          if (listLen > 150) {
            parts.push(`<blockquote expandable>${inner}</blockquote>`);
          } else {
            parts.push(`<blockquote>${inner}</blockquote>`);
          }
          hasBlockquote = true;
        } else if (listLen > 20) {
          parts.push(`<blockquote>${inner}</blockquote>`);
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

  // Footer — ALWAYS escaped, always with \n spacing before it.
  // Guard against empty/whitespace-only footer to avoid emitting an empty
  // <blockquote></blockquote> which Telegram renders as an ugly empty quote.
  const hasFooter = footer && footer.trim().length > 0;
  if (hasFooter) {
    parts.push(`<blockquote>${escapeHtml(footer)}</blockquote>`);
  }

  // Join parts:
  // - Footer: \n (single newline)
  // - Everything else: \n\n (normal paragraph spacing)
  //
  // CRITICAL FIX: removed the "colon → quote = \n" rule.
  // That rule joined heading+blockquote with \n (no blank line), making them
  // appear as ONE connected unit in Telegram. The user reported:
  // "هدلاین همراه با پاراگراف quote میشه" — heading appears quoted WITH
  // the paragraph because they're on consecutive lines with no gap.
  // Now ALL joins use \n\n (normal paragraph spacing) — heading and
  // blockquote are visually separate (blank line between them).
  const result: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    result.push(parts[i]);
    if (i < parts.length - 1) {
      const isFooter = hasFooter && i === parts.length - 2;
      if (isFooter) {
        result.push("\n"); // footer: single newline
      } else {
        result.push("\n\n"); // normal spacing between ALL parts
      }
    }
  }
  return result.join("");
}
