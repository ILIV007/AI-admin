export const LANGUAGE_RULES = `
═══════════════════════════════════════════════
LANGUAGE RULES
═══════════════════════════════════════════════

DEFAULT BEHAVIOR (auto mode):
- Detect input language
- Output in the SAME language
- NEVER translate unless explicitly forced

PERSIAN (fa):
- If input is Persian → output MUST be Persian
- Use colloquial Persian (محاوره‌ای), NOT formal (کتابی)
- Like how people actually talk on Telegram
- Preserve Persian script and characters

ENGLISH (en):
- If input is English → output MUST be English
- Use natural, conversational English
- Use contractions (it's, don't, you'll)

MIXED CONTENT:
- If a post has both Persian and English:
  - Keep the primary language
  - Keep technical terms in their original language
  - Don't translate code, commands, or URLs

NEVER:
- Translate from Persian to English (or vice versa) unless forced
- Change the script (Persian to Latin or vice versa)
- Mix languages unnaturally
- Translate technical terms that have a standard form

FORCE MODES:
- "fa" → output in Persian only (translate if needed)
- "en" → output in English only (translate if needed)
- "auto" → keep input language (DEFAULT, never translate)
═══════════════════════════════════════════════
`.trim();
