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
 * -----------------------------------------------------------------------------
 */

const NUL = "\u0000";

// Zero-width chars, BOM, soft hyphen, and bidi overrides. These can be used
// to hide payloads or flip text direction; strip them unconditionally.
const ZERO_WIDTH_RE = /[\u200B-\u200F\u202A-\u202E\uFEFF\u00AD]/g;

// Raw HTML tag (open or close). We intentionally do NOT try to preserve any
// of the AI's HTML — we re-render every tag from our own block/span IR.
const HTML_TAG_RE = /<[^>]+>/g;

export function sanitizeAiOutput(text: string): string {
  if (!text) return "";

  // 1. Protect code fences so HTML stripping can't reach their contents.
  const fences: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (m) => {
    fences.push(m);
    return `${NUL}FENCE${fences.length - 1}${NUL}`;
  });

  // 2. Strip raw HTML tags the AI may have emitted.
  text = text.replace(HTML_TAG_RE, "");

  // 3. Restore code fences.
  text = text.replace(
    /\u0000FENCE(\d+)\u0000/g,
    (_, i) => fences[Number(i)] ?? "",
  );

  // 4. Normalize line endings.
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 5. Remove zero-width / bidi / soft-hyphen chars.
  text = text.replace(ZERO_WIDTH_RE, "");

  // 6. Trim trailing spaces on each line.
  text = text.replace(/[ \t]+\n/g, "\n");

  // 7. Collapse 3+ newlines to 2.
  text = text.replace(/\n{3,}/g, "\n\n");

  // 8. Trim overall.
  text = text.trim();

  // 9. Balance code fences: if odd number of ```, append one.
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    text += "\n```";
  }

  return text;
}
