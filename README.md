# AI Admin V2

> بات مدیریت محتوای کانال تلگرام روی Cloudflare Workers — **کاملاً رایگان**.
> بازسازی کامل V1 (v0.7.3) با معماری اتمیک، یک Cron، و Rich Markdown.

[![TypeScript Strict](https://img.shields.io/badge/TypeScript-strict-emerald)]()
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange)]()
[![Free Tier](https://img.shields.io/badge/Cost-Free-success)]()

---

## ✨ ویژگی‌ها

### پردازش محتوا
- پاک‌سازی تبلیغات و attribution (idempotent)
- طبقه‌بندی deterministic (rule-based، نه AI)
- بازنویسی AI با Gemini (۶ مدل) + OpenRouter (۶ مدل) — همه رایگان
- Preservation Validator: URLها/GitHub/کد بعد از AI بررسی می‌شوند
- فرمت Rich Markdown → HTML تلگرام (bold, italic, underline, strikethrough, spoiler, code, pre, blockquote, link, mention)
- تقسیم امن پست‌های بلند با VISIBLE length

### معماری
- **Webhook**: اعتبارسنجی secret + dedupe update_id + enqueue → ۲۰۰ در <۵۰ms
- **Queue**: پردازش async با retry + dead-letter (رفع مشکل `waitUntil` V1)
- **Cron** (هر دقیقه — **فقط یک cron**): انتشار پست زمان‌بندی، انقضای approval، refresh مدل‌ها، cleanup
- **D1**: jobs, settings, stats, admins, audit_log, media_group_items
- **KV**: cache (settings 30s, model health 1h)، transient flags

### پنل ادمین
- نقش‌ها: `owner` / `editor` / `reviewer` / `viewer`
- فقط `owner` می‌تواند ادمین مدیریت کند (رفع مشکل V1)
- State machine تایید: `pending` → `published` / `rejected` / `expired` / `failed`
- دکمه‌ها بعد از callback disable می‌شوند (idempotent)
- /menu, /footer, /stats, /admins, /schedule, /checkperms, /ping, /help
- زمان‌بندی: `/schedule in 30m` سپس پست بعدی زمان‌بندی می‌شود

### امنیت
- Webhook secret **اجباری** (بدون آن ۴۰۳)
- `/debug` بدون `DEBUG_TOKEN` = ۴۰۴ (وجود ندارد)
- احراز هویت debug با Bearer header
- HTML escape همه متن‌های کاربر (footer, error, status)
- audit trail در D1

---

## 🚀 راه‌اندازی

### پیش‌نیازها (همه رایگان)
- حساب Cloudflare
- Bot Token از [@BotFather](https://t.me/BotFather)
- Gemini API Key از [aistudio.google.com](https://aistudio.google.com/apikey)
- OpenRouter API Key از [openrouter.ai/keys](https://openrouter.ai/keys)

### مراحل

```bash
# 1. نصب
cd telegram-bot
bun install
npx wrangler login

# 2. ساخت منابع (id ها را در wrangler.toml بگذارید)
npx wrangler d1 create ai-admin
npx wrangler kv namespace create AI_ADMIN_KV
npx wrangler queues create ai-admin-queue
npx wrangler queues create ai-admin-dlq

# 3. اجرای schema روی D1
npx wrangler d1 execute ai-admin --remote --file=./schema.sql

# 4. تنظیم secret ها (همه مقادیر حساس از طریق secret)
npx wrangler secret put BOT_TOKEN          # از @BotFather
npx wrangler secret put WEBHOOK_SECRET     # رشته تصاددی ۲۰+ کاراکتر
npx wrangler secret put GEMINI_API_KEY     # از aistudio.google.com
npx wrangler secret put OPENROUTER_API_KEY # از openrouter.ai/keys
npx wrangler secret put ADMIN_ID           # آیدی عددی شما (از @userinfobot)
npx wrangler secret put TARGET_CHANNEL     # @your_channel یا -100xxx
npx wrangler secret put FOOTER_TEXT        # مثلا: 🌀 @ILIVIR3

# 5. ویرایش wrangler.toml: فقط D1 database_id + KV id + Queue name
#    (اینها resource id هستند و باید در wrangler.toml باشند)

# 6. Deploy
npx wrangler deploy

# 7. تنظیم webhook (URL و secret خود را بگذارید)
curl -s "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER_URL>/webhook&secret_token=<WEBHOOK_SECRET>&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22channel_post%22%2C%22edited_channel_post%22%2C%22callback_query%22%5D"

# 8. اضافه کردن بات به کانال به‌عنوان admin (Post + Edit Messages)
# 9. /start به بات، سپس /menu
```

### استقرار چندکاناله (Multi-Channel)

همان ریپو را می‌توانید برای چندین کانال به‌صورت جداگانه deploy کنید. هر Worker یک کانال است:

```bash
# کانال ۱ — Worker با نام ai-admin-channel1
npx wrangler deploy  # با wrangler.toml که name = "ai-admin-channel1"
npx wrangler secret put BOT_TOKEN        # بات کانال ۱
npx wrangler secret put ADMIN_ID         # ادمین کانال ۱
npx wrangler secret put TARGET_CHANNEL   # @channel1
npx wrangler secret put FOOTER_TEXT      # 🌀 @channel1

# کانال ۲ — Worker با نام ai-admin-channel2
# wrangler.toml را با name = "ai-admin-channel2" ویرایش کنید، سپس deploy
npx wrangler deploy
npx wrangler secret put BOT_TOKEN        # بات کانال ۲
npx wrangler secret put ADMIN_ID         # ادمین کانال ۲
npx wrangler secret put TARGET_CHANNEL   # @channel2
npx wrangler secret put FOOTER_TEXT      # 🌀 @channel2
```

**مهم:** `ADMIN_ID`، `TARGET_CHANNEL`، `FOOTER_TEXT`، `BOT_TOKEN`، `WEBHOOK_SECRET` همگی **Secret** هستند — نه در wrangler.toml. این یعنی همان ریپو بدون تغییر کد برای هر کانال قابل deploy است.

### مشاهده لاگ
```bash
npx wrangler tail
```

---

## 📂 ساختار

```
telegram-bot/
├── src/
│   ├── index.ts              # Worker entry: fetch + queue + scheduled
│   ├── types.ts              # Contract مشترک
│   ├── config/               # env, defaults, model catalog, profile
│   ├── telegram/             # client, entities, updates, publisher
│   ├── processing/           # cleaner, classifier, pipeline, preservation
│   ├── ai/                   # gemini, openrouter, fallback, prompts, profile
│   ├── formatting/           # blocks, telegram-html, chunker, sanitizer
│   ├── storage/              # d1, repositories (admins, jobs, stats, ...)
│   ├── queue/                # producer, consumer
│   ├── admin/                # commands, callbacks, keyboards, approval
│   ├── scheduling/           # cron (THE single cron)
│   └── observability/        # logger, debug events
├── schema.sql                # D1 schema
├── wrangler.toml             # Cloudflare config + bindings + ONE cron
└── package.json
```

---

## 🆚 V1 → V2

| بخش | V1 | V2 |
|---|---|---|
| زمان‌بندی | `schedule_date` (وجود ندارد!) | D1 + Cron واقعی |
| پردازش | `waitUntil` ۹۰s | Queue async |
| Debug | عمومی اگر token نباشد | ۴۰۴ اگر token نباشد |
| Owner | enforce نشده | نقش صریح + audit |
| Classifier | `aiClassify` export نشد | rule-based واقعی |
| AI | ۱۱ مدل race | ۲ تلاش متوالی + circuit breaker |
| Footer | HTML injection | escape همیشه |
| Chunking | `slice()` روی HTML | VISIBLE length + tag rebalance |
| Media Group | KV race | D1 + inactivity window |
| Approval | state نامشخص | state machine idempotent |
| Stats | read-modify-write | atomic UPDATE |
| Webhook | secret اختیاری | اجباری + update_id dedupe |
| Markdown | bold/code/quote | bold/italic/underline/strike/spoiler/code/pre/link/mention |
| Typing | JavaScript | TypeScript strict |
| Dead code | ~۴۰ فایل | ۴۰ فایل مفید |

---

## 📜 مجوز

MIT — برای کانال ILIVIR3.
