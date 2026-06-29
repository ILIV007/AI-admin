# AI Admin v0.5.0

A professional Telegram channel content processing bot built on Cloudflare Workers. Processes, rewrites, formats, and publishes posts with rich formatting support.

## Features

- **Multi-model AI fallback** — Gemini + OpenRouter with parallel racing
- **Rich formatting** — HTML parse mode with modern Telegram features
- **Profile system** — Soul + Style + Rules packages for consistent voice
- **Channel editing** — Auto-edit posts in channels with configurable intensity
- **Media group support** — Process albums with combined captions
- **Debug dashboard** — Web-based monitoring and testing
- **Zero cost** — Uses free AI tiers (Gemini 2.5 Flash, OpenRouter free models)

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Telegram  │────▶│   Worker    │────▶│   AI APIs   │
│   Webhook   │     │  (Pipeline) │     │  (Gemini/   │
└─────────────┘     └─────────────┘     │  OpenRouter) │
                      │                 └─────────────┘
                      │
                      ▼
                 ┌─────────────┐
                 │  Cloudflare │
                 │     KV      │
                 └─────────────┘
```

## Pipeline Stages

1. **Clean** — Remove spam, ads, promo
2. **Classify** — Detect content type (news, tutorial, tool, etc.)
3. **Rewrite** — AI-powered content improvement (optional)
4. **Format** — HTML formatting with emojis, quotes, bold
5. **Publish** — Send to target channel

## Quick Start

### 1. Prerequisites

- Cloudflare account (free)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Gemini API key from [aistudio.google.com](https://aistudio.google.com)
- OpenRouter API key from [openrouter.ai](https://openrouter.ai)

### 2. Setup

```bash
# Install dependencies
npm install

# Set secrets
npx wrangler secret put BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put WEBHOOK_SECRET  # optional
npx wrangler secret put DEBUG_TOKEN     # optional

# Deploy
npx wrangler deploy

# Set webhook
npx wrangler deploy
# Then visit: https://your-worker.workers.dev/webhook/info
```

### 3. Configure

Edit `wrangler.toml`:

```toml
[vars]
ADMIN_ID = "YOUR_TELEGRAM_ID"
TARGET_CHANNEL = "@YOUR_CHANNEL"
FOOTER_TEXT = "🌀 @YOUR_CHANNEL"
```

### 4. Use

Send any post to the bot. It will:
1. Process and format it
2. Show you a preview
3. Publish to your channel

Use `/start` for the admin panel with inline settings.

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `language_mode` | auto / fa / en | auto |
| `rewrite_mode` | none / light / normal / deep / summary | normal |
| `personality_mode` | friendly / professional / technical / news | friendly |
| `edit_intensity` | 0-100% (controls rewrite + formatting) | 60 |
| `emoji_level` | 0-100% (controls emoji density) | 20 |
| `ai_provider` | gemini / openrouter / auto | openrouter |
| `channel_editing_enabled` | Auto-edit channel posts | false |
| `active_profile` | Profile key (or null) | null |

## File Structure

```
ai-admin/
├── src/
│   ├── index.js          # Main worker entry
│   ├── ai.js             # Unified AI client
│   ├── telegram.js       # Telegram API client
│   ├── formatter.js      # HTML formatting engine
│   ├── cleaner.js        # Content cleaning
│   ├── classifier.js     # Content type detection
│   ├── prompts.js        # Dynamic prompt builder
│   ├── kv.js             # Cloudflare KV helpers
│   ├── admin.js          # Admin panel UI
│   └── debug.js          # Debug dashboard
├── ai/
│   ├── knowledge/        # Knowledge base (14 files)
│   ├── profiles/         # Channel profiles
│   └── examples/         # Training examples
├── package.json
├── wrangler.toml
└── README.md
```

## Knowledge Base

The `ai/knowledge/` directory contains 14 specialized rule files:

| File | Purpose |
|------|---------|
| `decision_tree.js` | When to rewrite vs format |
| `confidence.js` | When to trust AI decisions |
| `channel_identity.js` | ILIVIR3 brand voice |
| `rewrite_rules.js` | What to preserve vs remove |
| `language_rules.js` | Language handling |
| `rtl_rules.js` | Persian typography |
| `emoji_rules.js` | Functional vs decorative emojis |
| `vocabulary.js` | Preferred words |
| `mistakes.js` | Common errors to avoid |
| `ui_rules.js` | Formatting principles |
| `formatting_levels.js` | Intensity scale |
| `html_rules.js` | Telegram HTML tags |
| `semantic_formatter.js` | Section detection |
| `attribution_rules.js` | What to remove |

## Debug Dashboard

Visit `https://your-worker.workers.dev/debug?token=YOUR_DEBUG_TOKEN`

Features:
- Real-time status monitoring
- KV read/write testing
- AI model testing (all models in parallel)
- Recent updates/errors log
- Bot info and webhook status

## License

MIT
