/**
 * src/formatting/sanitizer.ts
 * -----------------------------------------------------------------------------
 * Sanitize AI output before it reaches the formatter.
 *
 * The AI is instructed to emit MARKDOWN only. In practice it occasionally
 * emits raw HTML tags (e.g. "<b>") or weird whitespace. We strip the HTML
 * (we control all HTML via blocks.ts), normalize whitespace, kill zero-width
 * and bidi-override characters (anti-injection), and balance code fences.
 *
 * Code fences are extracted to placeholders BEFORE HTML stripping so that
 * any "<" or ">" inside a code block survives intact.
 *
 * CRITICAL: U+200C (ZERO WIDTH NON-JOINER = نیم‌فاصله) is a LEGITIMATE Persian
 * typography character used for compound words (به‌روزرسانی, نمی‌دانم, etc).
 * It must NOT be stripped — doing so causes Persian words to be joined
 * together (به‌طور → بهطور). We only strip zero-width chars that are actual
 * security risks (bidi overrides, BOM, soft hyphen) and zero-width SPACE
 * (U+200B, which is invisible formatting, not a joiner).
 * -----------------------------------------------------------------------------
 */

const NUL = "\u0000";

// Zero-width chars, BOM, soft hyphen, and bidi overrides. These can be used
// to hide payloads or flip text direction; strip them unconditionally.
//
// CRITICAL FIX: U+200C (ZWNJ = نیم‌فاصله) is EXCLUDED from this set.
// It is the Persian half-space character, essential for correct typography.
// Stripping it causes compound words like به‌روزرسانی to become بهروزرسانی.
//
// Characters that ARE stripped (kept IN the strip set):
//   U+200B  zero-width SPACE       (invisible formatting, not a joiner)
//   U+200D  ZWJ                    (rare; mainly emoji sequences — bot is text-only)
//   U+200E  LRM                    (bidi left-to-right mark)
//   U+200F  RLM                    (bidi right-to-left mark)
//   U+202A-U+202E  bidi overrides  (security risk: can flip text direction)
//   U+FEFF  BOM / ZWNBSP           (byte-order mark, invisible)
//   U+00AD  soft hyphen            (invisible, rarely meaningful)
//
// Characters PRESERVED (NOT stripped):
//   U+200C  ZWNJ (نیم‌فاصله)       (Persian half-space — essential typography)
const ZERO_WIDTH_RE = /[\u200B\u200D-\u200F\u202A-\u202E\uFEFF\u00AD]/g;

// Raw HTML tag (open or close). We intentionally do NOT try to preserve any
// of the AI's HTML — we re-render every tag from our own block/span IR.

export function sanitizeAiOutput(text: string): string {
  if (!text) return "";

  // 1. Protect code fences AND inline code so HTML stripping can't reach
  //    their contents. Both ```...``` and `...` may contain < and > chars.
  const fences: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `${NUL}FENCE${fences.length - 1}${NUL}`;
  });
  const inlineCodes: string[] = [];
  text = text.replace(/`[^`\n]+`/g, (m) => {
    inlineCodes.push(m);
    return `${NUL}IC${inlineCodes.length - 1}${NUL}`;
  });

  // 1b. Protect markdown links [text](url) — the URL may contain < or >
  //     which should NOT be stripped.
  const links: string[] = [];
  text = text.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => {
    links.push(m);
    return `${NUL}LINK${links.length - 1}${NUL}`;
  });

  // 2. Strip raw HTML tags the AI may have emitted — but only real HTML tags,
  //    not comparison operators like "x < 5" or "y > 3".
  //    A real HTML tag starts with < followed by a letter or / (e.g. <b>, </i>).
  //    "x < 5" has a space after <, so it won't match.
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, "");

  // 3. Restore markdown links.
  text = text.replace(/\u0000LINK(\d+)\u0000/g, (_, i) => links[Number(i)] ?? "");

  // 4. Restore inline code.
  text = text.replace(/\u0000IC(\d+)\u0000/g, (_, i) => inlineCodes[Number(i)] ?? "");

  // 5. Restore code fences.
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_, i) => fences[Number(i)] ?? "");

  // 6. Normalize line endings.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 7. Remove zero-width / bidi / soft-hyphen chars.
  text = text.replace(ZERO_WIDTH_RE, "");

  // 8. Trim trailing spaces on each line.
  text = text.replace(/[ \t]+\n/g, "\n");

  // 9. Collapse 3+ newlines to 2.
  text = text.replace(/\n{3,}/g, "\n\n");

  // 10. Trim overall.
  text = text.trim();

  // 11. Balance code fences: if odd number of ```, append one.
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    text += "\n```";
  }

  return text;
}
