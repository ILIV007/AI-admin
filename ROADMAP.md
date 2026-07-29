# AI Admin V2 — Complete Bot Roadmap

> **Version**: 2.6.0  
> **Platform**: Cloudflare Workers (free tier)  
> **Language**: TypeScript 5 Strict  
> **Last Updated**: 2026-07-30

---

## 1. Architecture Overview

```
Telegram → Webhook (<50ms) → Queue → Consumer → Pipeline → Channel
                                      ↓
                              D1 (SQLite) + KV (cache)
                                      ↓
                              Cron (every 15min)
```

### Core Flow
1. **Webhook** (`src/index.ts`): validates secret, dedupes `update_id`, enqueues to Queue, returns 200 in <50ms
2. **Queue Consumer** (`src/queue/consumer.ts`): processes updates async with retry + DLQ
3. **Pipeline** (`src/processing/pipeline.ts`): clean → classify → AI rewrite → format → publish
4. **Cron** (`src/scheduling/cron.ts`): publishes scheduled posts, expires approvals, refreshes model health, prunes data

### Storage
- **D1 (SQLite)**: jobs, settings, admins, audit_log, media_group_items, stats, debug_events, seen_updates, published_posts
- **KV**: settings cache (120s), model health (1h), auth cache (120s), transient flags
- **Queue**: async processing with max_retries=3 + DLQ

---

## 2. Module Map (40+ files)

### Entry Points
| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry: fetch (webhook), queue, scheduled (cron) |
| `src/queue/consumer.ts` | Queue consumer — the REAL processing |
| `src/queue/producer.ts` | Enqueue helper |

### Processing Pipeline
| File | Purpose |
|------|---------|
| `src/processing/pipeline.ts` | Main pipeline orchestrator |
| `src/processing/cleaner.ts` | Idempotent content cleaning + prompt protection |
| `src/processing/classifier.ts` | Rule-based content classification |
| `src/processing/preservation.ts` | URL/code/repo preservation validation |
| `src/processing/scheduler.ts` | Schedule time computation |

### AI Layer
| File | Purpose |
|------|---------|
| `src/ai/provider.ts` | Provider abstraction + HTTP helpers |
| `src/ai/gemini.ts` | Google Gemini provider (v1beta) |
| `src/ai/openrouter.ts` | OpenRouter provider |
| `src/ai/fallback.ts` | Sequential fallback orchestrator + circuit breaker |
| `src/ai/prompts.ts` | System + user prompt builders + RTL fix |

### Formatting
| File | Purpose |
|------|---------|
| `src/formatting/blocks.ts` | Markdown → ContentBlock[] IR |
| `src/formatting/telegram-html.ts` | ContentBlocks → Telegram HTML |
| `src/formatting/chunker.ts` | Safe HTML chunking by visible length |
| `src/formatting/sanitizer.ts` | AI output sanitization |
| `src/formatting/self-test.ts` | 22 in-process formatter tests |

### Telegram
| File | Purpose |
|------|---------|
| `src/telegram/client.ts` | Bot API HTTP client |
| `src/telegram/publisher.ts` | Post publishing + edit + preview |
| `src/telegram/updates.ts` | Update parsing + content extraction |
| `src/telegram/entities.ts` | HTML entities + keyboards + truncateVisible |

### Admin
| File | Purpose |
|------|---------|
| `src/admin/commands.ts` | 19+ bot commands with role-based permissions |
| `src/admin/callbacks.ts` | Inline keyboard callback handler |
| `src/admin/keyboards.ts` | Inline keyboard builders |
| `src/admin/approval.ts` | Approval state machine |
| `src/admin/addadmin.ts` | Add-admin flow |

### Storage
| File | Purpose |
|------|---------|
| `src/storage/d1.ts` | D1 prepared statement helpers |
| `src/storage/repositories/admins.ts` | Admin CRUD + auth cache |
| `src/storage/repositories/settings.ts` | Settings CRUD + KV cache |
| `src/storage/repositories/jobs.ts` | Jobs CRUD + claimForPublish + published_posts |
| `src/storage/repositories/stats.ts` | Atomic stats counters |
| `src/storage/repositories/media-groups.ts` | Album aggregation |
| `src/storage/repositories/approval-repo.ts` | Approval job management |
| `src/storage/repositories/debug-events.ts` | Debug event logging |
| `src/storage/repositories/seen-updates.ts` | Update dedup |

