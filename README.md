# AI Admin V2

A production-ready Telegram channel content management bot built on Cloudflare Workers. Automatically cleans, classifies, AI-rewrites, formats, and publishes posts to your Telegram channel — completely free.

**Current version: v2.15.9**

## Features

- **AI-Powered Rewriting** — Sequential fallback through 12 free AI models (6 Gemini + 6 OpenRouter) with circuit breaker and health caching
- **Rich Markdown → Telegram HTML** — Full support for bold, italic, underline, strikethrough, spoiler, code blocks, inline links, and blockquotes
- **Smart Prompt Detection** — Automatically detects AI/image-generation prompts and wraps them in collapsible monospace blocks
- **Scheduled Posts** — Fixed daily time slots in Asia/Tehran timezone with random distribution (max 8 slots/day)
- **Approval Mode** — Preview with Publish/Reject buttons before publishing
- **Channel Editing** — Edit published channel posts in place (no time limit for channel posts; bots can edit their own channel messages indefinitely)
- **Multi-Admin Roles** — Owner, Editor, Reviewer, Viewer with atomic permissions
- **Media Group Support** — Album aggregation with race-condition-free finalization + chat type preservation
- **URL Preservation** — Links are preserved exactly; bare URLs are shortened; GitHub links get `🐙 owner/repo` format
- **RTL Support** — Persian paragraphs get RLM marks; half-spaces (نیم‌فاصله, U+200C) are preserved through the entire pipeline
- **Zero Runtime Dependencies** — Pure TypeScript, runs entirely on Cloudflare's free tier
- **Resource Optimized** — KV writes stay under 1000/day even at 500+ messages/day

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
3. **AI Rewrite** — Sequential fallback (tries ALL models in chain before cross-provider) with preservation validation
4. **Format** — Markdown → ContentBlock[] → Telegram HTML with safe chunking
5. **Publish** — Direct publish, approval preview, scheduled job, or in-place channel edit

## Quick Start

