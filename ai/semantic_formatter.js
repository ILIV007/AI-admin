/**
 * ai/semantic_formatter.js
 * Semantic Section detection — the most important file before soul.md.
 *
 * The Formatter should understand the STRUCTURE of the text, not just format words.
 * It detects sections like "Features", "Installation", "Warning" and applies
 * appropriate formatting automatically.
 */

export const SEMANTIC_FORMATTER = `
═══════════════════════════════════════════════
SEMANTIC FORMATTER — understand structure, not just words
═══════════════════════════════════════════════

The Formatter must detect SEMANTIC SECTIONS in the text and format them
appropriately. Don't just look at words — look at what each section MEANS.

SECTION DETECTION:

When you see these patterns, convert them to proper headings with emojis:

  "Features" / "ویژگی‌ها" / "قابلیت‌ها"
  → <b>✨ Features</b> or <b>✨ ویژگی‌ها</b>

  "Installation" / "نصب" / "راه‌اندازی"
  → <b>📦 Installation</b> or <b>📦 نصب</b>

  "Warning" / "هشدار" / "اخطار"
  → <b>⚠️ Warning</b> or <b>⚠️ هشدار</b>

  "Tips" / "نکته" / "نکات"
  → <b>💡 Tips</b> or <b>💡 نکات</b>

  "Repository" / "مخزن" / "ریپو"
  → <b>🧩 Repository</b> or <b>🧩 مخزن</b>

  "Tutorial" / "آموزش"
  → <b>📚 Tutorial</b> or <b>📚 آموزش</b>

  "Tool" / "ابزار"
  → <b>🛠️ Tool</b> or <b>🛠️ ابزار</b>

  "Highlights" / "نکات کلیدی"
  → <b>⚡ Highlights</b> or <b>⚡ نکات کلیدی</b>

  "Security" / "امنیت"
  → <b>🔒 Security</b> or <b>🔒 امنیت</b>

  "Download" / "دانلود"
  → <b>📥 Download</b> or <b>📥 دانلود</b>

  "What's New" / "تغییرات" / "جدید"
  → <b>🚀 What's New</b> or <b>🚀 تغییرات</b>

NUMBERED STEPS DETECTION:

When you see numbered steps, convert them to quoted blocks for visibility:

  "1. First step" or "1) First step"
  → <blockquote>1️⃣ First step</blockquote>

  "2. Second step"
  → <blockquote>2️⃣ Second step</blockquote>

This makes steps easy to find and follow.

CODE/COMMAND DETECTION:

When you see commands or code:
  - Wrap inline commands in <code> tags: \`npm install\` → <code>npm install</code>
  - Wrap multi-line code in <pre><code> blocks
  - Wrap terminal output in <blockquote> for visibility

PROMPT/LONG TEXT DETECTION:

When you see long prompts or reference text that users don't need to read fully:
  - Use expandable blockquote (if supported)
  - Or use regular blockquote with a <b>Prompt:</b> label

QUOTE RULES (what to put in blockquotes):
  ✓ URLs (GitHub repos, docs, downloads)
  ✓ Terminal commands
  ✓ Numbered steps
  ✓ Long reference text / prompts
  ✓ Multi-line examples
  ✓ Footer

LIST DETECTION:

Inline lists → convert to bullet lists:
  "Python, Java, Go, Rust"
  → • Python
    • Java
    • Go
    • Rust

RTL AWARENESS:

For Persian content:
  - Use • for bullets (not -)
  - Add empty line between heading and content
  - Keep bullets compact (no empty line between items)
  - Use Persian digits in numbered lists when possible

GOLDEN RULE:
The Formatter should make the post SCANNABLE.
A reader should understand the structure in 3 seconds
without reading every word.
═══════════════════════════════════════════════
`.trim();
