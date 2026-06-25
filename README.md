# 🧠 AI Admin

<div align="center">

**Version 0.1.4**

Telegram channel content processing bot — built on Cloudflare Workers, 100% free.

</div>

<div dir="rtl">

ربات ادمین هوشمند تلگرام برای پردازش، تمیزکاری و انتشار پست در کانال.  
ساخته‌شده برای **Cloudflare Workers** — کاملاً رایگان.

## ✨ امکانات

- 🤖 پردازش خودکار پست‌های ورودی (متن، عکس، ویدیو، فایل، انیمیشن)
- 🧹 حذف اسپم، تبلیغات، تگ‌های @ و امضاهای نویسنده
- 🔗 حفظ کامل لینک‌های GitHub، مستندات، API و دانلود
- ✍️ بازنویسی هوشمند با Gemini (رایگان) + OpenRouter به‌عنوان fallback
- 🌐 تشخیص خودکار زبان فارسی/انگلیسی
- 📊 منوی ادمین با inline buttons (بدون اسپم پیام)
- 🎭 4 حالت شخصیت: دوستانه / حرفه‌ای / فنی / خبری
- 🔧 موتور فرمت قابل تعویض (HTML / Markdown / Plain)
- ⚡ همیشه رایگان — Cloudflare Workers free tier کافی است

## 🏗️ معماری

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
                  │ (free)  │       │  (free)  │       │ (fallback)│
                  └─────────┘       └──────────┘       └──────────┘
```

**Pipeline پردازش (طبق پرامپت):**

```
RECEIVE → EXTRACT → CLASSIFY → CLEAN → [REWRITE/SUMMARIZE] → FORMAT → PUBLISH
```

اگر هر مرحله‌ای شکست بخورد → به FORMAT_ONLY برمی‌گردیم. **هیچ‌وقت پست drop نمی‌شود.**

## 📦 ساختار پروژه

```
ai-admin/
├── wrangler.toml           # تنظیمات Cloudflare Worker (مینیمال)
├── package.json            # نسخه 0.1.1 + اسکریپت‌ها
├── VERSION                 # 0.1.1
├── LICENSE                 # MIT
├── .dev.vars.example       # نمونه متغیرهای محلی (برای dev)
├── .gitignore
├── README.md               # این فایل
├── scripts/
│   ├── test-units.mjs      # تست‌های واحد (cleaner, classifier, formatter)
│   ├── test-pipeline.mjs   # تست integration کل pipeline
│   ├── test-admin.mjs     # تست تطابق با spec پرامپت 3
│   ├── test-debug.mjs      # تست ماژول debug
│   └── test-debug-html.mjs # تست خروجی HTML دیباگ
└── src/
    ├── index.js            # entry point + pipeline اصلی
    ├── telegram.js         # کلاینت Telegram Bot API
    ├── ai.js               # لایه AI با Gemini + OpenRouter fallback
    ├── classifier.js       # تشخیص نوع محتوا + نیاز به بازنویسی
    ├── cleaner.js          # تمیزکاری اسپم و attribution
    ├── formatter.js        # موتور فرمت قابل تعویض
    ├── admin.js            # پنل ادمین با 8 دکمه inline
    ├── kv.js               # ذخیره‌سازی تنظیمات در KV
    ├── prompts.js          # تمام system prompts
    └── debug.js            # داشبورد دیباگ + API + logging
```

## 🚀 راه‌اندازی گام‌به‌گام (دستی از داشبورد Cloudflare)

### پیش‌نیازها (همه چیز رایگان)

| سرویس | از کجا بگیرم | هزینه |
|-------|--------------|-------|
| حساب Cloudflare | [dash.cloudflare.com](https://dash.cloudflare.com) | رایگان |
| ربات تلگرام | از طریق [@BotFather](https://t.me/BotFather) | رایگان |
| کانال تلگرام | خودت بساز، ربات رو ادمین کن | رایگان |
| کلید Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | رایگان (1500 req/day) |
| کلید OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | رایگان (fallback) |
| Node.js 18+ | [nodejs.org](https://nodejs.org) | رایگان |

### گام ۱: Clone و نصب

```bash
git clone https://github.com/YOUR_USERNAME/ai-admin.git
cd ai-admin
npm install
```

### گام ۲: Login به Cloudflare

```bash
npx wrangler login
```

مرورگر باز می‌شه، وارد حساب Cloudflare خودت شو.

### گام ۳: Deploy اولیه (Worker ساخته می‌شه)

```bash
npm run deploy
```

خروجی شبیه این می‌شه:

```
Published ai-admin (1.23 sec)
  https://ai-admin.<your-subdomain>.workers.dev
