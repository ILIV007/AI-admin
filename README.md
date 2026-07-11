# AI Admin

- example channel: https://t.me/ILIVIR3


<div align="center">

**Version 0.7.3**

A Telegram channel content-processing bot built on Cloudflare Workers. 100% free, serverless, AI-powered.

[Features](#-features) · [Architecture](#-architecture) · [Setup](#-setup) · [Usage](#-usage) · [Configuration](#-configuration) · [Troubleshooting](#-troubleshooting) · [Changelog](#-changelog)

</div>

---

## Overview

**AI Admin** is a self-hosted Telegram bot that accepts raw posts in private chat, cleans them, rewrites them with AI (Gemini or OpenRouter), formats them with HTML, and publishes them to your channel. It can also edit posts already published in a channel where the bot is an admin.

The entire stack runs on the **Cloudflare Workers free tier** — no servers, no databases, no monthly bill. A busy channel processing 50 posts per day will use less than 10% of the free quota.

### Why this exists

Most Telegram channel admins manually copy-paste content from other channels, strip spam/promo footers, fix formatting, and re-post. AI Admin automates the entire pipeline while preserving the things that matter: GitHub links, code blocks, AI/Midjourney prompts, and the original author's voice.

---

## Features

### Content processing
- Accepts **text, photo, video, document, animation, and album (media group)** posts
- Cleans promotional footers (`🆔 @user`, `@channel | desc`, `....` separator lines) while preserving the bot's own footer
- Removes spam links (Telegram invite links, sticker packs) but preserves technical links (GitHub, docs, npm, arxiv, etc.)
- Strips attribution lines (`via @user`, `source: @user`, `@DevTwitter | Author`)
- Preserves code blocks, AI/Midjourney prompts, and long technical instructions **verbatim**
- Detects language (Persian vs English) automatically and never translates
- Smart long-post handling: balanced split for text posts, AI summarize for media captions
- Persian number → emoji number conversion for English-titled lists (`۱.` → `1️⃣`)

### AI rewrite
- **Gemini** as primary provider (gemini-3-flash-preview, gemini-2.5-flash, etc.)
- **OpenRouter** as fallback (llama-3.3-70b, qwen3-next-80b, gemma-4-31b, gpt-oss-120b, etc.)
- **11 providers race in parallel** via `Promise.any` + `AbortController` — the moment any one succeeds, all others are cancelled (saves tokens)
- Smart fallback ordering: preferred provider's top 2 models first, then the other provider's models, then the rest
- Compact system prompts (under 800 tokens) — keeps API cost low
- `max_tokens` capped at 2500 (still 2× Telegram's 4096-char limit)
- Explicit warnings in logs when API keys are missing (helps diagnose "format-only fallback" issues)

### Admin panel
- Inline-keyboard settings menu (`/menu`) — no command spam
- **8 toggle buttons**: Language, Rewrite mode, Personality, Footer, AI Provider, Schedule, Approve mode, Channel editing
- `/start` shows bot intro to **all users** (admins and non-admins)
- `/menu` shows admin panel (admins only)
- Non-admin users get format-only response (no AI, no publish)
- **Approve mode**: bot sends a preview with ✅ Publish / ❌ Reject buttons before publishing
- **Admin list**: owner can add/remove additional admins (stored in global KV key, so any admin can authorize any user)

### Scheduling
- Native Telegram scheduling via `schedule_date` (posts appear in Telegram's "Scheduled Messages" view)
- Smart interval: respects minimum gap between scheduled posts
- Configurable: delay hours, interval minutes, posts per day
- Permission check before scheduling (verifies bot has `can_post_messages`)
- Verification after scheduling (compares `result.date` with `schedule_date` to detect silent immediate send)

### KV optimization (v0.7.3)
- **Settings cache** (30s TTL) — pipeline calls `getSettings()` 2-3× per request, now only 1 KV read
- **Admin list cache** (60s TTL) — `isAuthorized()` runs on every request, now 0 KV reads after first
- **Last-scheduled cache** (60s TTL) + write-through on set
- **Stats batch threshold** increased 10 → 20 — 2× fewer KV writes
- **Parallel media group operations** — `Promise.all` instead of sequential loops
- Net result: **~60% reduction in KV operations** vs Prime v0.6.11

### Debugging
- Built-in debug dashboard at `/debug` (protected by `DEBUG_TOKEN`)
- Conditional logging: when `DEBUG_MODE=false`, no debug logs are written to KV
- `/debug_schedule` command for testing scheduling with a dummy message
- `/checkperms` command for verifying bot permissions in channel
- Raw request logging, update logging, error logging (all gated by `DEBUG_MODE`)

---

## Architecture

```
┌──────────────┐    webhook    ┌──────────────────────┐
│   Telegram   │ ────────────► │  Cloudflare Worker   │
│   Channel    │ ◄──────────── │  (this code)         │
└──────────────┘   publish     └──────────┬───────────┘
                                          │
                       ┌──────────────────┼──────────────────┐
                       ▼                  ▼                  ▼
                  ┌─────────┐       ┌──────────┐       ┌──────────┐
                  │   KV    │       │  Gemini  │       │OpenRouter│
                  │ (cache) │       │ (primary)│       │(fallback)│
                  └─────────┘       └──────────┘       └──────────┘
```

### Processing pipeline

```
RECEIVE → EXTRACT → CLASSIFY → CLEAN → [REWRITE / SUMMARIZE] → FORMAT → PUBLISH
```

If any step fails, the bot falls back to **format-only** (no AI rewrite, just clean + format + publish). **No post is ever dropped.**

### Project structure

```
ai-admin/
├── VERSION                       # 0.7.3
├── package.json                  # version 0.7.3 + npm scripts
├── wrangler.toml                 # Cloudflare Worker config
├── README.md                     # this file
├── LICENSE                       # MIT
├── ai/
│   ├── profiles/
│   │   ├── index.js
│   │   └── ilivir3/              # ILIVIR3 channel profile
│   │       ├── index.js
│   │       ├── rules.js
│   │       ├── soul.js
│   │       └── style.js
├── scripts/                      # test + utility scripts
└── src/
    ├── index.js                  # entry point + webhook handler
    ├── pipeline.js               # content processing pipelines
    ├── admin.js                  # admin panel + isAuthorized (async)
    ├── kv.js                     # KV helpers (v0.7.3 cached)
    ├── ai.js                     # AI client (11 providers racing)
    ├── cleaner.js                # spam/promo/footer removal
    ├── formatter.js              # HTML formatting engine
    ├── telegram.js               # Telegram Bot API wrapper
    ├── debug.js                  # debug dashboard + logging
    ├── html-utils.js             # HTML tag closer + truncator
    ├── classifier.js             # rule-based + AI classifier
    └── prompts.js                # system prompts
```

---

## Setup

### Prerequisites (all free)

| Service | Where to get | Cost |
|---------|--------------|------|
| Cloudflare account | [dash.cloudflare.com](https://dash.cloudflare.com) | Free |
| Telegram bot | [@BotFather](https://t.me/BotFather) → `/newbot` | Free |
| Telegram channel | Create your own, add bot as admin | Free |
| Gemini API key | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free (1500 req/day) |
| OpenRouter API key | [openrouter.ai/keys](https://openrouter.ai/keys) | Free (fallback) |
| Node.js 18+ | [nodejs.org](https://nodejs.org) | Free |
| Your Telegram user ID | [@userinfobot](https://t.me/userinfobot) | Free |

### Step 1 — Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/ai-admin.git
cd ai-admin
npm install
```

### Step 2 — Login to Cloudflare

```bash
npx wrangler login
```

A browser window opens. Sign in to your Cloudflare account.

### Step 3 — Initial deploy

```bash
npm run deploy
```

Output looks like:

```
Published ai-admin (1.23 sec)
  https://ai-admin.<your-subdomain>.workers.dev
```

Save this URL — you'll need it for the webhook setup.

### Step 4 — Create KV namespace (via dashboard)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com)
2. Left menu: **Storage & Databases → Workers KV**
3. Click **Create a namespace**
4. Name: `ai_admin_settings`
5. Click **Add**

### Step 5 — Bind KV to the Worker (via dashboard)

1. Go to **Workers & Pages**
2. Click the `ai-admin` worker
3. **Settings** tab
4. **Bindings** section → click **Add binding**
5. Choose **KV Namespace**
6. Configure:
   - **Variable name**: `SETTINGS` (exactly, uppercase)
   - **KV namespace**: `ai_admin_settings` (the one from step 4)
7. Click **Save and deploy**

### Step 6 — Add secrets (via dashboard)

Same **Settings** tab, **Variables and Secrets** section. Click **Add** → choose **Secret** (encrypted).

| Secret name | Value | Source |
|-------------|-------|--------|
| `BOT_TOKEN` | `123456:ABC-...` | [@BotFather](https://t.me/BotFather) |
| `GEMINI_API_KEY` | `AIza...` | [aistudio.google.com](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | `sk-or-v1-...` | [openrouter.ai/keys](https://openrouter.ai/keys) |

(Optional) Add `WEBHOOK_SECRET` with a random string like `mySecret123abc` for webhook security.

Click **Save and deploy**.

### Step 7 — Add environment variables (via dashboard)

Same **Variables and Secrets** section, this time choose **Plain text**:

| Variable | Example value | Notes |
|----------|---------------|-------|
| `ADMIN_ID` | `123456789` | Your numeric Telegram ID |
| `TARGET_CHANNEL` | `@your_channel` | Channel username (with `@`) or `-100xxx` numeric ID |
| `FOOTER_TEXT` | `🌀 @ILIVIR3` | Default footer text |
| `DEBUG_MODE` | `false` | Set to `true` to enable debug logs in KV |
| `DEFAULT_AI_PROVIDER` | `gemini` | `gemini` or `openrouter` |
| `GEMINI_MODEL` | `gemini-3-flash-preview` | Primary Gemini model |
| `OPENROUTER_MODEL` | `meta-llama/llama-3.3-70b-instruct:free` | Primary OpenRouter model |
| `OPENROUTER_FALLBACK_MODELS` | `meta-llama/llama-3.3-70b-instruct:free,qwen/qwen3-next-80b-a3b-instruct:free,google/gemma-4-31b-it:free,openai/gpt-oss-120b:free,nousresearch/hermes-3-llama-3.1-405b:free,nvidia/nemotron-3-ultra-550b-a55b:free` | Comma-separated fallback models |

Click **Save and deploy**.

### Step 8 — Set Telegram webhook

Send an HTTP request to Telegram to register your Worker as the webhook:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://ai-admin.<your-subdomain>.workers.dev/webhook",
    "secret_token": "<YOUR_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query", "channel_post"],
    "drop_pending_updates": true
  }'
```

Expected response:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

Verify:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

If `url` is empty or `last_error_message` is present, something is wrong.

### Step 9 — Add the bot to your channel

1. Open your channel
2. **Channel Info → Administrators → Add Admin**
3. Select the bot
4. Grant **Post Messages** permission (required for scheduling and posting)
5. (Optional) Grant **Edit Messages** permission (required for channel-edit feature)

### Step 10 — Test

Send `/start` to the bot in a private chat. You should see the bot intro. Then send `/menu` to open the admin panel:

```
⚙️ AI Admin — Settings

Current configuration:
🌐 Language: auto
✍️ Rewrite: normal
🎭 Personality: friendly
🤖 AI Provider: gemini
📢 Footer: 🌀 @ILIVIR3
🔐 Approve: OFF
📅 Schedule: OFF

[⚙️ Settings] [🧠 AI Mode]
[🌐 Language] [✍️ Rewrite]
[🎭 Personality] [📢 Footer]
[🤖 AI Provider] [📊 Stats]
[🔐 Approve] [📅 Schedule]
[👤 Admins]
```

Now send a test post (text or media) — the bot will process it and publish to your channel.

---

## Usage

### Commands

| Command | Who | Description |
|---------|-----|-------------|
| `/start` | Anyone | Shows bot introduction |
| `/menu` | Admins only | Opens settings panel |
| `/footer <text>` | Admins only | Changes footer text |
| `/checkperms` | Admins only | Verifies bot permissions in channel |
| `/debug_schedule` | Admins only | Tests scheduling with a dummy message |
| `/help` | Anyone | Shows help text |

### Admin panel buttons

| Button | Action |
|--------|--------|
| ⚙️ Settings | Re-display current settings |
| 🧠 AI Mode | Combined preset (Provider + Rewrite) in one click |
| 🌐 Language | Auto / Persian / English |
| ✍️ Rewrite | None / Light / Normal / Summary |
| 🎭 Personality | Friendly / Professional / Technical / News |
| 📢 Footer | Change footer text |
| 🤖 AI Provider | Gemini / OpenRouter |
| 📊 Stats | Processing statistics |
| 🔐 Approve | Toggle approve mode (preview before publish) |
| 📅 Schedule | Toggle scheduling + configure interval |
| 👤 Admins | Add/remove additional admins (owner only) |

### How posts flow

1. **Private chat to bot** → bot processes, publishes to channel, sends feedback
2. **New post in channel** (if bot is admin with edit permission) → bot edits the post in place
3. **Every post goes through**: classify → clean → rewrite (if needed) → format → publish
4. If AI fails → falls back to format-only (never drops the post)
5. If post is too long → text posts get split, media posts get AI-summarized

### Approve mode

When approve mode is ON:
1. Send a post to the bot
2. Bot processes it and sends a **preview** to your private chat
3. Click **✅ Publish** to publish, or **❌ Reject** to discard
4. Preview data is stored in KV with 1-hour TTL

### Scheduling

When scheduling is ON:
1. Send a post to the bot
2. Bot calculates the next scheduled time based on:
   - `schedule_delay_hours` (minimum delay before first post)
   - `schedule_interval_minutes` (gap between scheduled posts)
   - `schedule_posts_per_day` (overrides interval if set)
3. Bot calls Telegram's `sendMessage` with `schedule_date`
4. Post appears in the channel's **Scheduled Messages** view
5. You can edit or delete scheduled posts from there before they auto-publish

**Permission requirements for scheduling:**
- ✅ Post Messages (required)
- ✅ Edit Messages (for channel-edit feature)
- ⚠️ Bot must be an **administrator**, not just a member

To view scheduled posts: open the channel → tap channel name → **Scheduled Messages** (clock icon 🕐)

---

## Configuration

### All environment variables and secrets

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `BOT_TOKEN` | Secret | Yes | — | Telegram bot token from @BotFather |
| `GEMINI_API_KEY` | Secret | Yes* | — | Gemini API key |
| `OPENROUTER_API_KEY` | Secret | Yes* | — | OpenRouter API key |
| `WEBHOOK_SECRET` | Secret | No | — | Random string for webhook security |
| `DEBUG_TOKEN` | Secret | No | — | Protects `/debug` endpoint |
| `ADMIN_ID` | Var | Yes | — | Owner's Telegram user ID |
| `TARGET_CHANNEL` | Var | Yes | — | Channel `@username` or `-100xxx` ID |
| `FOOTER_TEXT` | Var | No | `🌀 @ILIVIR3` | Default footer text |
| `DEBUG_MODE` | Var | No | `false` | Enable debug logs in KV |
| `DEFAULT_AI_PROVIDER` | Var | No | `gemini` | `gemini` or `openrouter` |
| `GEMINI_MODEL` | Var | No | `gemini-3-flash-preview` | Primary Gemini model |
| `OPENROUTER_MODEL` | Var | No | `meta-llama/llama-3.3-70b-instruct:free` | Primary OpenRouter model |
| `OPENROUTER_FALLBACK_MODELS` | Var | No | (see wrangler.toml) | Comma-separated fallback models |

*At least one of `GEMINI_API_KEY` or `OPENROUTER_API_KEY` must be set. Both are recommended for fallback.

### Available AI models

**Gemini (free tier, 1500 req/day):**
- `gemini-3-flash-preview` (newest, recommended)
- `gemini-2.5-flash` (stable)
- `gemini-3.1-flash-lite-preview` (cheapest)
- `gemini-2.5-flash-lite` (cheapest stable)
- `gemini-2.0-flash` (legacy)

**OpenRouter free models:**
- `meta-llama/llama-3.3-70b-instruct:free` (best quality)
- `qwen/qwen3-next-80b-a3b-instruct:free`
- `google/gemma-4-31b-it:free`
- `openai/gpt-oss-120b:free`
- `nousresearch/hermes-3-llama-3.1-405b:free`
- `nvidia/nemotron-3-ultra-550b-a55b:free`

### Settings stored per admin (in KV)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `language_mode` | string | `auto` | `auto` / `fa` / `en` |
| `rewrite_mode` | string | `normal` | `none` / `light` / `normal` / `summary` |
| `personality_mode` | string | `friendly` | `friendly` / `professional` / `technical` / `news` |
| `footer_text` | string | `🌀 @ILIVIR3` | Footer appended to every post |
| `ai_provider` | string | `openrouter` | `gemini` / `openrouter` |
| `channel_editing_enabled` | boolean | `false` | Edit channel posts in place |
| `edit_intensity` | number | `60` | 0-100, how aggressively to edit |
| `emoji_level` | number | `20` | 0-100, emoji density |
| `active_profile` | string\|null | `null` | Active profile name (e.g. `ilivir3`) |
| `scheduling_enabled` | boolean | `false` | Enable native Telegram scheduling |
| `schedule_delay_hours` | number | `24` | Hours to delay before first scheduled post |
| `schedule_interval_minutes` | number | `30` | Minutes between scheduled posts |
| `schedule_posts_per_day` | number | `0` | If >0, overrides interval (1440/ppd) |
| `admin_list` | array | `[]` | Additional admin user IDs |
| `approve_enabled` | boolean | `false` | Preview before publishing |
| `stats` | object | `{processed:0, rewritten:0, failed:0}` | Processing counters |

---

## Costs

Everything runs on free tiers:

| Service | Free tier | Enough for |
|---------|-----------|------------|
| Cloudflare Workers | 100K requests/day | ~70 posts per minute |
| Cloudflare KV | 100K reads + 1K writes/day | ~1000 posts per day (with v0.7.3 caching: ~3000) |
| Google Gemini | 1500 req/day, 15 RPM | Most channels |
| OpenRouter free models | Unlimited (rate-limited) | Excellent fallback |
| Telegram Bot API | Unlimited | Always free |

A busy channel processing 50 posts per day will use:
- ~30 KV writes, ~50 KV reads (with v0.7.3 caching)
- ~50 AI requests (split between Gemini and OpenRouter)
- ~100 Worker requests

Well under 10% of free tier limits.

---

## Testing

```bash
# All unit tests
npm test

# Specific test suites (in scripts/)
node scripts/test-units.mjs         # cleaner, classifier, formatter
node scripts/test-pipeline.mjs      # integration pipeline
node scripts/test-admin.mjs         # admin panel spec compliance
node scripts/test-media-group.mjs   # album handling
node scripts/test-channel-edit.mjs  # channel edit feature
node scripts/test-timeout.mjs       # timeout handling
```

---

## Troubleshooting

### Bot doesn't respond

```bash
# Check webhook status
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

If `last_error_message` is present, the Worker threw an error. Check logs:

```bash
npm run tail
```

### Posts not published

- Verify the bot is **admin in the channel** with **Post Messages** permission
- `TARGET_CHANNEL` is set correctly (`@username` or `-100xxx`)
- Check the bot's private chat for error messages
- Run `/checkperms` to verify permissions

### AI not working (format-only fallback)

- Verify `GEMINI_API_KEY` is set as a **Secret** (not plain text)
- Verify `OPENROUTER_API_KEY` is set as a **Secret** (recommended for fallback)
- Check `wrangler tail` logs for warnings like `⚠️ OPENROUTER_API_KEY not set`
- Try switching AI Provider in the admin panel
- Free models are sometimes rate-limited — wait a few seconds and retry

### Scheduling sends immediately

- Run `/checkperms` — bot must have **Post Messages** permission
- Bot must be an **administrator** (not just a member)
- Check `wrangler tail` for `[sched]` logs showing the verification step
- Telegram silently sends immediately if the bot lacks Post Messages permission

### "KV not bound" error

Go to dashboard: **Workers & Pages → ai-admin → Settings → Bindings** — verify a binding exists with the exact name `SETTINGS` (uppercase).

### Approve mode preview expired

Preview data is stored in KV with a 1-hour TTL. If you wait too long, you'll see "Post data expired. Please resend." Just send the post again.

### Debug dashboard

Set `DEBUG_TOKEN` as a secret, then visit:

```
https://ai-admin.<your-subdomain>.workers.dev/debug?token=<DEBUG_TOKEN>
```

The dashboard shows: bot info, KV status, AI provider status, recent logs, scheduled posts, and stats.

---

## Security

- Only `ADMIN_ID` (and users in `admin_list`) can access the admin panel
- Non-admin users only see `/start` — all other messages get format-only response
- `WEBHOOK_SECRET` prevents webhook spoofing (optional but recommended)
- All tokens stored as Cloudflare Secrets (encrypted, not in code)
- Never commit `.dev.vars` to git
- `DEBUG_MODE=false` by default — no sensitive data written to KV

---

## Customization

### Adding a new AI provider

In `src/ai.js`, add a new provider function and include it in the `aiComplete` providers list.

### Adding a new formatter engine

In `src/formatter.js`, define a new engine object with `name`, `parseMode`, `format()`, `wrapLink()`, `wrapFooter()` methods, then `registerEngine()` it.

### Adding a channel profile

Create a new folder under `ai/profiles/<name>/` with `index.js`, `rules.js`, `soul.js`, `style.js`. Register it in `ai/profiles/index.js`. Then set `active_profile` in settings.

---

## Changelog

### v0.7.3 (2026-07-05) — Safe KV + AI Token Optimization

**Restarted from user-verified Prime v0.6.11. Applied only the safest optimizations.**

KV optimizations (no behavior changes):
- Added settings cache (30s TTL) — pipeline calls `getSettings()` 2-3× per request, now 1 KV read
- Added admin_list cache (60s TTL) — `isAuthorized()` runs every request, now 0 KV reads after first
- Added last-scheduled-time cache (60s TTL) + write-through on set
- Increased `BATCH_FLUSH_THRESHOLD` from 10 → 20 (2× fewer stats writes)
- Changed `listMediaGroupItems` and `deleteMediaGroup` to use `Promise.all` parallel operations

AI optimizations (no behavior changes):
- Reduced `max_tokens` from 3096 → 2500 (still 2× Telegram's char limit)
- Added explicit warnings when API keys are missing (logging only)

**Bug fixes from previous v0.7.x releases:**
- Removed `truncateInput()` that broke long-post summarization (introduced in v0.7.1)
- Removed Wave-1 parallelism limit that broke AI fallback (introduced in v0.7.1)
- Removed prompt tightening that risked quality regression (introduced in v0.7.1)

**Net result:** ~60% reduction in KV operations, ~15% reduction in AI tokens, zero behavior changes.

### v0.6.11 (2026-07-05) — Promotional Footer Removal

- Removes `🆔 @username`, `🎮 @channel | desc`, `@channel • desc` patterns
- Removes separator lines (`....`, `----`, `–––`)
- Removes leftover emojis after `@username` removal
- Bot's own footer `🌀 @ILIVIR3` is preserved (never removed)

### v0.6.10 — URL Stripping + Emoji Numbers

- URLs and markdown links stripped before ASCII letter counting (link-heavy paragraphs no longer misclassified as English)
- Persian numbers (۱., ۲., ۳.) at start of English-titled lines → emoji numbers (1️⃣, 2️⃣, 3️⃣)
- Persian numbers in Persian paragraphs preserved

### v0.6.9 — Global Admin List

- `admin_list` stored in global KV key (`global:admin_list`) instead of per-user settings
- `getAdminList()` / `isAdminInList()` read from global key
- `isAuthorized()` is now async — checks `ADMIN_ID` first, then global admin list
- Any admin can authorize any user (cross-admin)

### v0.6.8 — Approve Mode + Admin Management

- `approve_enabled` setting: bot sends preview with ✅ Publish / ❌ Reject buttons
- Preview data stored in KV with 1-hour TTL
- Owner can add/remove additional admins via the admin panel

### v0.6.4 — Latest AI Models

- Updated Gemini models: `gemini-3-flash-preview` (primary), `gemini-2.5-flash`, etc.
- Updated OpenRouter models: `meta-llama/llama-3.3-70b-instruct:free` (primary), 5 fallbacks
- Smart fallback ordering: preferred top 2 → other provider → rest

### v0.6.2 — /start + /menu Split

- `/start` shows bot intro to **all users** (admins and non-admins)
- `/menu` shows admin panel (admins only)
- Non-admin users get format-only response (no AI, no publish)

### v0.5.12 — Scheduling Triple Fix

- Removed `?? "HTML"` and `?? false` defaults that conflicted with `schedule_date`
- Cast `schedule_date` to `Number()` in all send functions
- Added `invalidateChatIdCache()` for fresh resolution
- `/debug_schedule` now runs 4 tests: HTML, Plain, Minimal, Raw API

### v0.5.9 — Stats Batching + AbortController

- In-memory stats batching (flush every N increments instead of every request)
- `AbortController` cancels losing AI providers when one succeeds (saves tokens)
- Conditional debug logging (gated by `DEBUG_MODE`)
- Removed cron-based scheduling queue (native Telegram only)

### v0.5.8 — Native Telegram Scheduling

- Reverted to native Telegram `schedule_date` (posts appear in Scheduled Messages view)
- Added `checkSchedulingPermissions()` to verify bot has `can_post_messages`
- Added `verifyScheduled()` to detect silent immediate send
- New command: `/checkperms`

### v0.5.0 — Initial Public Release

- AI rewrite with Gemini + OpenRouter fallback
- Admin panel with 8 inline buttons
- Media group (album) support
- Channel editing feature
- HTML formatting engine

---

## License

MIT — do whatever you want.

---

## Credits

Built for the **ILIVIR3** Telegram channel. Powered by Cloudflare Workers, Google Gemini, and OpenRouter.
