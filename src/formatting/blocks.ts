/**
 * src/formatting/blocks.ts
 * -----------------------------------------------------------------------------
 * Markdown → ContentBlock[] intermediate representation.
 *
 * This is the RICH MARKDOWN feature the user asked for: instead of treating
 * the AI's output as a flat string, we parse it into structured blocks
 * (paragraph / heading / code / quote / list / divider) and inline spans
 * (bold / italic / underline / strikethrough / spoiler / code / link /
 * mention / text). The downstream HTML renderer then emits clean Telegram
 * HTML from this IR — never from raw string manipulation.
 *
 * Supported markdown subset:
 *   • Headings:        "## H2"  /  "### H3"
 *   • Code fences:     ```lang ... ```
 *   • Blockquotes:     "> quote"
 *   • Unordered lists: "- item"  /  "* item"
 *   • Ordered lists:   "1. item"
 *   • Dividers:        "---"
 *   • Otherwise:       paragraph
 *
 * Inline syntax (with nesting — bold can contain italic/links/code):
 *   **bold**  __underline__  *italic*  _italic_
 *   ~~strike~~  ||spoiler||  `code`
 *   [text](url)  @username  http(s)://...
 * -----------------------------------------------------------------------------
 */

import type { ContentBlock, Span } from "../types";

// ============================================================
// markdownToBlocks
// ============================================================

