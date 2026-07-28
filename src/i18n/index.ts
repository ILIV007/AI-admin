/**
 * src/i18n/index.ts
 * Internationalization system for bot UI language.
 * Controls all bot messages (command responses, menu, errors).
 * This is SEPARATE from the output language (which controls AI rewrite output).
 */

export type UiLanguage = "en" | "fa";

export const DEFAULT_UI_LANGUAGE: UiLanguage = "en";

export const SUPPORTED_LANGUAGES: { code: UiLanguage; label: string; flag: string }[] = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "fa", label: "فارسی", flag: "🇮🇷" },
];

const translations: Record<UiLanguage, Record<string, string>> = {
  en: {
    "start.welcome": "Welcome to AI Admin!",
    "start.description": "I'm your AI-powered channel content processor. Send me a post and I'll clean, rewrite, and publish it.",
    "start.choose_language": "Please choose your language:",
    "start.language_set": "✅ Language set to English.",
    "menu.title": "⚙️ Settings",
    "menu.settings": "⚙️ Settings",
    "menu.stats": "📊 Statistics",
    "menu.schedule": "📅 Schedule",
    "menu.admins": "👥 Admins",
    "menu.test_ai": "🧪 Test AI",
    "menu.status": "🔍 Status",
    "menu.help": "❓ Help",
    "menu.back": "🔙 Back",
    "help.title": "❓ Help",
    "help.commands": "Commands:",
    "stats.title": "📊 Statistics",
    "stats.received": "Received",
    "stats.published": "Published",
    "stats.failed": "Failed",
    "stats.ai_calls": "AI Calls",
    "stats.success_rate": "Success Rate",
    "footer.updated": "✅ Footer updated",
    "footer.usage": "Usage: /footer <text>",
    "unauthorized": "⛔ Unauthorized",
    "owner_only": "⛔ Owner only",
    "admin_only": "⛔ Admin only",
    "schedule.set": "📅 Next post scheduled for {time}",
    "schedule.usage": "Usage: /schedule <time>\nExamples:\n/schedule in 30m\n/schedule at 15:30\n/schedule tomorrow 09:00",
    "processing": "⏳ Processing...",
    "processing.steps": "Cleaning → Classifying → AI Rewrite → Formatting → Publishing",
    "report.published": "✅ Published",
    "report.preview_sent": "👁 Preview Sent",
    "report.formatted": "📝 Formatted",
    "report.failed": "❌ Failed",
    "report.skipped": "⏭️ Skipped",
    "report.title": "📊 Report",
    "report.category": "Category",
    "report.language": "Language",
    "report.words": "Words",
    "report.ai_used": "AI Used",
    "report.ai_provider": "AI Provider",
    "report.ai_model": "AI Model",
    "report.parts": "Parts",
    "report.has_media": "Has Media",
    "report.time": "Time",
    "report.error": "Error",
    "report.original_preview": "Original preview",
    "models.title": "🤖 AI Models",
    "models.provider": "Provider",
    "models.active": "🟢 Active",
    "health.title": "💚 System Health",
    "admin.added": "✅ Admin added",
    "admin.removed": "✅ Admin removed",
    "admin.enter_id": "Please send the Telegram user ID:",
    "webhook.set": "✅ Webhook set",
    "webhook.deleted": "✅ Webhook deleted",
    "broadcast.sent": "📨 Message sent to {count}/{total} admins",
    "version.info": "📌 AI Admin v{version}\nBuild: {date}\nFiles: {files} TypeScript\nModels: {models} AI\nCron: 1 (every 15min)\nCost: $0/month (free tier)",
    "test.passed": "✅ {count} tests passed",
    "test.failed": "❌ {passed} passed, {failed} failed",
    "reset.confirm": "⚠️ This is irreversible. Send /reset {type} again to confirm.",
    "reset.done": "✅ Reset complete: {type}",
    "queue.title": "📋 Queue Status",
    "queue.note": "Cron processes this queue every 15 minutes.",
    "audit.title": "📜 Audit Log",
    "audit.empty": "No audit events recorded.",
    "common.yes": "Yes",
    "common.no": "No",
    "common.none": "None",
    "common.unknown": "Unknown",
  },
  fa: {
    "start.welcome": "به AI Admin خوش آمدید!",
    "start.description": "من پردازشگر محتوای کانال شما با هوش مصنوعی هستم. یک پست بفرستید تا آن را پاک‌سازی، بازنویسی و منتشر کنم.",
    "start.choose_language": "لطفاً زبان خود را انتخاب کنید:",
    "start.language_set": "✅ زبان روی فارسی تنظیم شد.",
    "menu.title": "⚙️ تنظیمات",
    "menu.settings": "⚙️ تنظیمات",
    "menu.stats": "📊 آمار",
    "menu.schedule": "📅 زمان‌بندی",
    "menu.admins": "👥 ادمین‌ها",
    "menu.test_ai": "🧪 تست AI",
    "menu.status": "🔍 وضعیت",
    "menu.help": "❓ راهنما",
    "menu.back": "🔙 بازگشت",
    "help.title": "❓ راهنما",
    "help.commands": "دستورات:",
    "stats.title": "📊 آمار",
    "stats.received": "دریافتی",
    "stats.published": "منتشرشده",
    "stats.failed": "ناموفق",
    "stats.ai_calls": "فراخوانی AI",
    "stats.success_rate": "نرخ موفقیت",
    "footer.updated": "✅ فوتر بروزرسانی شد",
    "footer.usage": "استفاده: /footer <text>",
    "unauthorized": "⛔ غیرمجاز",
    "owner_only": "⛔ فقط مالک",
    "admin_only": "⛔ فقط ادمین",
    "schedule.set": "📅 پست بعدی زمان‌بندی شد برای {time}",
    "schedule.usage": "استفاده: /schedule <زمان>\nمثال‌ها:\n/schedule in 30m\n/schedule at 15:30\n/schedule tomorrow 09:00",
    "processing": "⏳ در حال پردازش...",
    "processing.steps": "پاک‌سازی → طبقه‌بندی → بازنویسی AI → فرمت → انتشار",
    "report.published": "✅ منتشر شد",
    "report.preview_sent": "👁 پیش‌نمایش ارسال شد",
    "report.formatted": "📝 فرمت شد",
    "report.failed": "❌ ناموفق",
    "report.skipped": "⏭️ رد شد",
    "report.title": "📊 گزارش",
    "report.category": "دسته",
    "report.language": "زبان",
    "report.words": "کلمات",
    "report.ai_used": "استفاده از AI",
    "report.ai_provider": "ارائه‌دهنده AI",
    "report.ai_model": "مدل AI",
    "report.parts": "بخش‌ها",
    "report.has_media": "مدیا",
    "report.time": "زمان",
    "report.error": "خطا",
    "report.original_preview": "پیش‌نمایش اصلی",
    "models.title": "🤖 مدل‌های AI",
    "models.provider": "ارائه‌دهنده",
    "models.active": "🟢 فعال",
    "health.title": "💚 سلامت سیستم",
    "admin.added": "✅ ادمین اضافه شد",
    "admin.removed": "✅ ادمین حذف شد",
    "admin.enter_id": "لطفاً آیدی عددی کاربر را بفرستید:",
    "webhook.set": "✅ وب‌هوک تنظیم شد",
    "webhook.deleted": "✅ وب‌هوک حذف شد",
    "broadcast.sent": "📨 پیام به {count}/{total} ادمین ارسال شد",
    "version.info": "📌 AI Admin v{version}\nبیلد: {date}\nفایل‌ها: {files} TypeScript\nمدل‌ها: {models} AI\nکرون: ۱ (هر ۱۵ دقیقه)\nهزینه: $0/ماه (پلن رایگان)",
    "test.passed": "✅ {count} تست پاس شد",
    "test.failed": "❌ {passed} پاس شد، {failed} ناموفق",
    "reset.confirm": "⚠️ این عمل غیرقابل بازگشت است. دوباره /reset {type} بفرستید تا تأیید شود.",
    "reset.done": "✅ ریست کامل: {type}",
    "queue.title": "📋 وضعیت صف",
    "queue.note": "کرون هر ۱۵ دقیقه این صف را پردازش می‌کند.",
    "audit.title": "📜 لاگ حساس",
    "audit.empty": "هیچ رویداد حساسی ثبت نشده است.",
    "common.yes": "بله",
    "common.no": "خیر",
    "common.none": "هیچ",
    "common.unknown": "ناشناخته",
  },
};

/**
 * Get a translated string.
 * Falls back to English if key not found in the requested language.
 * Falls back to the key itself if not found in English either.
 * Replaces {param} placeholders with values from params.
 */
export function t(
  lang: UiLanguage,
  key: string,
  params?: Record<string, string | number>,
): string {
  let text = translations[lang]?.[key] ?? translations.en[key] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return text;
}

/**
 * Get the UI language from settings, with fallback to default.
 */
export function getUiLanguage(settings?: { uiLanguage?: UiLanguage }): UiLanguage {
  return settings?.uiLanguage ?? DEFAULT_UI_LANGUAGE;
}
