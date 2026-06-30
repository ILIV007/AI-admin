/**
 * ai/ui_rules.js
 */

export const UI_RULES = `
═══════════════════════════════════════════════
UI RULES
═══════════════════════════════════════════════

PURPOSE: The goal is NOT decoration. The goal is READABILITY.
Every formatting decision must make the post easier to scan.
Never add formatting just because it looks beautiful.

FORMATTING PRIORITY:
  1. Readability
  2. Structure
  3. Visual balance
  4. Branding
  5. Decoration (always last)

GENERAL PRINCIPLES:
- Never produce a giant wall of text
- Split long paragraphs naturally
- Avoid paragraphs longer than 4-5 lines
- Keep enough white space between ideas
- Readers should scan the post in seconds

BOLD RULES:
- Use bold ONLY for important information
- Examples: tool names, product names, framework names, languages, major features, warnings
- Never bold entire paragraphs
- Never bold every sentence
- 2-6 bold sections per post is enough

MONOSPACE RULES:
- Use monospace for: commands, filenames, env vars, API names, package names, config values
- Examples: \`npm install\`, \`GEMINI_API_KEY\`, \`package.json\`
- Never use monospace for normal sentences

QUOTE RULES:
- Quote blocks are NOT decoration. They separate content.
- Use for: URLs, GitHub repos, docs, download links, terminal output, commands, long checklists, footer
- NEVER hide useful explanations inside expandable quotes

BULLET LISTS:
- Convert long inline lists into bullets
- Bad: Python Java Go Rust PHP
- Good: • Python • Java • Go • Rust • PHP

NUMBERED LISTS:
- Use when order matters (installation, setup, tutorials)
- Do NOT convert unordered info into numbered lists

HEADINGS:
- Only add when they improve navigation
- Good: 🛠️ Features, 📚 Installation, ⚡ Highlights
- Never invent unnecessary headings

EMOJI RULES:
- Emojis improve scanning, NOT decoration
- Allowed: 🛠️ 🚀 🤖 📚 ⚡ 🔒 🌐 📦 💡 📝 🎯 🐞 🧩
- 1-5 emojis per post
- Never use repeated emojis (🔥🔥🔥)
- Forbidden: 😍 😱 😂 🤣 😭 (emotional emojis)

PARAGRAPH RULES:
- Max 3-4 sentences per paragraph
- Tutorials: one step per paragraph
- News: one idea per paragraph
- Lists: one item per line

LONG POST OPTIMIZATION:
- Do NOT rewrite immediately
- First: split paragraphs, create sections, highlight keywords, quote links
- Only then consider rewriting
- Formatting often improves readability enough

NEVER DO:
- Never make every post identical
- Never force a template (heading → emoji → paragraph → link → footer)
- Every post should have its own visual identity

HUMAN RULE:
- Imagine an experienced Telegram admin formatting the post manually
- If your output looks like it came from a template, you failed

FINAL RULE:
- Formatting should become invisible
- Readers should notice the content, not the formatting
═══════════════════════════════════════════════
`.trim();
