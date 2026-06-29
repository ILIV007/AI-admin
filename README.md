# 🧠 AI Admin

<div align="center">

**Version 0.4.2**

Telegram channel content processing bot — built on Cloudflare Workers, 100% free.

</div>

## ✨ Features

- 🤖 AI-powered content processing (Gemini + OpenRouter with 15+ models raced in parallel)
- 🧹 Spam/ad removal with technical link preservation
- ✍️ Configurable rewrite levels (None / Light / Normal / Deep / Summary)
- 🎨 Edit Intensity control (0-100%) for UI formatting
- 😀 Emoji level control (0-100%)
- 👤 **Profile System** — Soul + Style + Rules replace individual settings
- 📺 Channel editing (edit posts in-place when enabled)
- 📷 Media group (album) support with leader election
- 🔗 Reply chain context preservation
- 📊 Debug dashboard at `/debug`
- 🔧 Pluggable format engine
- 🌐 Multi-language (auto-detect, force Persian/English)
- ⚡ Pipeline with 90s timeout + AbortController

## 📦 Project Structure

```
ai-admin/
├── src/
│   ├── index.js          # Entry point + pipeline
│   ├── telegram.js       # Telegram Bot API client
│   ├── ai.js             # AI provider management (Gemini + OpenRouter)
│   ├── admin.js          # Admin panel with inline buttons
│   ├── formatter.js      # UI Formatter (Stage 3)
│   ├── cleaner.js        # Content cleaner
│   ├── classifier.js     # Rule-based content classifier
│   ├── kv.js             # KV storage helpers
│   ├── prompts.js        # System prompts
│   └── debug.js          # Debug dashboard
├── ai/
│   ├── index.js          # Knowledge base loader
│   ├── profiles/         # Profile system
│   │   ├── index.js      # Profile registry
│   │   └── ilivir3/      # ILIVIR3 profile
│   │       ├── soul.js   # Personality & identity
│   │       ├── style.js  # Writing style
│   │       └── rules.js  # Inviolable rules
│   ├── examples/         # Before/After examples
│   └── *.js              # Knowledge base rules
├── wrangler.toml
└── package.json
```

## 🚀 Setup

1. Install: `npm install`
2. Login: `npx wrangler login`
3. Set secrets in Cloudflare dashboard
4. Deploy: `npm run deploy`
5. Set webhook: `node scripts/fix-webhook.mjs https://your-worker.workers.dev`

## 🎛️ Admin Panel

Send `/start` to the bot:
- 👤 Profile — Activate/deactivate personality profiles
- 🌐 Language — Auto / Persian / English
- ✍️ Rewrite — None / Light / Normal / Deep / Summary
- 🎨 Intensity — 0-100% (UI formatting only)
- 😀 Emoji Level — 0-100%
- 🎭 Personality — Friendly / Professional / Technical / News
- 📢 Footer — Edit footer text
- 🤖 AI Provider — Gemini / OpenRouter
- 📺 Channel Edit — Toggle in-place editing
- 📊 Stats — Usage statistics

## 📄 License

MIT
