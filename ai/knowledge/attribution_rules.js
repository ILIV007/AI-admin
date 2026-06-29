export const ATTRIBUTION_RULES = `
═══════════════════════════════════════════════
ATTRIBUTION RULES
═══════════════════════════════════════════════

REMOVE these attributions:
- @DevTwitter | <Author>
- @Linuxor
- via @channelname
- source: @channelname
- Author: <name> (at end of post)
- "Join our channel: @xxx"
- "Follow us: @xxx"
- "Subscribe to: @xxx"
- "For more: @xxx"
- "via Telegram: @xxx"

KEEP these (they are part of technical content):
- @username when it's part of a GitHub repo URL
- @username when it's part of a command (e.g., @npm/install)
- @username when it's the actual content being discussed

REMOVE these promotional patterns:
- t.me/joinchat/...
- t.me/+xxx
- t.me/addstickers/...
- t.me/addemoji/...
- "Click here to join"
- "Limited time offer"
- "Buy now"
- "DM for more"

NEVER remove:
- GitHub repository links
- Documentation links
- Download links
- API references
- Educational content links
═══════════════════════════════════════════════
`.trim();