```

این URL رو یادت باشه! حالا بریم به داشبورد Cloudflare تا KV، Secretها و Varها رو set کنیم.

### گام ۴: ساخت KV Namespace (از داشبورد)

1. برو به [dash.cloudflare.com](https://dash.cloudflare.com)
2. منوی چپ: **Storage & Databases → Workers KV**
3. کلیک روی **Create a namespace**
4. نام: `ai_admin_settings`
5. کلیک روی **Add**

### گام ۵: Bind کردن KV به Worker (از داشبورد)

1. برو به **Workers & Pages**
2. روی worker به نام `ai-admin` کلیک کن
3. تب **Settings**
4. بخش **Bindings** → کلیک روی **Add binding**
5. انتخاب: **KV Namespace**
6. تنظیمات:
   - **Variable name**: `SETTINGS` (دقیقاً با حروف بزرگ)
   - **KV namespace**: `ai_admin_settings` (همونی که گام ۴ ساختی)
7. کلیک روی **Save and deploy**

### گام ۶: اضافه کردن Secrets (از داشبورد)

همون تب **Settings**، بخش **Variables and Secrets**:

کلیک روی **Add** → انتخاب: **Secret** (رمزنگاری‌شده)

این 3 تا رو اضافه کن:

| نام Secret | مقدار | از کجا |
|-----------|-------|--------|
| `BOT_TOKEN` | `123456:ABC-...` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `GEMINI_API_KEY` | `AIza...` | [aistudio.google.com](https://aistudio.google.com/apikey) |
| `OPENROUTER_API_KEY` | `sk-or-v1-...` | [openrouter.ai/keys](https://openrouter.ai/keys) |

(اختیاری) یک Secret هم به اسم `WEBHOOK_SECRET` بساز با یک رشته تصادفی مثل `mySecret123abc` — برای امنیت webhook.

بعد از افزودن همه، کلیک روی **Save and deploy**.

### گام ۷: اضافه کردن Environment Variables (از داشبورد)

همون بخش **Variables and Secrets**، این بار نوع **Plain text** رو انتخاب کن:

| نام Variable | مقدار | توضیح |
|--------------|-------|-------|
| `ADMIN_ID` | `123456789` | آیدی عددی تلگرام خودت (از [@userinfobot](https://t.me/userinfobot) بگیر) |
| `TARGET_CHANNEL` | `@your_channel` | یوزرنیم کانال هدف |
| `FOOTER_TEXT` | `🌀 @ILIVIR3` | متن فوتر (پیش‌فرض) |
| `DEFAULT_AI_PROVIDER` | `gemini` | `gemini` یا `openrouter` |
| `GEMINI_MODEL` | `gemini-2.0-flash` | مدل Gemini رایگان |
| `OPENROUTER_MODEL` | `google/gemini-2.0-flash-exp:free` | مدل رایگان OpenRouter |

کلیک روی **Save and deploy**.

### گام ۸: تنظیم Webhook تلگرام (دستی)

یه درخواست HTTP به تلگرام بفرست تا Worker رو به‌عنوان webhook ثبت کنه. می‌تونی از terminal یا browser استفاده کنی:

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

خروجی باید این باشه:

```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

برای تایید:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

اگه `url` خالی بود یا `last_error_message` داشت، یه جای کار می‌لنگه.

### گام ۹: اضافه کردن ربات به کانال

