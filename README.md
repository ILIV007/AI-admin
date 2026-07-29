# AI Admin V2

A production-ready Telegram channel content management bot built on Cloudflare Workers. Automatically cleans, classifies, AI-rewrites, formats, and publishes posts to your Telegram channel — completely free.

## Features

- **AI-Powered Rewriting** — Sequential fallback through 12 free AI models (6 Gemini + 6 OpenRouter) with circuit breaker and health caching
- **Rich Markdown → Telegram HTML** — Full support for bold, italic, underline, strikethrough, spoiler, code blocks, inline links, and blockquotes
- **Smart Prompt Detection** — Automatically detects AI/image-generation prompts and wraps them in collapsible monospace blocks
- **Scheduled Posts** — Cron-based scheduling with per-user queue limits (max 50 pending)
- **Approval Mode** — Preview with Publish/Reject buttons before publishing
- **Channel Editing** — Edit published channel posts in place (48h window)
- **Multi-Admin Roles** — Owner, Editor, Reviewer, Viewer with atomic permissions
- **Media Group Support** — Album aggregation with race-condition-free finalization
- **URL Preservation** — Links are preserved exactly; bare URLs are shortened; GitHub links get `🐙 owner/repo` format
- **RTL Support** — Persian paragraphs get RLM marks for proper Telegram rendering
- **Zero Runtime Dependencies** — Pure TypeScript, runs entirely on Cloudflare's free tier

## Architecture

```
Telegram → Webhook (<50ms) → Queue → Consumer → Pipeline → Channel
                                      ↓
                              D1 (SQLite) + KV (cache)
                                      ↓
                              Cron (every 30min)
```

### Pipeline Flow
1. **Clean** — Remove spam, promo mentions, attribution lines, duplicate footers
2. **Classify** — Rule-based: news, tutorial, release, code, general
3. **AI Rewrite** — Sequential fallback (max 2 attempts) with preservation validation
4. **Format** — Markdown → ContentBlock[] → Telegram HTML with safe chunking
5. **Publish** — Direct publish, approval preview, or scheduled job

## Quick Start

### Prerequisites
- Cloudflare account (free tier)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- [Gemini API key](https://aistudio.google.com/apikey) (free)
- [OpenRouter API key](https://openrouter.ai/keys) (free)

### Installation

```bash
cd AI-admin
bun install
npx wrangler login
```

### Configuration

1. **Create resources**:
```bash
npx wrangler d1 create ai-admin
npx wrangler kv namespace create AI_ADMIN_KV
npx wrangler queues create ai-admin-queue
npx wrangler queues create ai-admin-dlq
```

2. **Update `wrangler.toml`** with the returned IDs

3. **Initialize the database**:
```bash
npx wrangler d1 execute ai-admin --remote --file=./schema.sql
```

4. **Set secrets**:
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
```

5. **Deploy**:
```bash
npx wrangler deploy
```

6. **Set webhook**:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-worker.workers.dev/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22channel_post%22%2C%22edited_channel_post%22%2C%22callback_query%22%5D"
```

7. **Add bot to your channel** as administrator with Post + Edit permissions

8. Send `/menu` to the bot to open the control panel

## Bot Commands

| Command | Permission | Description |
|---------|-----------|-------------|
| `/start` | All | Welcome + onboarding |
| `/help` | All | Help text |
| `/menu` | Admin | Control panel |
| `/settings` | Admin | View settings |
| `/footer` | Owner/Editor | Change footer text |
| `/stats` | Admin | Statistics |
| `/resetall` | Owner | Wipe all data (2-step confirm) |
| `/ping` | Admin | Latency check |
| `/version` | Admin | Version info |
| `/health` | Owner | System health |
| `/models` | Admin | AI model health |
| `/schedule` | Admin | Schedule settings |
| `/addadmin` | Owner | Add admin |
| `/broadcast` | Owner | Broadcast message |

## AI Model Catalog

### Gemini (Primary)
1. `gemini-3.6-flash` (default)
2. `gemini-3.5-flash`
3. `gemini-3.1-flash-lite`
4. `gemini-3-flash`
5. `gemini-2.5-flash`
6. `gemini-2.5-flash-lite`

### OpenRouter (Fallback)
1. `nvidia/nemotron-3-ultra-550b-a55b:free` (default)
2. `qwen/qwen3-coder:free`
3. `nvidia/nemotron-3-super-120b-a12b:free`
4. `google/gemma-4-31b-it:free`
5. `openai/gpt-oss-20b:free`
6. `meta-llama/llama-3.3-70b-instruct:free`

## Resource Usage (Free Tier)

| Resource | Daily Usage | Free Tier Limit |
|----------|------------|-----------------|
| Workers requests | ~100 | 100,000 |
| D1 reads | ~100 | 5,000,000 |
| D1 writes | ~100 | 100,000 |
| KV reads | ~350 | 100,000 |
| KV writes | ~148 | 1,000 |
| Queue operations | ~100 | 10,000 |
| Cron triggers | 48 | 5 |

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript 5 (strict mode)
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Queue**: Cloudflare Queues with DLQ
- **AI**: Google Gemini + OpenRouter (free tier)
- **Build**: Wrangler 4
- **Dependencies**: Zero runtime

## License

Private — built for the ILIVIR3 Telegram channel.
