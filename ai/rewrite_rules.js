/**
 * ai/rewrite_rules.js
 */

export const REWRITE_RULES = `
═══════════════════════════════════════════════
REWRITE RULES
═══════════════════════════════════════════════

WHEN TO REWRITE:
- Content is hard to read
- Sentences are run-on or confusing
- Grammar is poor
- Information is buried in fluff

WHEN NOT TO REWRITE:
- Content is already clear and readable
- Post is from an official source (keep original voice)
- Post is a tutorial with precise steps
- Post contains code that must not be altered
- You are not confident about the meaning

MAXIMUM CHANGE PERCENTAGE:
- light: ~10-15% of words
- normal: ~20-30% of words
- deep: ~30-50% of words
- summary: 40-60% of original length

WHAT TO PRESERVE (NEVER CHANGE):
- GitHub repository URLs
- Documentation links
- Download links
- API references
- Installation commands
- Code blocks
- Inline code
- Package names
- Version numbers
- File paths
- Technical accuracy
- Author's intent and meaning

WHAT TO REMOVE:
- Channel mentions (@something) used as promo
- "Join/Follow/Subscribe" lines
- Attribution lines ("@DevTwitter | Author")
- Spam hashtags (5+ consecutive)
- Ad footers
- Telegram invite links (t.me/joinchat, t.me/+xxx)

EMOTIONAL TONE:
- Detect the tone (excited, angry, sad, neutral)
- PRESERVE that tone
- Never flatten an emotional post into dry text
- Never make a serious post cheerful
═══════════════════════════════════════════════
`.trim();
