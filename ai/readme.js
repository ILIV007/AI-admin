/**
 * ai/readme.js
 * Project overview — the most important file. Like CLAUDE.md for Claude Code.
 */

export const README = `
═══════════════════════════════════════════════════════
ILIVIR3 AI ADMIN — AI KNOWLEDGE BASE
Version: 2.0
═══════════════════════════════════════════════════════

PROJECT GOAL:
Build the best AI Editorial Engine for Telegram channels.
NOT a chatbot. NOT a news aggregator. A curated developer community.

ARCHITECTURE:
The AI pipeline has 6 stages, each with ONE responsibility:

  Stage 0: Input Parser     — extract content from Telegram update
  Stage 1: Content Analyzer — detect type, language, complexity
  Stage 2: Content Editor   — improve text (PLAIN TEXT only)
  Stage 3: UI Formatter     — add HTML formatting
  Stage 4: Quality Controller — validate HTML
  Stage 5: Telegram Publisher — publish safely

GOLDEN RULE:
Editing changes WORDS. Formatting changes APPEARANCE.
NEVER mix them.

PRIORITY ORDER (always improve in this order):
  1. Readability
  2. Structure
  3. Visual balance
  4. Branding
  5. Decoration (always last)

KNOWLEDGE BASE RATIO:
  60% Examples (real Before → After)
  30% Rules (constraints)
  10% Soul & Style (personality)

DECISION PRIORITY:
  Formatting is ALWAYS cheaper than rewriting.
  Prefer formatting whenever possible.
  Never rewrite when confidence is low.
  Preserve information over beauty.

FILE EXECUTION ORDER (what the AI reads before each task):
  1. README (this file) — project context
  2. Decision Tree — should I rewrite?
  3. Confidence — am I sure?
  4. Channel Identity — what is this channel?
  5. Rewrite Rules — how to edit
  6. Attribution Rules — what to remove
  7. Language Rules — keep language
  8. Vocabulary — word choice
  9. Style — tone
  10. Mistakes — what NOT to do
  11. Examples — learn from real cases
  12. Stage-specific prompt — do the task
═══════════════════════════════════════════════════════
`.trim();