### Config & Domain
| File | Purpose |
|------|---------|
| `src/config/env.ts` | Env validation (assertEnv) |
| `src/config/defaults.ts` | Default settings + model catalog + profiles |
| `src/domain/roles.ts` | Role-based permissions (can()) |
| `src/scheduling/cron.ts` | Single cron trigger |
| `src/i18n/index.ts` | English + Persian translations |
| `src/observability/logger.ts` | Structured logging + debug events |
| `src/debug-panel.ts` | Debug dashboard (protected) |
| `src/types.ts` | All TypeScript contracts |

---

## 3. Feature Status

### ✅ Fully Implemented
- [x] Webhook with secret validation + update_id dedup
- [x] Queue-based async processing with retry + DLQ
- [x] AI rewrite with Gemini (primary) + OpenRouter (fallback)
- [x] Circuit breaker with KV health cache (3-strike, 5min skip)
- [x] Rich Markdown → Telegram HTML (bold, italic, underline, strike, spoiler, code, pre, link, mention)
- [x] Safe chunking by visible length (tag-balanced)
- [x] Prompt detection + protection (never split, ultra-summarize)
- [x] URL shortening (GitHub → 🐙 owner/repo, bare URLs → domain/path/)
- [x] RTL support (RLM mark post-processor + AI prompt)
- [x] Personality modes (friendly/professional/neutral)
- [x] Channel editing (edit existing channel posts in place, 48h window)
- [x] Scheduled posts (cron-based, max 50 per user, queue depth limit)
- [x] Approval mode (preview with Publish/Reject buttons)
- [x] Media group (album) aggregation with race-condition-free finalization
- [x] 19+ bot commands with role-based permissions
- [x] Admin notifications (English UI)
- [x] Two-step confirmation for /resetall and cancelsched
- [x] Debug panel (protected with DEBUG_TOKEN)
- [x] Deep health probe (/api/health)
- [x] Full audit trail in D1