1. کانال رو باز کن
2. **Channel Info → Administrators → Add Admin**
3. ربات رو انتخاب کن
4. دسترسی **Post Messages** رو بده

### گام ۱۰: تست! 🎉

به ربات در چت خصوصی پیام بده با `/start`. منوی ادمین باز می‌شه:

```
⚙️ ILIVIR3 AI Admin — Settings

Current configuration:
🌐 Language: auto
✍️ Rewrite: normal
🎭 Personality: friendly
🤖 AI Provider: gemini
📢 Footer: 🌀 @ILIVIR3

[⚙️ Settings] [🧠 AI Mode]
[🌐 Language] [✍️ Rewrite]
[🎭 Personality] [📢 Footer]
[🤖 AI Provider] [📊 Stats]
```

حالا یک پست نمونه بفرست → ربات پردازش و در کانال منتشر می‌کنه.

## 🎛️ استفاده

### پنل ادمین (8 دکمه طبق spec)

به ربات `/start` بفرست. این منو باز می‌شه:

| دکمه | کاربرد |
|------|--------|
| ⚙️ Settings | نمایش مجدد تنظیمات فعلی |
| 🧠 AI Mode | Presetهای ترکیبی (Provider + Rewrite) در یک کلیک |
| 🌐 Language | Auto / Persian / English |
| ✍️ Rewrite | None / Light / Normal / Summary |
| 🎭 Personality | Friendly / Professional / Technical / News |
| 📢 Footer | تغییر متن فوتر |
| 🤖 AI Provider | Gemini / OpenRouter |
| 📊 Stats | آمار پردازش |

### نحوه کار

1. **اگر به ربات در PV پیام بفرستی** → پردازش می‌کنه، در کانال منتشر می‌کنه، و feedback می‌ده
2. **اگر ربات در کانال ادمین باشه** → پست‌های جدید کانال رو پردازش و جایگزین می‌کنه
3. **هر پست** این مراحل رو طی می‌کنه:
   - تشخیص نوع محتوا (news / tutorial / github_repo / ...)
   - تمیزکاری (حذف اسپم، تگ‌ها، attribution)
   - بازنویسی هوشمند (اگر لازم باشه)
   - فرمت‌بندی با blockquote برای لینک‌ها
   - اضافه کردن فوتر `<blockquote>🌀 @ILIVIR3</blockquote>`
   - انتشار در کانال

### تغییر فوتر

```
/footer 🌀 @MyNewChannel
```

## 🧪 تست‌ها

پروژه شامل 3 suite تست است:

```bash
# همه تست‌ها
npm test

# فقط unit tests
npm run test:units

# فقط integration pipeline
npm run test:pipeline

# فقط admin panel spec compliance
npm run test:admin
```

## 🔧 شخصی‌سازی

### اضافه کردن Provider جدید

در `src/ai.js`:

```javascript
function myProvider({ apiKey }) {
  return {
    name: "myprovider",
    async complete({ system, user }) {
      const res = await fetch("https://api.myprovider.com/v1/chat", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ system, user }),
      });
      const data = await res.json();
      return data.text;
    },
  };
}
```

سپس در `buildAIChain` اضافه‌اش کن.

### اضافه کردن Format Engine جدید

در `src/formatter.js`:

```javascript
const myEngine = {
  name: "richmarkdown",
  parseMode: null,
  format(text, ctx) { /* ... */ return text; },
  wrapLink(url) { /* ... */ },
  wrapFooter(text, footer) { /* ... */ },
};

registerEngine(myEngine);

// استفاده:
formatPost(text, { engineName: "richmarkdown", footer: "🌀 @ILIVIR3" });
```

این معماری طبق پرامپت اصلی طراحی شده — AI pipeline هیچ‌وقت موتور فرمت رو مستقیم صدا نمی‌زنه.

## 💰 هزینه‌ها (همه چیز رایگان!)

