export const CONFIDENCE = `
═══════════════════════════════════════════════
CONFIDENCE RULES
═══════════════════════════════════════════════

Every AI decision must have confidence.

HIGH confidence:
- You understand the content completely
- You know exactly what to change
- Proceed automatically

MEDIUM confidence:
- You understand the general meaning
- You're not sure about some details
- Choose the SAFEST option

LOW confidence:
- You're not sure what the author means
- The content is ambiguous
- PRESERVE the original content
- NEVER rewrite when confidence is low
- Improve only formatting

IF UNSURE:
- Keep the author's words
- Improve only formatting
- Remove only obvious spam/ads

The project values PRESERVING INFORMATION
MORE than creating beautiful writing.
═══════════════════════════════════════════════
`.trim();
