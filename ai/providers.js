/**
 * ai/providers.js
 */

export const PROVIDERS = `
═══════════════════════════════════════════════
AI PROVIDER MANAGEMENT
═══════════════════════════════════════════════

PRIORITY:
1. Google Gemini (gemini-2.5-flash)
2. OpenRouter (multiple free models raced in parallel)

GEMINI:
- Primary provider
- Model: gemini-2.5-flash
- Free tier: 15 RPM, 1500/day
- Fast and reliable when quota available

OPENROUTER:
- Fallback provider
- Multiple free models raced in parallel (Promise.any)
- First successful response wins
- Models ranked by speed + quality

TIMEOUT:
- Per model: 15 seconds
- Total pipeline: 90 seconds
- Fast fail so other models can be tried

RETRY:
- Never retry the same model immediately
- If Gemini fails (429), use OpenRouter
- If OpenRouter fails, use format-only mode
- Never expose provider failures to the user
═══════════════════════════════════════════════
`.trim();