### Prerequisites
- Cloudflare account (free tier)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Gemini API key from [aistudio.google.com](https://aistudio.google.com)
- OpenRouter API key from [openrouter.ai](https://openrouter.ai/keys)

### Setup

1. **Create Cloudflare resources:**
```bash
npx wrangler d1 create ai-admin
npx wrangler kv:namespace create AI_ADMIN_KV
npx wrangler queues create ai-admin-queue
npx wrangler queues create ai-admin-dlq
```

2. **Update `wrangler.toml`** with the resource IDs from step 1.

3. **Initialize the database:**
```bash
npx wrangler d1 execute ai-admin --remote --file=./schema.sql
```

4. **Set secrets:**
```bash
npx wrangler secret put BOT_TOKEN
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put ADMIN_ID
npx wrangler secret put TARGET_CHANNEL
npx wrangler secret put WEBHOOK_SECRET
```

5. **Deploy:**
```bash
npx wrangler deploy
```

6. **Set the webhook:**
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER>.workers.dev/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22channel_post%22%2C%22edited_channel_post%22%2C%22callback_query%22%5D"
```

## Commands

| Command | Access | Description |
|---------|--------|-------------|
| `/start` | All | Welcome + role info |
| `/menu` | Admin | Main control panel (inline keyboard) |
| `/help` | All | Command list |
| `/settings` | Admin | Settings menu |
| `/schedule` | Admin | Schedule settings (slots, start hour) |
| `/stats` | Admin | Statistics |
| `/resetall` | Owner | Wipe all data (2-step confirm) |
| `/ping` | Admin | Latency check |
| `/version` | Admin | Version info |
| `/health` | Owner | System health |
| `/models` | Admin | AI model health |
| `/addadmin` | Owner | Add admin |
| `/broadcast` | Owner | Broadcast message |
| `/queue` | Owner | Job queue status |

## AI Model Catalog

### Gemini (Primary)
1. `gemini-3.6-flash` (default)
2. `gemini-3.5-flash`
3. `gemini-3.1-flash-lite`
4. `gemini-3-flash`
5. `gemini-2.5-flash` (last resort fallback)
6. `gemini-2.5-flash-lite`

### OpenRouter (Fallback)
1. `nvidia/nemotron-3-ultra-550b-a55b:free` (default)
2. `qwen/qwen3-coder:free`
3. `nvidia/nemotron-3-super-120b-a12b:free`
4. `google/gemma-4-31b-it:free`
5. `openai/gpt-oss-20b:free`
6. `meta-llama/llama-3.3-70b-instruct:free`

## Scheduled Posts System

The scheduler divides the day into N equal time slots starting from a configurable start hour (Asia/Tehran timezone):

- **Posts per day**: 1, 2, 3, 4, 6, or 8 (max 8)
- **Start hour**: 06:00–22:00 Tehran time (configurable)
- **Distribution**: Posts are randomly distributed across available slots
- **Cron**: Every 30 minutes (resource-optimized; posts may publish up to 30 min late)

Example: 4 slots @ 09:00 → 09:00, 15:00, 21:00, 03:00

## Channel Edit System

When an admin edits their source message, the bot edits the corresponding channel post in place:

- **No time limit** — Bots can edit their own channel messages indefinitely (the 48h limit only applies to groups/private chats)
- **`published_posts` table** — Maps source messages to channel messages (stored as TEXT to support both `@username` and numeric IDs)
- **Multi-part handling** — First message edited with full HTML (truncated to 4096 chars); subsequent parts remain as-is
- **Fallback** — If edit fails, a new channel post is created so content is never lost

## Resource Usage (Free Tier — Optimized)

| Resource | Daily Usage (50 msgs) | Free Tier Limit | Utilization |
|----------|----------------------|-----------------|-------------|
| Workers requests | ~168 | 100,000 | 0.17% |
| D1 reads | ~250 | 5,000,000 | 0.005% |
| D1 writes | ~100 | 100,000 | 0.1% |
| KV reads | ~266 | 100,000 | 0.27% |
| KV writes | ~50 | 1,000 | 5% |
| Queue operations | ~114 | 10,000 | 1.1% |
| Cron triggers | 48 | 5 | ✅ (1 cron, 48 runs) |
| AI API calls | ~72 | 1,500 (Gemini) | 4.8% |

### Optimization Highlights (v2.9.6+)
- `ensureOwnerExists` cached in KV for 24h (saves ~50 D1 reads/day)
- Health write skipped when model is already healthy (saves ~45 KV writes/day)
- Stats batched into single multi-field UPDATE (saves ~500 D1 writes/day)
- History records pruned after 30 days (prevents unbounded D1 growth)
- Health refresh reduced to once per day (saves 36 AI calls/day)
- Ping requests use minimal direct fetch (~10 tokens vs ~2000)
- Negative auth cache TTL increased to 1 hour (90% reduction in spam scenarios)
- `claimUpdate` combines isSeen + markSeen into 1 D1 op (saves 50 D1 ops/day)

## Tech Stack

- **Runtime**: Cloudflare Workers
- **Language**: TypeScript 5 (strict mode)
- **Database**: Cloudflare D1 (SQLite)
- **Cache**: Cloudflare KV
- **Queue**: Cloudflare Queues with DLQ
- **AI**: Google Gemini + OpenRouter (free tier)
- **Build**: Wrangler 4
- **Dependencies**: Zero runtime

## Version History

- **v2.9.9** — Fixed critical Persian half-space bug (sanitizer was stripping U+200C)
- **v2.9.8** — Restored exact v2.9.3 formatting style
- **v2.9.7** — Formatting style adjustments
- **v2.9.6** — Resource optimization (10 fixes) + scheduler adjustments (8 slots, random distribution, 30-min cron)
- **v2.9.5** — Channel Edit rebuild + Scheduled Posts rewrite (Tehran time slots)
- **v2.9.4** — 9 CRITICAL+HIGH bug fixes (schema, publishing state, 429 retry, etc.)
- **v2.9.3** — Stable formatting baseline

## License

Private — built for the ILIVIR3 Telegram channel.
