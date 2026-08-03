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
 *
 * Task 28 (rewrite-formatting overhaul):
 *   • LINK PRESERVATION: [text](url) is preserved verbatim as a `link` span
 *     with both `text` and `url` intact (never stripped). Bare URLs become
 *     `link` spans where `text` = the full URL (the renderer shortens the
 *     visible text via shortenUrl but keeps the full href). No link ever
 *     leaves this parser as plain text.
 *   • PROMPT BLOCKS: a fenced code block with language "prompt"
 *     (```prompt ... ```) is produced by cleaner.restorePrompts to wrap
 *     detected AI/image-gen prompts. It enters this parser as a normal
 *     `code` block with language="prompt"; the renderer (telegram-html.ts)
 *     recognizes that language and emits
 *     `<blockquote expandable><pre><code>...</code></pre></blockquote>`.
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

    // --- Code fence (``` or ~~~) ---
    // Support both ``` and ~~~ as fence markers (CommonMark spec)
    // Also handle cases where AI emits """ or ''' by mistake
    const fenceMatch = /^(```|~~~|\"\"\"|''')(.*)$/.exec(line);
    if (fenceMatch) {
      const fence = fenceMatch[1]; // the fence marker (```, ~~~, """, ''')
      const language = fenceMatch[2].trim();
      const codeLines: string[] = [];
      i++;
      // Look for matching closing fence
      while (i < lines.length) {
        if (fence === "```" && /^```/.test(lines[i])) break;
        if (fence === "~~~" && /^~~~/.test(lines[i])) break;
        if (fence === '"""' && /^"""/.test(lines[i])) break;
        if (fence === "'''" && /^'''/.test(lines[i])) break;
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or run off the end if missing)
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
    // If heading ends with colon (: or ： or ؟ or ?), auto-quote the next
    // paragraph. This groups heading content visually in a blockquote below.
    const headingMatch = /^(#{2,3})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level: 2 | 3 = headingMatch[1].length === 2 ? 2 : 3;
      const headingText = headingMatch[2];
      blocks.push({
        kind: "heading",
        level,
        spans: parseInlineSpans(headingText),
      });
      i++;

      // Check if heading ends with colon/question → auto-quote next paragraph
      if (/[:：؟?]\s*$/.test(headingText.trim()) && i < lines.length) {
        // Skip blank lines between heading and content
        let peek = i;
        while (peek < lines.length && lines[peek].trim() === "") peek++;
        if (peek < lines.length) {
          const nextTrimmed = lines[peek].trim();
          // Don't auto-quote if next is another heading, list, code fence, or blockquote
          const isSpecial = /^(```|~~~|#{2,3}\s|---+\s*$|>\s?|[-*]\s|\d+\.\s)/.test(nextTrimmed);
          if (!isSpecial && nextTrimmed.length > 0) {
            i = peek;
            const quoteLines: string[] = [];
            while (
              i < lines.length &&
              lines[i].trim() !== "" &&
              !/^```/.test(lines[i]) &&
              !/^#{2,3}\s+/.test(lines[i]) &&
              !/^---+\s*$/.test(lines[i]) &&
              !/^>\s?/.test(lines[i]) &&
              !/^[-*]\s+/.test(lines[i]) &&
              !/^\d+\.\s/.test(lines[i])
            ) {
              quoteLines.push(lines[i]);
              i++;
            }
            if (quoteLines.length > 0) {
              blocks.push({
                kind: "quote",
                spans: parseInlineSpans(quoteLines.join("\n")),
              });
            }
          }
        }
      }
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
      const paraText = paraLines.join("\n");

      blocks.push({
        kind: "paragraph",
        spans: parseInlineSpans(paraText),
      });

      // If paragraph ends with colon/question and next is a URL/link → auto-quote.
      // Heading+colon auto-quoting is handled in the heading parser above (line 114).
      // Regular paragraphs with colon do NOT auto-quote text (only URLs/links).
      if (/[:：؟?]\s*$/.test(paraText.trim()) && i < lines.length) {
        let peek = i;
        while (peek < lines.length && lines[peek].trim() === "") peek++;
        const nextTrimmed = (lines[peek] ?? "").trim();
        const isUrlStart = /^https?:\/\//i.test(nextTrimmed);
        const isMarkdownLink = /^\[.+\]\(https?:\/\/.+\)/.test(nextTrimmed);
        if (isUrlStart || isMarkdownLink) {
          i = peek;
          const quoteLines: string[] = [];
          while (
            i < lines.length &&
            lines[i].trim() !== "" &&
            !/^```/.test(lines[i]) &&
            !/^#{2,3}\s+/.test(lines[i]) &&
            !/^---+\s*$/.test(lines[i]) &&
            !/^>\s?/.test(lines[i]) &&
            !/^[-*]\s+/.test(lines[i]) &&
            !/^\d+\.\s/.test(lines[i])
          ) {
            quoteLines.push(lines[i]);
            i++;
          }
          if (quoteLines.length > 0) {
            blocks.push({
              kind: "quote",
              spans: parseInlineSpans(quoteLines.join("\n")),
            });
          }
        }
      }
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
    // P2-6 fix: backslash escape — \X renders as literal X (no markdown).
    // This lets users write \*not italic\* or \**not bold\** verbatim.
    if (text[i] === "\\" && i + 1 < text.length) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }

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
        // Find the LAST ) on this line (URLs can contain parens like Wikipedia)
        const lineEnd = text.indexOf("\n", closeBracket + 2);
        const searchEnd = lineEnd === -1 ? text.length : lineEnd;
        const closeParen = text.lastIndexOf(")", searchEnd);
        if (closeParen > closeBracket + 1) {
          flush();
          let linkUrl = text.slice(closeBracket + 2, closeParen);
          // FIX: if URL has no protocol, prepend https://
          // Telegram requires absolute URLs in href — relative URLs like
          // "example.com" render as plain text, not clickable links.
          if (linkUrl && !/^https?:\/\//i.test(linkUrl) && !/^tg:\/\//i.test(linkUrl)) {
            linkUrl = `https://${linkUrl}`;
          }
          spans.push({
            kind: "link",
            text: text.slice(i + 1, closeBracket),
            url: linkUrl,
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

    // Bare URL with protocol (http:// or https://)
    if (text.startsWith("http://", i) || text.startsWith("https://", i)) {
      const m = /^https?:\/\/[^\s<>"']+/i.exec(text.slice(i));
      if (m) {
        flush();
        spans.push({ kind: "link", text: m[0], url: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // Bare URL WITHOUT protocol — detect common domains like:
    // example.com, github.com/owner/repo, t.me/channel, etc.
    // This catches URLs the AI writes without https:// prefix.
    // Pattern: domain.tld/path (must have a dot, not start with space/punct)
    if (i === 0 || /[\s\n\(\[\{>]/.test(text[i - 1])) {
      const bareUrlMatch = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s<>"']*)?/i.exec(text.slice(i));
      if (bareUrlMatch) {
        const bareUrl = bareUrlMatch[0];
        // Exclude common false positives:
        // 1. File extensions: .tar.gz, .js, .ts, .json, .html, .css, .py, etc.
        // 2. Version numbers: 1.2.3
        // 3. Persian text ending with period
        const domainPart = bareUrl.split("/")[0];
        const tldMatch = /\.([a-z]{2,})$/i.exec(domainPart);
        if (tldMatch) {
          const tld = tldMatch[1].toLowerCase();
          // Common file extensions that look like TLDs — exclude
          const fileExtensions = new Set([
            "gz", "js", "ts", "py", "rb", "go", "rs", "sh", "md",
            "json", "html", "css", "xml", "yaml", "yml", "toml",
            "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
            "mp3", "mp4", "avi", "mov", "wav", "flac",
            "zip", "rar", "7z", "tar", "deb", "rpm", "dmg", "iso",
            "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
            "txt", "log", "csv", "sql", "db", "sqlite",
          ]);
          // Also exclude if it's all digits (version number like 1.2.3)
          const isAllDigitsOrDots = /^[0-9.]+$/.test(domainPart);

          // Allow short domains like t.me, x.com, etc. if they have a valid TLD
          // and are NOT all digits/dots and NOT a file extension.
          // We removed the vowel check because it excluded valid short domains
          // like "t.me" (t has no vowel).
          if (!fileExtensions.has(tld) && !isAllDigitsOrDots &&
              domainPart.includes(".") && !domainPart.startsWith(".") && !domainPart.endsWith("..")) {
            flush();
            // Store with https:// prefix as the URL, but keep original text
            spans.push({ kind: "link", text: bareUrl, url: `https://${bareUrl}` });
            i += bareUrl.length;
            continue;
          }
        }
      }
    }

    // Plain text — accumulate one char at a time.
    buffer += text[i];
    i++;
  }

  flush();
  return spans;
}
