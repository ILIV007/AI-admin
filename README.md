# 🤖 AI Admin

A intelligent Telegram channel content processing bot built on Cloudflare Workers. Free, serverless, and AI-powered.

## ✨ Features

- **AI-Powered Content Editing** — Rewrites and cleans posts using Gemini & OpenRouter (free tier models)
- **Smart Scheduling** — Native Telegram scheduling with KV cron fallback
- **Approve Mode** — Review posts before publishing with inline buttons
- **Prompt Protection** — AI image prompts (Midjourney, SD) are detected and preserved
- **Collapsible Quotes** — Long prompts wrapped in `<blockquote expandable="true">`
- **RTL Support** — Automatic RTL mark insertion for mixed Persian/English text
- **Media Group Support** — Album buffering with leader election
- **Long Post Handling** — Balanced splitting with reply chain, or AI summary for media
- **Debug Dashboard** — Web UI at `/debug` with test endpoints
- **Stats Batching** — Reduces KV writes with in-memory caching
- **AbortController** — Cancels losing AI requests to save tokens

## 🏗️ Architecture

```
Telegram Update → Webhook → Pipeline → [Clean → AI Rewrite → Format → Publish]
                                                     ↓
                                              [Approve Mode?]
                                              Yes → Preview + Buttons
                                              No  → Auto Publish
```

## 🚀 Quick Start

### Prerequisites
- Cloudflare account (free tier works)
- Telegram Bot Token (from @BotFather)
- Gemini API Key (from aistudio.google.com) — optional
- OpenRouter API Key (from openrouter.ai/keys) — optional

### Setup

1. Clone this repo
2. Install dependencies: `npm install`
3. Set secrets:
   ```bash
   wrangler secret put BOT_TOKEN
   wrangler secret put GEMINI_API_KEY
   wrangler secret put OPENROUTER_API_KEY
   ```
4. Deploy: `wrangler deploy`
5. Set webhook: `https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.workers.dev/webhook`

### Configuration

Edit `wrangler.toml` to configure:
- `ADMIN_ID` — Your Telegram user ID
- `TARGET_CHANNEL` — Channel username (e.g., `@mychannel`)
- `DEFAULT_AI_PROVIDER` — `openrouter` or `gemini`
- `GEMINI_MODEL` — Gemini model to use
- `OPENROUTER_MODEL` — Primary OpenRouter model
- `OPENROUTER_FALLBACK_MODELS` — Comma-separated fallback models

## 📋 Commands

| Command | Description |
|---------|-------------|
| `/start` | Admin panel (settings, scheduling, approve mode) |
| `/footer <text>` | Change footer text |
| `/checkperms` | Check bot permissions in channel |
| `/debug_schedule` | Test scheduling (5 tests) |
| `/test_cron` | Manually trigger cron queue |
| `/test_ai` | Test AI rewrite |
| `/test_format` | Test formatter |
| `/test_clean` | Test prompt protection |
| `/help` | Show all commands |

## 🤖 AI Models

### Gemini (Google Studio)
1. `gemini-3-flash-preview` (primary)
2. `gemini-2.5-flash`
3. `gemini-3.1-flash-lite-preview`
4. `gemini-2.5-flash-lite`
5. `gemini-2.0-flash`

### OpenRouter
1. `meta-llama/llama-3.3-70b-instruct:free`
2. `qwen/qwen3-next-80b-a3b-instruct:free`
3. `google/gemma-4-31b-it:free`
4. `openai/gpt-oss-120b:free`
5. `nousresearch/hermes-3-llama-3.1-405b:free`
6. `nvidia/nemotron-3-ultra-550b-a55b:free`

## 🔧 How It Works

### Content Pipeline
1. **Receive** — Webhook receives Telegram update
2. **Extract** — Text, media, reply context extracted
3. **Clean** — Remove spam, ads, attribution lines
4. **Protect** — AI prompts detected and replaced with placeholders
5. **AI Rewrite** — Parallel race across all providers (AbortController cancels losers)
6. **Restore** — Prompts restored after AI processing
7. **Format** — Markdown → HTML, URLs → links, quotes, RTL marks
8. **Publish** — Send to channel (with scheduling/approve if enabled)

### Scheduling
- **Primary**: Native Telegram `schedule_date` (posts in Scheduled Messages view)
- **Fallback**: KV cron queue (when Telegram silently drops schedule_date)
- **Toggle**: Cron fallback can be turned on/off from admin panel

### Approve Mode
When enabled, the bot sends a preview with "✅ Publish" and "❌ Reject" buttons. The post is only published when the admin clicks Publish.

### Long Post Handling
- **Text posts > 4096 chars**: Split into 2 balanced parts (Part 2 replies to Part 1)
- **Media posts > 1024 chars**: AI summary (can't split photo+caption)
- **If split is unbalanced**: AI summary used instead

## 📊 Debug Dashboard

Visit `/debug?token=DEBUG_TOKEN` to access:
- Bot status & configuration
- KV test
- AI test
- Pipeline tests (cron, AI rewrite, formatter, prompt protection, scheduling)
- Recent updates & errors log

## 📝 License

MIT — Do whatever you want.

---

Built with ❤️ for the ILIVIR3 developer community.
