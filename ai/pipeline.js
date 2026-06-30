/**
 * ai/pipeline.js
 * Pipeline definition.
 */

export const PIPELINE = `
═══════════════════════════════════════════════
PIPELINE ARCHITECTURE
═══════════════════════════════════════════════

Incoming Telegram Message
  ↓
Stage 0: Input Parser
  - Extract: text, caption, file_ids, entities, media type, links
  - NEVER edits anything. Only parsing.
  ↓
Stage 1: Content Analyzer
  - Detect: content type, language, rewrite level, complexity, spam probability
  - Output: JSON only
  - NEVER generates post text
  ↓
Stage 2: Content Editor
  - Remove ads, signatures, channel mentions
  - Preserve technical information
  - Improve readability
  - Output: PLAIN TEXT (no HTML, no markdown, no emojis)
  ↓
Stage 3: UI Formatter
  - Split paragraphs, add spacing, headings, lists
  - Wrap commands, links, repositories in HTML tags
  - Choose emojis, create visual hierarchy
  - Append footer
  - NEVER changes meaning. Only appearance.
  ↓
Stage 4: Quality Controller
  - Validate: HTML valid, no broken tags, no nested blockquotes
  - Check: no duplicated footer, links preserved, paragraph sizes OK
  - Auto-repair if possible, else fallback to simpler formatting
  ↓
Stage 5: Telegram Publisher
  - Reuse media file_ids
  - Replace caption
  - Retry on errors
  - Fallback to plain text if HTML fails
  - NEVER lose media. NEVER duplicate messages.
═══════════════════════════════════════════════
`.trim();
