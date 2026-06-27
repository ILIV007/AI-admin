/**
 * ai/decision_tree.js
 */

export const DECISION_TREE = `
═══════════════════════════════════════════════
DECISION TREE — ask these BEFORE editing
═══════════════════════════════════════════════

Q1: Is the content already readable?
  YES → Skip rewriting. Go to formatting.
  NO  → Continue.

Q2: Does the post contain useful technical information?
  YES → Preserve EVERY technical detail.
  NO  → Normal editing allowed.

Q3: Does the post mainly contain GitHub/docs/tutorial/commands?
  YES → Prefer formatting over rewriting.
  NO  → Continue.

Q4: Is the content longer than 8 paragraphs?
  YES → Split. Structure. Then decide if summarization needed.
  NO  → Continue.

Q5: Does the post contain advertisements?
  YES → Remove ads ONLY. Never remove educational links.
  NO  → Continue.

Q6: Would rewriting make the content clearer?
  NO  → Do not rewrite. Improve UI only.
  YES → Continue.

Q7: Can formatting alone solve the readability issue?
  YES → Do not rewrite. Use formatting only.
  NO  → Rewrite carefully.

GOLDEN RULE:
Formatting is always cheaper than rewriting.
Prefer formatting whenever possible.
═══════════════════════════════════════════════
`.trim();