### ✅ Recently Fixed (v2.5.0–v2.6.0)
- [x] P0: isAdmin now uses isAuthorized() (not just owner)
- [x] P0: /resetall now actually executes (added .run())
- [x] P0: cleanContent passes ownHandle (channel's own @handle preserved)
- [x] P0: Fake AI models replaced with real ones (Gemini 2.5-flash, Llama 3.3 70B)
- [x] P0: assertEnv now called at boot
- [x] P0: Retry-After unit mismatch fixed (seconds → ms)
- [x] P0: Fallback chain skips same-provider only for auth errors (401/402/403)
- [x] P0: markSeen moved after enqueue (prevents update loss)
- [x] P0: Double-publish races fixed (claimForPublish + conditional markFinalized)
- [x] P1: personalityMode wired up
- [x] P1: RTL rule softened (Python/React acceptable)
- [x] P1: No pagination instruction added
- [x] P1: Colon→blockquote restricted to URLs/code only
- [x] P1: Health ping uses minimal prompt
- [x] P1: Summarize uses workingText (not finalText)
- [x] P1: Prompt blocks use `<pre><code>` (preserves newlines)
- [x] P1: Channel editing for admin private messages (published_posts mapping)
- [x] P1: Scheduled time shown in admin preview
- [x] P1: Approval + schedule conflict warning
- [x] P1: Queue depth limit (max 50 pending)
- [x] P1: Captions truncated to 1024 chars (all 6 sites)
- [x] P2: fixRtlParagraphs real implementation (RLM mark)
- [x] P2: Backslash escape in inline parser
- [x] P2: DebugEvent circular JSON guard
- [x] P2: Debug panel auth (?token= + Bearer)
- [x] P2: cancelsched two-step confirmation
- [x] P2: AI metadata in scheduled payload
- [x] Temperature lowered to 0.3 (deterministic formatting)
- [x: Transient errors (429/5xx) don't count toward circuit breaker

### 🔲 Planned / Future
- [ ] Convert consumer.ts dynamic imports to static (26 remaining)
- [ ] In-memory settings cache (module-level Map, 5s TTL)
- [ ] Consolidate footer-stripping regex passes (6 → 2)
- [ ] `/schedule preview` command (show next slot without sending)
- [ ] Cron pruning for old published_posts rows (>48h)
- [ ] Mobile tap-to-toggle for architecture tooltips
- [ ] axe-core accessibility audit
- [ ] Copy command button on bot command cards

---

## 4. AI Model Catalog (12 free models)

### Gemini (primary provider)
1. `gemini-2.5-flash` (stable default)
2. `gemini-2.5-flash-lite` (fastest)
3. `gemini-2.0-flash`
4. `gemini-2.0-flash-lite`
5. `gemini-1.5-flash`
6. `gemini-1.5-flash-8b` (lightweight)

### OpenRouter (fallback provider)
1. `meta-llama/llama-3.3-70b-instruct:free` (stable default)
2. `openai/gpt-oss-20b:free` (lightweight)
3. `google/gemma-2-9b-it:free`
4. `qwen/qwen-2.5-7b-instruct:free` (multilingual)
5. `microsoft/phi-3-medium-128k-instruct:free` (long context)
6. `nvidia/llama-3.1-nemotron-70b-instruct:free`

### Fallback Strategy
- Max 2 attempts in primary provider chain (primary + 1 fallback)
- Auth errors (401/402/403) → skip to cross-provider
- Model errors (404/400) → try next same-provider model
- Transient errors (429/5xx) → don't count toward circuit breaker
- Circuit breaker: 3 permanent failures → 5min skip

---

## 5. Database Schema (9 tables)

| Table | Purpose |
|-------|---------|
| `admins` | Admin users + roles (owner/editor/reviewer/viewer) |
| `settings` | Per-user settings (JSON blob) |
| `jobs` | Scheduled posts + approvals (state machine) |
| `media_group_items` | Album aggregation (finalized flag) |
| `stats` | Atomic counters (received/published/failed/scheduled) |
| `audit_log` | Tamper-evident action log |
| `debug_events` | Debug event log (DEBUG_MODE only) |
| `seen_updates` | Update dedup (7-day retention) |
| `published_posts` | Source→channel message mapping (for channel editing) |

---

## 6. Deployment

### Prerequisites
- Cloudflare account (free tier)
- Telegram bot token (from @BotFather)
- Gemini API key (from aistudio.google.com)
- OpenRouter API key (from openrouter.ai/keys)

### Steps
1. `cd AI-admin && bun install`
2. `npx wrangler login`
3. Create D1, KV, Queue, DLQ
4. Set secrets (BOT_TOKEN, WEBHOOK_SECRET, GEMINI_API_KEY, OPENROUTER_API_KEY)
5. Run schema: `npx wrangler d1 execute ai-admin --remote --file=./schema.sql`
6. Deploy: `npx wrangler deploy`
7. Set webhook
8. Add bot to channel as admin
9. Send `/menu` to bot

---

## 7. Bot Commands (19+)

| Command | Permission | Description |
|---------|-----------|-------------|
| `/start` | all | Welcome + onboarding |
| `/help` | all | Help text |
| `/menu` | admin | Main control panel (v2.6.0) |
| `/settings` | admin | View settings |
| `/footer` | owner/editor | Change footer text |
| `/stats` | admin | View statistics |
| `/resetall` | owner | Wipe all data (2-step confirm) |
| `/ping` | admin | Latency check |
| `/version` | admin | Version info |
| `/health` | owner | System health check |
| `/models` | admin | AI model health |
| `/tail` | owner | Recent debug events |
| `/test` | admin | Run formatter self-tests |
| `/schedule` | admin | Schedule settings |
| `/addadmin` | owner | Add admin |
| `/deladmin` | owner | Remove admin |
| `/listadmins` | admin | List admins |
| `/broadcast` | owner | Broadcast message |
| `/cancel` | all | Cancel addadmin flow |

---

## 8. Quality Metrics

| Metric | Value |
|--------|-------|
| TypeScript files | 40+ |
| Lines of code | ~15,000 |
| Runtime dependencies | 0 |
| Self-tests | 22/22 passing |
| typecheck errors | 0 |
| lint errors | 0 |
| Monthly cost | $0 (free tier) |
| Cron triggers | 1 (every 15min) |
| D1 tables | 9 |
| AI models | 12 (6 Gemini + 6 OpenRouter) |
| Bot commands | 19+ |