export function markdownToBlocks(md: string): ContentBlock[] {
  if (!md) return [];
  const lines = md.split(/\r?\n/);
  const blocks: ContentBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- Code fence ---
    const fenceMatch = /^```(.*)$/.exec(line);
    if (fenceMatch) {
      const language = fenceMatch[1].trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ``` (or run off the end if missing)
      blocks.push({
        kind: "code",
        language: language || undefined,
        code: codeLines.join("\n"),
      });
      continue;
    }

    // --- Indented code block (4+ spaces or tab) ---
    if (/^(    |\t)/.test(line)) {
      const codeLines: string[] = [];
      while (i < lines.length && /^(    |\t)/.test(lines[i])) {
        // Strip 4 spaces or 1 tab
        codeLines.push(lines[i].replace(/^(    |\t)/, ""));
        i++;
      }
      blocks.push({
        kind: "code",
        code: codeLines.join("\n"),
      });
      continue;
    }

    // --- Heading (only levels 2 and 3) ---
    const headingMatch = /^(#{2,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level: 2 | 3 = headingMatch[1].length === 2 ? 2 : 3;
      blocks.push({
        kind: "heading",
        level,
        spans: parseInlineSpans(headingMatch[2]),
      });
      i++;
      continue;
    }

    // --- Divider (3+ dashes on its own line) ---
    if (/^---+\s*$/.test(line)) {
      blocks.push({ kind: "divider" });
      i++;
      continue;
    }

    // --- Blockquote ---
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({
        kind: "quote",
        spans: parseInlineSpans(quoteLines.join("\n")),
      });
      continue;
    }

    // --- Unordered list ---
    if (/^[-*]\s+/.test(line)) {
      const items: Span[][] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(parseInlineSpans(lines[i].replace(/^[-*]\s+/, "")));
        i++;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    // --- Ordered list ---
    if (/^\d+\.\s+/.test(line)) {
      const items: Span[][] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(parseInlineSpans(lines[i].replace(/^\d+\.\s+/, "")));
        i++;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    // --- Blank line: skip ---
    if (line.trim() === "") {
      i++;
      continue;
    }

    // --- Paragraph: accumulate consecutive non-special lines ---
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^```/.test(lines[i]) &&
      !/^#{2,3}\s+/.test(lines[i]) &&
      !/^---+\s*$/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({
        kind: "paragraph",
        spans: parseInlineSpans(paraLines.join("\n")),
      });
    }
  }

  return blocks;
}

// ============================================================
// parseInlineSpans — recursive descent inline parser
// ============================================================

export function parseInlineSpans(text: string): Span[] {
  if (!text) return [];
  return parseInlineInner(text);
}

function parseInlineInner(text: string): Span[] {
  const spans: Span[] = [];
  let buffer = "";
  let i = 0;

  const flush = (): void => {
    if (buffer) {
      spans.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    // Inline code (highest precedence — its content is opaque).
    if (text[i] === "`") {
      const close = text.indexOf("`", i + 1);
      if (close > i) {
        flush();
        spans.push({ kind: "code", code: text.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }

    // Bold (**...**) — check BEFORE italic.
    if (text.startsWith("**", i)) {
      let close = text.indexOf("**", i + 2);
      if (close > i + 2) {
        // Smart close: when the bold content contains an odd number of `*`
        // chars (an unbalanced single-`*` italic opener) AND another `*`
        // immediately follows the candidate close, advance the close by one
        // position so that trailing `*` becomes part of the content (where
        // it closes the inner italic).
        //
        // Examples:
        //   `**bold *and italic***` → content "bold *and italic*" (italic closes inside)
        //   `***bold italic***`     → content "*bold italic*"   (whole thing is italic-in-bold)
        //   `**bold***italic*`      → content "bold"            (no advance; trailing `*` starts a new italic)
        if (text[close + 2] === "*") {
          const inner = text.slice(i + 2, close);
          const starCount = (inner.match(/\*/g) || []).length;
          if (starCount % 2 === 1) {
            close += 1;
          }
        }
        flush();
        spans.push({
          kind: "bold",
          spans: parseInlineInner(text.slice(i + 2, close)),
        });
        i = close + 2;
        continue;
      }
    }

    // Underline (__...__) — check BEFORE italic.
    if (text.startsWith("__", i)) {
      const close = text.indexOf("__", i + 2);
      if (close > i + 2) {
        flush();
        spans.push({
          kind: "underline",
          spans: parseInlineInner(text.slice(i + 2, close)),
        });
        i = close + 2;
        continue;
      }
    }

    // Spoiler (||...||)
    if (text.startsWith("||", i)) {
      const close = text.indexOf("||", i + 2);
      if (close > i + 2) {
        flush();
        spans.push({
          kind: "spoiler",
          spans: parseInlineInner(text.slice(i + 2, close)),
        });
        i = close + 2;
        continue;
      }
    }

    // Strikethrough (~~...~~)
    if (text.startsWith("~~", i)) {
      const close = text.indexOf("~~", i + 2);
      if (close > i + 2) {
        flush();
        spans.push({
          kind: "strikethrough",
          spans: parseInlineInner(text.slice(i + 2, close)),
        });
        i = close + 2;
        continue;
      }
    }

    // Italic *...*
    if (text[i] === "*") {
      const close = text.indexOf("*", i + 1);
      if (close > i + 1) {
        flush();
        spans.push({
          kind: "italic",
          spans: parseInlineInner(text.slice(i + 1, close)),
        });
        i = close + 1;
        continue;
      }
    }

    // Italic _..._
    if (text[i] === "_") {
      const close = text.indexOf("_", i + 1);
      if (close > i + 1) {
        flush();
        spans.push({
          kind: "italic",
          spans: parseInlineInner(text.slice(i + 1, close)),
        });
        i = close + 1;
        continue;
      }
    }

    // Link [text](url)
    if (text[i] === "[") {
      const closeBracket = text.indexOf("]", i + 1);
      if (
        closeBracket > i &&
        closeBracket + 1 < text.length &&
        text[closeBracket + 1] === "("
      ) {
        const closeParen = text.indexOf(")", closeBracket + 2);
        if (closeParen > closeBracket + 1) {
          flush();
          spans.push({
            kind: "link",
            text: text.slice(i + 1, closeBracket),
            url: text.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }

    // Mention @username (3–32 chars after @)
    if (text[i] === "@") {
      const m = /^@[A-Za-z0-9_]{3,32}/.exec(text.slice(i));
      if (m) {
        flush();
        spans.push({ kind: "mention", text: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // Bare URL
    if (text.startsWith("http://", i) || text.startsWith("https://", i)) {
      const m = /^https?:\/\/[^\s<>"']+/i.exec(text.slice(i));
      if (m) {
        flush();
        spans.push({ kind: "link", text: m[0], url: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // Plain text — accumulate one char at a time.
    buffer += text[i];
    i++;
  }

  flush();
  return spans;
}
