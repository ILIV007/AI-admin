/**
 * src/telegram/entities.ts
 * -----------------------------------------------------------------------------
 * HTML escaping + Telegram entity helpers.
 *
 * TELEGRAM HTML SUBSET (per official docs). Only these tags/attributes are
 * allowed; anything else is rejected by the API with 400 "can't parse entities":
 *
 *   Tags:        b, i, u, s, code, pre, a, blockquote, tg-emoji
 *   Span forms:  <span class="tg-spoiler">…</span>
 *                <span class="tg-mention">…</span>
 *   Pre forms:   <pre>…</pre>
 *                <pre><code class="language-…">…</code></pre>
 *   Blockquote:  <blockquote>…</blockquote>
 *                <blockquote extendable>…</blockquote>
 *   Anchor:      <a href="https://…">…</a>
 *   Emoji:       <tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>
 *
 * In attribute values (href), the only characters that need escaping are
 * `&` `"` (and `'` for safety). Use escapeForUrl() for those.
 *
 * Visible-length accounting: Telegram counts message length by VISIBLE chars
 * (entities stripped, named entities decoded to one char each). The hard limit
 * is 4096 for text messages, 1024 for media captions. We compute visible length
 * ourselves so we can chunk safely without splitting tags or leaving them open.
 * -----------------------------------------------------------------------------
 */

// ============================================================
// Escaping
// ============================================================

/**
 * Escape `&`, `<`, `>` for safe insertion as TEXT content. Use this on any
 * user-provided or dynamic string BEFORE inserting it between tags.
 *
 * (Quotes are NOT escaped here — they're only dangerous inside attribute
 * values; use escapeForUrl for that.)
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape a string for safe use inside `href="…"`. Applies escapeHtml first
 * (covers `&<>`), then escapes `"` and `'` so an injected quote can't break
 * out of the attribute.
 */
export function escapeForUrl(s: string): string {
  return escapeHtml(s)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
// Visible length
// ============================================================

const NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * Count VISIBLE characters in an HTML string:
 *   - all <...> tags are stripped (zero width),
 *   - the five named entities decode to one char each.
 *
 * This mirrors how Telegram counts message length, so we can size-check
 * chunks before sending.
 */
export function visibleLength(html: string): number {
  // Strip tags first.
  const stripped = html.replace(/<[^>]*>/g, "");
  // Decode the five entities Telegram emits.
  const decoded = stripped.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (m) => NAMED_ENTITIES[m] ?? m,
  );
  return decoded.length;
}

// ============================================================
// Truncation (stack-based)
// ============================================================

/** HTML void elements that never have a closing tag. */
const VOID_ELEMENTS = new Set(["br", "hr", "img", "input", "meta", "link"]);

/**
 * Truncate an HTML fragment so its VISIBLE length is ≤ maxVisible.
 *
 * Properties:
 *   - Never cuts inside a tag (whole tags are copied or skipped as a unit).
 *   - Treats named entities (&amp; etc.) as a single visible char, copied verbatim.
 *   - Tracks a stack of open tags; on truncation, emits closing tags in LIFO
 *     order so the returned fragment is well-formed.
 *   - Void elements (br, hr, …) do not affect the stack.
 *
 * If the input already fits, it is returned unchanged.
 */
export function truncateVisible(html: string, maxVisible: number): string {
  if (maxVisible <= 0) return "";
  if (visibleLength(html) <= maxVisible) return html;

  let out = "";
  let visible = 0;
  const stack: string[] = []; // open tag names, LIFO
  let i = 0;
  const n = html.length;

  while (i < n) {
    const ch = html[i];

    // --- Tag: copy whole, maintain stack. ---
    if (ch === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) {
        // Unterminated tag — stop here to avoid malformed output.
        break;
      }
      const tagText = html.slice(i, end + 1);
      out += tagText;
      i = end + 1;

      // Parse tag name and whether it's closing / self-closing.
      const m = tagText.match(/^<\/?\s*([a-zA-Z0-9-]+)/);
      if (m) {
        const name = m[1].toLowerCase();
        const isClosing = /^<\//.test(tagText);
        const isSelfClosing = /\/\s*>$/.test(tagText);

        if (VOID_ELEMENTS.has(name)) continue;
        if (isClosing) {
          // Pop the most recent matching open tag (best-effort: tolerate
          // malformed input where tags don't perfectly nest).
          const idx = stack.lastIndexOf(name);
          if (idx !== -1) stack.splice(idx, 1);
        } else if (!isSelfClosing) {
          stack.push(name);
        }
      }
      continue;
    }

    // --- Entity: count as one visible char, copy verbatim. ---
    if (ch === "&") {
      const semi = html.indexOf(";", i);
      // Heuristic: entities are short (&amp; &lt; etc.). Limit lookahead.
      if (semi !== -1 && semi - i <= 8) {
        if (visible >= maxVisible) break;
        out += html.slice(i, semi + 1);
        visible += 1;
        i = semi + 1;
        continue;
      }
      // Lone '&' (shouldn't happen in well-formed HTML, but be safe).
      if (visible >= maxVisible) break;
      out += ch;
      visible += 1;
      i += 1;
      continue;
    }

    // --- Regular visible character. ---
    if (visible >= maxVisible) break;
    out += ch;
    visible += 1;
    i += 1;
  }

  // Close any tags still open at the cut point (LIFO order).
  while (stack.length) {
    const name = stack.pop();
    if (name) out += `</${name}>`;
  }

  return out;
}

// ============================================================
// Inline keyboard builder
// ============================================================

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

/**
 * Build a JSON-encoded `reply_markup` for an inline keyboard.
 *
 * @param rows  Array of rows; each row is an array of buttons.
 *              Telegram allows up to 8 rows; ≤ 1 button per row is typical for
 *              our Publish/Reject-style confirmations, but we don't enforce
 *              layout here.
 * @returns     JSON string suitable to pass as `reply_markup` in sendMessage
 *              and friends.
 */
export function buildInlineKeyboard(
  rows: { text: string; callback_data?: string; url?: string }[][],
): string {
  return JSON.stringify({ inline_keyboard: rows });
}
