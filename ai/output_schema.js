/**
 * ai/output_schema.js
 */

export const OUTPUT_SCHEMA = `
═══════════════════════════════════════════════
OUTPUT SCHEMA
═══════════════════════════════════════════════

The AI must return structured output for each stage.

ANALYZER OUTPUT (JSON):
{
  "content_type": "github|tutorial|news|tool|ai|hardware|other",
  "language": "fa|en|mixed",
  "rewrite_level": "none|light|normal|deep|summary",
  "formatting_level": 0-100,
  "rewrite_required": true|false,
  "summary_required": true|false,
  "confidence": "high|medium|low"
}

EDITOR OUTPUT (plain text):
- Just the edited text
- No JSON, no explanations
- Plain text only (no HTML, no markdown)

FORMATTER OUTPUT (HTML):
- Valid Telegram HTML
- No broken tags
- No nested blockquotes
- Footer appended

QUALITY CONTROLLER OUTPUT:
{
  "valid": true|false,
  "issues": ["list of issues"],
  "repaired_html": "fixed HTML if repairs were made"
}

RULES:
- Always return the expected format
- Never mix formats
- Never add explanations to output
- If you can't produce valid output, return empty string
═══════════════════════════════════════════════
`.trim();