| سرویس | Free Tier | کافی برای |
|-------|-----------|-----------|
| Cloudflare Workers | 100K request/day | ~70 پست در دقیقه! |
| Cloudflare KV | 100K read + 1K write/day | ~1000 تنظیمات در روز |
| Google Gemini | 1500 req/day, 15 RPM | برای اکثر کانال‌ها کافیه |
| OpenRouter free models | نامحدود (rate-limited) | fallback عالی |
| Telegram Bot API | نامحدود | همیشه رایگان |

## 🛡️ امنیت

- فقط `ADMIN_ID` دسترسی به پنل داره — بقیه silent ignored می‌شن
- `WEBHOOK_SECRET` از spoofing جلوگیری می‌کنه (اختیاری ولی توصیه می‌شه)
- توکن‌ها به‌عنوان Cloudflare Secret ذخیره می‌شن (رمزنگاری‌شده، نه در کد)
- هیچ‌وقت `.dev.vars` رو commit نکن!

## 🔧 دیباگ داشبورد

اگر ربات کار نمی‌کنه یا می‌خوای ببینی چه خبره، یک **داشبورد دیباگ کامل** ساخته شده:

### باز کردن داشبورد

URL رباتت رو باز کن و `/debug` رو بهش اضافه کن:

```
https://ai-admin.<your-subdomain>.workers.dev/debug
```

اگه `DEBUG_TOKEN` رو هم ست کرده باشی:
```
https://ai-admin.<your-subdomain>.workers.dev/debug?token=YOUR_TOKEN
```

### قابلیت‌ها

داشبورد شامل:

1. **📊 Status Overview** — وضعیت تمام متغیرها، secretها و KV binding (با mask کردن مقادیر حساس)
2. **⚠️ Detected Issues** — تشخیص خودکار مشکلات رایج:
   - `ADMIN_ID` ست نشده
   - KV binding وجود نداره
   - `TARGET_CHANNEL` ست نشده
   - خطای webhook
   - کلید AI ست نشده
3. **🧪 Quick Actions** — دکمه‌های تست:
   - **📤 Send Test Message** — پیام تست به ADMIN_ID (برای تست BOT_TOKEN و ADMIN_ID)
   - **💾 Test KV** — تست read/write/delete روی KV
   - **🤖 Test AI** — تست مستقیم Gemini/OpenRouter
   - **🗑️ Clear Logs** — پاک کردن logها
4. **📜 Recent Updates** — 30 update اخیر تلگرام (با timestamp، نوع، from ID، وضعیت)
5. **❌ Recent Errors** — 30 خطای اخیر با stack trace
6. **🔧 Bot Info** — اطلاعات ربات از getMe
7. **🔗 Webhook Info** — اطلاعات webhook از getWebhookInfo (شامل last_error_message)

### رفع مشکل: ربات هیچ پاسخی نمی‌ده

اگر ربات silent هست، احتمالاً یکی از این مشکلاته:

#### 🚨 مشکل 1 (شایع‌ترین): Webhook 403 Forbidden

اگر تو داشبورد دیباگ می‌بینی:
```
⚠️ Telegram reports webhook error: Wrong response from the webhook: 403 Forbidden
🔗 Pending Updates: 5 (یا بیشتر)
📜 Recent Updates: (خالی)
```

این یعنی **`WEBHOOK_SECRET` mismatch**. شما `WEBHOOK_SECRET` رو در Cloudflare set کردی، ولی هنگام `setWebhook` این secret رو به تلگرام ندادی. پس تلگرام بدون هدر secret می‌فرسته، Worker رد می‌کنه (403).

**رفع سریع (یک دستور):**

```bash
# 1. مطمئن شو .dev.vars فایل داره (cp .dev.vars.example .dev.vars و مقداردهی کن)
# 2. اجرا کن:
npm run fix:webhook -- https://ai-admin.<your-subdomain>.workers.dev
```

این اسکریپت خودش:
- وضعیت webhook فعلی رو چک می‌کنه
- `WEBHOOK_SECRET` رو از `.dev.vars` می‌خونه
- `setWebhook` رو با secret_token درست صدا می‌زنه
- pending updates رو پاک می‌کنه (`drop_pending_updates: true`)
- یه پیام تست هم می‌فرسته

