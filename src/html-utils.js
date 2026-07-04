/**
 * src/html-utils.js
 * Safe HTML truncation utilities — v0.6.0
 *
 * Provides closeOpenTags() which robustly closes unclosed HTML tags
 * after truncation. Uses a stack-based approach that handles:
 *   - Nested tags
 *   - Self-closing tags (img, br, hr)
 *   - Tags with attributes (especially <a href="...">)
 *   - Malformed HTML (best-effort)
 */

// Self-closing / void elements that should never appear on the open-stack
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Closes any unclosed HTML tags at the end of a (possibly truncated) string.
 *
 * Algorithm:
 *   1. Scan the string for all tag tokens via regex.
 *   2. Maintain a stack of currently-open tag names.
 *   3. On opening tag: push name (skip void tags).
 *   4. On closing tag: pop matching name from stack (if present).
 *   5. After scan: append closing tags in reverse order of the stack.
 *
 * This correctly handles:
 *   - <a href="https://example.com">link</a>  (attribute tags)
 *   - <b><i>bold italic</i></b>                (nesting)
 *   - <br> <img src="...">                     (void tags ignored)
 *
 * @param {string} html - The HTML string that may have unclosed tags
 * @returns {string} The HTML with all tags properly closed
 *
 * @example
 *   closeOpenTags('<b>hello <i>world')  // → '<b>hello <i>world</i></b>'
 *   closeOpenTags('<a href="x">link')    // → '<a href="x">link</a>'
 *   closeOpenTags('<b>ok</b>')           // → '<b>ok</b>' (no change)
 */
export function closeOpenTags(html) {
  if (!html || typeof html !== "string") return html || "";

  // Regex matches either an opening tag (<tag ...>) or a closing tag (</tag>)
  // Captures: [1] tag name for opening, [2] tag name for closing
  // We use case-insensitive matching and don't validate attributes strictly.
  const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?\/?>/g;

  const stack = [];
  let match;
  while ((match = TAG_RE.exec(html)) !== null) {
    const isClosing = match[1] === "/";
    const tagName = match[2].toLowerCase();

    if (isClosing) {
      // Closing tag: pop matching name from stack (search from top)
      const idx = stack.lastIndexOf(tagName);
      if (idx !== -1) {
        // Remove everything above and including the matched tag
        // (this handles malformed HTML where inner tags weren't closed)
        stack.splice(idx);
      }
    } else {
      // Opening tag
      // Skip void tags (br, img, etc.) — they don't need closing
      if (!VOID_TAGS.has(tagName)) {
        // Check if it's self-closed: <tag ... />
        const fullTag = match[0];
        if (!fullTag.endsWith("/>")) {
          stack.push(tagName);
        }
      }
    }
  }

  // If stack is empty, all tags are properly closed
  if (stack.length === 0) return html;

  // Append closing tags in REVERSE order (innermost first)
  // e.g., stack = ["b", "i", "a"] → append </a></i></b>
  const closingTags = stack
    .slice()
    .reverse()
    .map((tag) => `</${tag}>`)
    .join("");

  return html + closingTags;
}

/**
 * Truncates an HTML string at a safe boundary and closes any open tags.
 *
 * This is a smarter truncation that:
 *   1. Tries to cut at a paragraph boundary (\n\n) within the limit
 *   2. Falls back to a sentence boundary (. ! ? ۔) within 300 chars of the limit
 *   3. Falls back to a newline within 200 chars
 *   4. Avoids cutting inside an HTML tag (between < and >)
 *   5. Closes all unclosed tags via closeOpenTags()
 *
 * @param {string} html - The HTML string to truncate
 * @param {number} maxLen - Maximum length of the result (including suffix)
 * @param {string} [suffix="\n\n<i>…</i>"] - Suffix to append when truncated
 * @returns {string} Truncated HTML with all tags closed
 */
export function truncateHtml(html, maxLen, suffix = "\n\n<i>…</i>") {
  if (!html || html.length <= maxLen) return html || "";
  if (maxLen < 50) return html.slice(0, maxLen); // too small to be smart

  const suffixLen = suffix.length;
  const targetLen = maxLen - suffixLen;
  let cutPoint = targetLen;

  // 1. Try paragraph boundary (\n\n) within 500 chars of target
  const lastPara = html.lastIndexOf("\n\n", cutPoint);
  if (lastPara > cutPoint - 500 && lastPara > 100) {
    cutPoint = lastPara;
  } else {
    // 2. Try sentence boundary (English + Persian) within 300 chars of target
    const lastSentence = Math.max(
      html.lastIndexOf(". ", cutPoint),
      html.lastIndexOf("! ", cutPoint),
      html.lastIndexOf("? ", cutPoint),
      html.lastIndexOf("۔ ", cutPoint), // Persian full stop
      html.lastIndexOf("۔\n", cutPoint),
    );
    if (lastSentence > cutPoint - 300 && lastSentence > 100) {
      cutPoint = lastSentence + 1;
    } else {
      // 3. Try newline within 200 chars of target
      const lastNL = html.lastIndexOf("\n", cutPoint);
      if (lastNL > cutPoint - 200 && lastNL > 100) {
        cutPoint = lastNL;
      }
    }
  }

  // 4. Avoid cutting inside an HTML tag (between < and >)
  const lastGT = html.lastIndexOf(">", cutPoint);
  const lastLT = html.lastIndexOf("<", cutPoint);
  if (lastLT > lastGT) {
    // We're inside a tag — cut before the opening <
    cutPoint = lastLT - 1;
  }

  // v0.5.14: NEVER cut inside a word — walk backwards to nearest space
  // This prevents words like "photorealistic" from becoming "photoreali…"
  if (cutPoint < html.length) {
    const charAtCut = html[cutPoint];
    const charBeforeCut = html[cutPoint - 1];
    // If we're in the middle of a word (both sides are non-space, non-newline)
    if (charAtCut && charBeforeCut && charAtCut !== " " && charAtCut !== "\n" && charBeforeCut !== " " && charBeforeCut !== "\n") {
      const lastSpace = html.lastIndexOf(" ", cutPoint);
      if (lastSpace > cutPoint - 50 && lastSpace > 100) {
        cutPoint = lastSpace;
      }
    }
  }

  // Safety: ensure cutPoint is reasonable
  if (cutPoint < 50) cutPoint = targetLen;

  // 5. Slice and close open tags
  const truncated = html.slice(0, cutPoint) + suffix;
  return closeOpenTags(truncated);
}
