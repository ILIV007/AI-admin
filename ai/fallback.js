/**
 * ai/fallback.js
 */

export const FALLBACK = `
═══════════════════════════════════════════════
FALLBACK CHAIN
═══════════════════════════════════════════════

If Gemini fails (429/timeout):
  ↓
Try OpenRouter (all free models in parallel)
  ↓
If OpenRouter fails (all models 429/timeout):
  ↓
Format-only mode (no AI rewrite, just clean + format)
  ↓
If format-only fails (HTML error):
  ↓
Publish plain text (no HTML, just text + footer)
  ↓
If plain text fails:
  ↓
Log error and notify admin

RULES:
- NEVER lose user content
- NEVER stop publishing because AI failed
- ALWAYS append footer (even in plain text mode)
- ALWAYS preserve links (even in plain text mode)
- Reliability > Perfection
═══════════════════════════════════════════════
`.trim();