**روش دستی (curl):**

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://ai-admin.<your-subdomain>.workers.dev/webhook",
    "secret_token": "<YOUR_WEBHOOK_SECRET_EXACT_VALUE>",
    "allowed_updates": ["message", "callback_query", "channel_post"],
    "drop_pending_updates": true
  }'
```

> ⚠️ **مهم:** مقدار `<YOUR_WEBHOOK_SECRET_EXACT_VALUE>` باید دقیقاً همون چیزی باشه که تو Cloudflare ست کردی. حتی یه کاراکتر فرق داشته باشه، بازم 403 می‌خوری.

#### مشکل 2: ADMIN_ID اشتباه

به داشبورد برو. اگه `ADMIN_ID` ست نشده یا اشتباهه، در بخش "Issues" قرمز می‌شه. ربات هم حالا وقتی پیام می‌گیری، بهت می‌گه ID واقعی‌ت چیه.

#### مشکل 3: KV بایند نشده

در داشبورد چک کن: اگه "KV (SETTINGS)" قرمزه، باید بری به Cloudflare dashboard و KV رو با variable name دقیقاً `SETTINGS` بایند کنی.

#### مشکل 4: Bot تو کانال ادمین نیست

پیام خطا رو تو PV ربات می‌بینی. ربات رو به کانال اضافه کن و دسترسی Post Messages بده.

#### مشکل 5: Gemini 429 (quota exceeded)

اگر تو تست AI خطای `429` می‌بینی، یعنی quota رایگان Gemini تموم شده. این بحرانی نیست — OpenRouter به‌عنوان fallback خودکار فعال می‌شه. یا چند ساعت صبر کن تا quota refresh بشه، یا مدل دیگه‌ای رو تست کن.

### لاگ‌های زنده

برای دیدن لاگ‌های زنده (console.log ها):

```bash
npm run tail
```

این دستور `wrangler tail` رو اجرا می‌کنه و تمام `console.log` و `console.error` ها رو زنده نشون می‌ده. هر update با timestamp و جزئیات لاگ می‌شه.

---

## 🐛 Troubleshooting

### ربات پاسخ نمی‌ده

```bash
# وضعیت webhook رو چک کن
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

اگه `last_error_message` وجود داشت، احتمالاً Worker خطا داده. لاگ‌ها رو ببین:

```bash
npm run tail
```

### پست منتشر نمی‌شه

- مطمئن شو ربات **ادمین کانال** باشه
- `TARGET_CHANNEL` درست set شده باشه (با @ شروع شه یا -100xxx)
- پیام خطا رو از چت PV ربات ببین

### AI کار نمی‌کنه

- در داشبورد Cloudflare، مطمئن شو `GEMINI_API_KEY` به‌عنوان Secret ثبت شده
- در پنل ادمین، Provider رو به `openrouter` تغییر بده و دوباره تست کن
- مدل‌های رایگان گاهی rate-limit می‌شن — چند ثانیه صبر کن

### خطای "KV not bound"

در داشبورد: **Workers & Pages → ai-admin → Settings → Bindings** — مطمئن شو binding با نام دقیقاً `SETTINGS` (با حروف بزرگ) وجود داره.

## 📋 Spec Compliance Checklist

این پروژه طبق 4 پرامپت اصلی ساخته شده:

- ✅ **PROMPT 1 (Master System Prompt)**: همه قوانین در `src/prompts.js`
- ✅ **PROMPT 2 (System Architecture)**: pipeline، KV schema، media support، failure handling
- ✅ **PROMPT 3 (Admin Panel)**: 8 دکمه inline، security rule، UX rule
- ✅ **PROMPT 4 (Process Flow)**: 12 مرحله pipeline، link handling، footer rule، pluggable Format Engine

برای تایید: `npm run test:admin`

## 📝 License

MIT — هر بلایی می‌خوای سرش بیار. 😄

</div>

---

<div dir="rtl">

ساخته‌شده با ❤️ برای کانال **ILIVIR3**  
نسخه: **0.1.0**

</div>
