/**
 * ai/emoji_rules.js
 * Emoji classification: Functional vs Decorative.
 */

export const EMOJI_RULES = `
═══════════════════════════════════════════════
EMOJI RULES — Functional vs Decorative
═══════════════════════════════════════════════

EMOJIS ARE IN TWO CATEGORIES:

1. FUNCTIONAL EMOJIS (navigation aids — KEEP or REGENERATE):
   📚 Tutorial / Documentation
   🛠️ Tool / Setup
   ⚡ Highlights / Fast
   💡 Tip / Idea
   🔒 Security
   🌐 Website / Web
   📦 Package / Install
   🚀 Release / Launch
   🤖 AI / Bot
   📝 Notes
   🎯 Goal / Target
   🐞 Bug / Issue
   🧩 Repository / Component
   ⚠️ Warning / Caution
   ✨ Features
   📥 Download
   🔗 Link
   📊 Stats / Analytics
   🔧 Configure
   ✅ Done / Success

2. DECORATIVE EMOJIS (remove — they reduce readability):
   🔥🔥🔥 (stacked/repeated)
   😍😱😂🤣😭 (emotional)
   🎉🥳🎊 (celebration spam)
   ✨💎🌟💫 (excessive sparkle)
   Any emoji repeated 3+ times
   Any emoji not adding semantic value

RULES:
- Maximum 1 functional emoji every 2-3 paragraphs
- NEVER stack emojis (no 🔥🔥🔥)
- NEVER repeat the same emoji
- NEVER use emotional emojis (😍😱😂)
- Functional emojis improve scanning, not decoration
- If the original post has NO emojis, the formatter MAY add functional ones
- If the original post has decorative emojis, REPLACE them with functional ones
- If the original post has functional emojis, KEEP them as-is

EMOJI PLACEMENT (handled by FORMATTER, not AI):
- The FORMATTER adds emojis before standalone headings (not at start of post)
- The FORMATTER strips decorative emojis deterministically
- The AI must NOT add any emojis — only preserve existing functional ones
- NEVER add emojis at the start of the post
- NEVER add emojis in the middle of a sentence

The goal: emojis should help readers SCAN the post,
NOT decorate it. Every emoji must have a PURPOSE.
═══════════════════════════════════════════════
`.trim();
