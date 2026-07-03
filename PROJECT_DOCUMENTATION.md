# AI Admin — Complete Project Documentation

## Version 0.4.2

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Pipeline Stages](#pipeline-stages)
4. [Profile System](#profile-system)
5. [AI Provider Management](#ai-provider-management)
6. [Formatter](#formatter)
7. [Admin Panel](#admin-panel)
8. [Debug Dashboard](#debug-dashboard)
9. [Configuration](#configuration)
10. [API Reference](#api-reference)

---

## Overview

AI Admin is a Telegram channel content processing bot that runs on Cloudflare Workers. It takes incoming Telegram posts, cleans them, optionally rewrites them with AI, formats them beautifully, and publishes them to a target channel.

**Key principle:** Editing changes words. Formatting changes appearance. Never mix them.

---

## Architecture

```
Telegram Update
    ↓
Stage 0: Input Parser (telegram.js)
    ↓
Stage 1: Content Analyzer (classifier.js)
    ↓
Stage 2: Content Editor (ai.js → AI providers)
    ↓
Stage 3: UI Formatter (formatter.js)
    ↓
Stage 4: Quality Controller (implicit in formatter)
    ↓
Stage 5: Telegram Publisher (telegram.js)
```

### Key Design Decisions

1. **Separation of concerns:** `rewrite_mode` controls text changes. `edit_intensity` controls UI only.
2. **Multi-model racing:** All AI providers race in parallel via `Promise.any`. First success wins.
3. **Profile system:** When a profile is active, Soul + Style + Rules replace individual settings.
4. **Graceful degradation:** If AI fails → format-only. If format fails → plain text. Never drop a post.

---

## Pipeline Stages

### Stage 0: Input Parser (`telegram.js`)

Extracts from Telegram updates:
- Text and captions
- Media file_ids (photo, video, document, animation)
- Media group IDs (for albums)
- Reply chain context
- Text link entities (converted to markdown `[text](url)`)
- URLs from `text_link` entities

### Stage 1: Content Analyzer (`classifier.js`)

Rule-based classification (no AI call — saves time and tokens):
- Content type: github_repo, tutorial, news, tool, ai_update, etc.
- Rewrite mode: none, light, normal, summary
- Needs rewrite: boolean

### Stage 2: Content Editor (`ai.js`)

AI-powered text improvement:
- Races Gemini (3 models) + OpenRouter (11 models) in parallel
- Returns PLAIN TEXT (no HTML, no formatting)
- Preserves all technical content (links, code, commands)
- Removes spam, ads, attribution
- Preserves emotional tone
- Preserves language (never translates unless forced)

**Profile integration:** If a profile is active, the system prompt includes Soul + Style + Rules instead of the standard knowledge base.

### Stage 3: UI Formatter (`formatter.js`)

Transforms plain text into Telegram HTML:
- Protects code blocks and inline code from markdown transforms
- Converts markdown to HTML (`**bold**` → `<b>`, `` `code` `` → `<code>`)
- URLs → clickable `<a>` tags with shortened labels
- Long paragraphs → `<blockquote>` (except first paragraph)
- Numbered steps → grouped in one `<blockquote>` with number emojis
- Decorative emojis → stripped deterministically
- Functional emojis → preserved
- Headings → `<b>` with emoji prefix (not first heading)
- Footer → appended as `<blockquote>`

**Intensity mapping:**
| % | Behavior |
|---|----------|
| 0 | Format only (no AI) |
| 20 | Minimal (links + footer quoted) |
| 40 | Light (bold, quote paragraphs) |
| 60 | Normal (default — quote + bold + lists) |
| 80 | Strong (heavy formatting) |
| 100 | Maximum (everything) |

### Stage 4: Quality Controller

Implicit in the formatter:
- HTML validation (no nested blockquotes, no broken tags)
- Truncation to Telegram limits (4096 text, 1024 caption)
- Footer always appended (even after truncation)

### Stage 5: Telegram Publisher (`telegram.js`)

- Reuses media file_ids (never re-uploads)
- Sends to target channel
- Sends copy to admin as feedback
- Edits processing message with final status

---

## Profile System

### Structure

```
ai/profiles/
├── index.js              # Registry + loader
└── ilivir3/
    ├── soul.js           # "Who am I?" — personality, identity, mission
    ├── style.js          # "How do I write?" — tone, formatting, emojis
    └── rules.js          # "What must I never do?" — inviolable rules
```

### How It Works

**When NO profile is active (default):**
- Individual settings are used: Personality, Intensity, Emoji, Rewrite
- Standard knowledge base is sent to AI

**When a profile IS active:**
- Profile's Soul + Style + Rules replace the knowledge base
- Profile's default settings override individual settings
- Language and Footer still work normally
- Admin panel shows "⚠️ Profile active" warning

### Adding a New Profile

1. Create `ai/profiles/<name>/` with `soul.js`, `style.js`, `rules.js`
2. Import and register in `ai/profiles/index.js`
3. Profile appears in admin panel automatically

### ILIVIR3 Profile

**Soul:** Professional, calm, developer-focused. NOT a chatbot. NOT an AI assistant. The permanent AI Administrator of ILIVIR3.

**Style:** Relaxed but confident. Like an experienced developer in Telegram tech communities. Mixes short and long sentences. Uses functional emojis only (1-5 per post).

**Rules:** 33 inviolable rules — never remove GitHub links, always remove ads, never use hype words, preserve emotional tone, etc.

---

## AI Provider Management

### Architecture

All providers race in parallel via `Promise.any`. First successful response wins.

### Gemini Models (3 models raced)
1. `gemini-2.5-flash` (primary)
2. `gemini-2.5-flash-lite` (cheaper fallback)
3. `gemini-2.0-flash` (legacy fallback)

### OpenRouter Models (11 models raced)
1. `nvidia/nemotron-3-nano-30b-a3b:free` (737ms — fastest)
2. `nvidia/nemotron-3-super-120b-a12b:free`
3. `google/gemma-4-31b-it:free`
4. `openai/gpt-oss-20b:free`
5. `google/gemma-4-26b-a4b-it:free`
6. `nvidia/nemotron-3-ultra-550b-a55b:free` (smartest)
7. `openrouter/free` (auto-router)
8-11. Rate-limited fallbacks

### Timeouts
- Per model: 15 seconds
- Total pipeline: 90 seconds
- AbortController cancels in-flight requests on timeout

### Fallback Chain
```
Gemini fails → OpenRouter (all models in parallel)
→ All fail → Format-only mode (no AI rewrite)
→ Format fails → Plain text
→ Plain text fails → Log + notify admin
```

---

## Formatter

### Processing Order (v0.4.0+)

1. Protect code blocks (`§CB` placeholders)
2. Protect inline code (`§IC` placeholders)
3. Detect prompts (`§P` placeholders)
4. Extract markdown links `[text](url)` → `§L` placeholders
5. Remove angle brackets around URLs
6. Strip decorative emojis (deterministic)
7. Escape HTML
8. Replace plain URLs with `<a href>` (shortened label)
9. Restore link placeholders as `<a>` tags
10. Markdown transforms (bold, italic, headings, bullets)
11. Numbered steps → grouped blockquote
12. Quote long paragraphs (two-pass, skip first)
13. Restore code/inline code/prompts (AFTER markdown transforms)
14. Add emojis to headings (not first, not inline bold)
15. Clean up blank lines
16. Append footer

### Emoji Handling

**Functional (preserved):** 🛠️🚀🤖📚⚡🔒🌐📦💡📝🎯🐞🧩⚠️✨📥🔗📊🔧✅❌

**Decorative (stripped):** 🔥😍😱😂🤣😭🎉🥳🎊💎🌟💫

**Number emojis (preserved):** 1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣9️⃣🔟

### URL Handling

- Plain URLs → `<a href="url">shortened-label</a>` (clickable, no ugly long URL)
- Markdown `[text](url)` → `<a href="url">text</a>` (clickable text preserved)
- Trailing punctuation trimmed (`,`, `)`, `.`, `!`, `?`)
- URLs inside code blocks are protected

---

## Admin Panel

### Menu Structure

```
[⚙️ Settings] [👤 Profile]
[🌐 Language] [✍️ Rewrite]
[🎭 Personality] [🎨 Intensity]
[📢 Footer] [😀 Emoji Level]
[🤖 AI Provider] [📊 Stats]
[📺 Channel Edit: OFF]
```

### Profile Menu

When no profile active:
- Shows available profiles
- Tap to activate

When profile active:
- Shows active profile info
- "❌ Deactivate Profile" button
- Warning: individual settings are overridden

### Commands

- `/start` — Open admin panel
- `/footer <text>` — Change footer
- `/help` — Show help

---

## Debug Dashboard

Access at: `https://your-worker.workers.dev/debug`

### Features

- **Status Overview** — All env vars, secrets (masked), KV status
- **Detected Issues** — Auto-diagnosis of common problems
- **Quick Actions** — Test message, test KV, test AI (all models in parallel)
- **Raw Requests** — Last 30 incoming webhook requests
- **Recent Updates** — Last 30 processed updates with trace
- **Recent Errors** — Last 30 errors with stack traces
- **Bot Info** — From getMe
- **Webhook Info** — From getWebhookInfo

### API Endpoints

- `GET /debug/api/ping` — Fast liveness check
- `GET /debug/api/status` — Full status (parallel, 8s timeout)
- `POST /debug/api/test/message` — Send test message
- `POST /debug/api/test/kv` — Test KV read/write
- `POST /debug/api/test/ai` — Test all AI models in parallel

---

## Configuration

### wrangler.toml

```toml
[vars]
ADMIN_ID = "your-telegram-id"
TARGET_CHANNEL = "@your-channel"
FOOTER_TEXT = "🌀 @ILIVIR3"
DEFAULT_AI_PROVIDER = "openrouter"
GEMINI_MODEL = "gemini-2.5-flash"
OPENROUTER_MODEL = "nvidia/nemotron-3-nano-30b-a3b:free"
OPENROUTER_FALLBACK_MODELS = "nvidia/nemotron-3-nano-30b-a3b:free,..."
```

### Secrets (set via Cloudflare dashboard)

- `BOT_TOKEN` — From @BotFather
- `GEMINI_API_KEY` — From Google AI Studio
- `OPENROUTER_API_KEY` — From OpenRouter
- `WEBHOOK_SECRET` — Optional webhook verification
- `DEBUG_TOKEN` — Optional debug dashboard protection

### KV Settings (stored per-admin)

| Setting | Default | Description |
|---------|---------|-------------|
| `language_mode` | `auto` | Auto / Persian / English |
| `rewrite_mode` | `normal` | None / Light / Normal / Deep / Summary |
| `edit_intensity` | `60` | 0-100% UI formatting |
| `emoji_level` | `20` | 0-100% emoji usage |
| `personality_mode` | `friendly` | Friendly / Professional / Technical / News |
| `active_profile` | `null` | null / "ilivir3" |
| `channel_editing_enabled` | `false` | Edit channel posts in-place |
| `footer_text` | `🌀 @ILIVIR3` | Appended to every post |

---

## API Reference

### Core Functions

#### `runPipeline(env, content, feedbackChatId, update)`
Main content processing pipeline. 90s timeout with AbortController.

#### `runMediaGroupPipeline(env, items, update)`
Album processing. Combines captions, processes as one unit.

#### `runChannelEditPipeline(env, content, update)`
In-place channel post editing. Uses editMessageText/editMessageCaption.

#### `aiComplete(env, settings, params)`
Races all AI providers in parallel. Returns first success.

#### `formatPost(text, ctx)`
Formats plain text into Telegram HTML. ctx: `{ footer, intensity, emojiLevel }`

#### `cleanContent(rawText)`
Removes spam, ads, attribution. Preserves technical content.

---

## Error Recovery

| Failure | Recovery |
|---------|----------|
| AI timeout | Format-only mode |
| All AI models fail | Format-only mode |
| HTML parse error | Retry with plain text |
| Telegram publish error | Notify admin |
| KV read/write error | Use defaults |
| Webhook secret mismatch | 403 Forbidden |

**Golden rule:** Never lose user content. Never stop publishing.
