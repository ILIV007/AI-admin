/**
 * src/admin/commands.ts
 * -----------------------------------------------------------------------------
 * Admin command handlers + dispatcher.
 *
 * Every handler is async and returns Promise<void>. Handlers do their own
 * authorization checks (using `can(role, perm)` + `isOwner`) — never trust
 * the dispatcher to have done them.
 *
 *   handleStart       anyone       welcome + intro
 *   handleHelp        anyone       commands + role permissions
 *   handleVersion     anyone       version + build info
 *   handleMenu        admin        main menu keyboard
 *   handleFooter      owner|editor change footerText
 *   handleCheckperms  owner|editor report bot perms in TARGET_CHANNEL
 *   handleStats       admin        global + per-admin stats
 *   handleModels      admin        list all 12 AI models + health
 *   handleAdmins      OWNER ONLY   list admins + manage keyboard
 *   handleSchedule    admin        parse time → set KV sched_next:{userId}
 *   handlePing        OWNER ONLY   uptime/version/queue depth
 *   handleHealth      OWNER ONLY   system health check (D1/KV/TG/Queue)
 *   handleDiag        OWNER ONLY   diagnostic dump (chunked)
 *   handleTest        OWNER ONLY   run formatter + cleaner self-tests
 *   handleReset       OWNER ONLY   reset stats / debug_events / finished jobs
 *   handleQueue       OWNER ONLY   queue + job status overview
 *   handleAudit       OWNER ONLY   recent audit log (tamper-evident trail)
 *   handleWebhook     OWNER ONLY   getWebhookInfo / setWebhook / deleteWebhook
 *   handleBroadcast   OWNER ONLY   broadcast a message to every admin
 *   dispatchCommand                 routes message.text → handler
 *
 * OWNER-ONLY CHECKS (fixes V1 bug #4):
 *   `handleAdmins` and `handlePing` check `isOwner(userId)` directly via the
 *   auth repo, NOT just `isAuthorized`. The role check `role === "owner"` is
 *   a second layer; both must pass.
 * -----------------------------------------------------------------------------
 */

import type {
  Env,
  ModelHealth,
  Role,
  Stats,
  TelegramMessage,
} from "../types";
import { ownerUserId } from "../config/env";
import {
  ALL_MODELS,
  GEMINI_MODELS,
  OPENROUTER_MODELS,
  type ModelEntry,
} from "../config/defaults";
import {
  sendMessage,
  getMe,
  getWebhookInfo,
  setWebhook,
  deleteWebhook,
} from "../telegram/client";
import { escapeHtml, buildInlineKeyboard } from "../telegram/entities";
import { can, roleLabel } from "../domain/roles";
import { mainMenuKeyboard, adminListKeyboard } from "./keyboards";
import { log } from "../observability/logger";
import { t, getUiLanguage, SUPPORTED_LANGUAGES } from "../i18n";
import { getRole, isAuthorized, isOwner, audit } from "../storage/repositories/admins";
import {
  getSettings,
  getGlobalSettings,
  saveSettings,
} from "../storage/repositories/settings";
import { listAdmins } from "../storage/repositories/admins";
import { getStats } from "../storage/repositories/stats";
import { exec, execAll } from "../storage/d1";
import { chunkHtml } from "../formatting/chunker";
import { runFormatterSelfTests } from "../formatting/self-test";
import { listEvents } from "../storage/repositories/debug-events";

const SCOPE = "admin.commands";
const VERSION = "v2.0.0";
// Build date — bumped manually per release. Cloudflare Workers have no
// long-running process, so there's no runtime "uptime"; this constant plus
// the current server time are the closest proxy.
const BUILD_DATE = "2025-01-15";

// ============================================================
// Public handlers
// ============================================================

/** /start — welcome + bot intro. Anyone. */
export async function handleStart(env: Env, message: TelegramMessage): Promise<void> {
  const fromId = message.from?.id ?? 0;
  // Get user settings to read UI language (default English)
  let lang = getUiLanguage();
  try {
    if (fromId) {
      const settings = await getSettings(env, fromId);
      lang = getUiLanguage(settings);
    }
  } catch { /* use default */ }

  const name = message.from?.first_name ? ` ${escapeHtml(message.from.first_name)}` : "";
  const welcome = t(lang, "start.welcome");
  const desc = t(lang, "start.description");
  const chooseLang = t(lang, "start.choose_language");

  const text =
    `${welcome}${name}! 👋\n\n` +
    `<b>AI Admin</b>\n` +
    `${desc}\n\n` +
    `📝 AI Rewrite & Formatting\n` +
    `✅ Approval System\n` +
    `📅 Post Scheduling\n` +
    `👥 Role-based Admin Management\n\n` +
    `/help — ${t(lang, "help.title")}\n` +
    `/menu — ${t(lang, "menu.title")}\n\n` +
    `${chooseLang}`;

  // Build language selector keyboard
  const langButtons = SUPPORTED_LANGUAGES.map((l) => ({
    text: `${l.flag} ${l.label}${l.code === lang ? " ✅" : ""}`,
    callback_data: `set:uilang:${l.code}`,
  }));
  const keyboard = buildInlineKeyboard([langButtons]);

  await safeSend(env, message.chat.id, text, keyboard);
}

/** /help — list commands + role permissions. Anyone. */
export async function handleHelp(env: Env, message: TelegramMessage): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let role: Role | null = null;
  try {
    const authorized = await isAuthorized(env, fromId);
    if (authorized) role = await getRole(env, fromId);
  } catch (e) {
    log("warn", SCOPE, "help: auth check failed", { error: String(e) });
  }

  const lines: string[] = [];
  lines.push("📚 <b>دستورات ربات</b>\n");
  lines.push("/start — معرفی ربات");
  lines.push("/help — همین راهنما");
  lines.push("/version — اطلاعات نسخه و ساخت (همه)");
  lines.push("/menu — باز کردن منوی اصلی (ادمین‌ها)");
  lines.push("/footer &lt;متن&gt; — تغییر فوتر (مالک/ویراستار)");
  lines.push("/checkperms — بررسی دسترسی‌های ربات در کانال (مالک/ویراستار)");
  lines.push("/stats — آمار فعالیت (همه ادمین‌ها)");
  lines.push("/models — لیست مدل‌های هوش مصنوعی + سلامت (همه ادمین‌ها)");
  lines.push("/admins — مدیریت ادمین‌ها (فقط مالک)");
  lines.push("/schedule &lt;زمان&gt; — زمان‌بندی پست بعدی");
  lines.push("/ping — وضعیت ربات (فقط مالک)");
  lines.push("/health — بررسی سلامت سیستم (فقط مالک)");
  lines.push("/diag — گزارش تشخیصی کامل (فقط مالک)");
  lines.push("/test — اجرای تست‌های قالب‌بندی (فقط مالک)");
  lines.push("/reset &lt;stats|debug|jobs|all&gt; — صفر کردن آمار/لاگ/شغل‌ها (فقط مالک)");
  lines.push("/queue — وضعیت صف شغل‌ها (فقط مالک)");
  lines.push("/audit [n] — رویدادهای حساس اخیر (فقط مالک)");
  lines.push("/webhook &lt;info|set &lt;url&gt;|delete|test&gt; — مدیریت وب‌هوک (فقط مالک)");
  lines.push("/broadcast &lt;متن&gt; — پیام به همه ادمین‌ها (فقط مالک)");

  lines.push("\n👥 <b>نقش‌ها</b>");
  lines.push("• مالک — دسترسی کامل + مدیریت ادمین‌ها");
  lines.push("• ویراستار — انتشار/تایید/رد/زمان‌بندی + تنظیمات");
  lines.push("• بازبین — تایید/رد + آمار");
  lines.push("• بیننده — فقط آمار");

  if (role) {
    lines.push(`\n🎫 نقش شما: <b>${escapeHtml(roleLabel(role))}</b>`);
  } else {
    lines.push("\n🎫 شما ادمین نیستید. دستور /menu برای ادمین‌هاست.");
  }

  await safeSend(env, message.chat.id, lines.join("\n"));
}

/** /menu — main admin menu. Requires any admin role. */
export async function handleMenu(env: Env, message: TelegramMessage): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let role: Role | null = null;
  let authorized = false;
  try {
    authorized = await isAuthorized(env, fromId);
    if (authorized) role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "menu: auth check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی. بعداً تلاش کنید.");
    return;
  }

  if (!authorized || !role) {
    await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
    return;
  }

  const text =
    `🎛 <b>منوی مدیریت</b>\n\n` +
    `نقش: <b>${escapeHtml(roleLabel(role))}</b>\n` +
    `یک گزینه را انتخاب کنید:`;
  await safeSend(env, message.chat.id, text, mainMenuKeyboard(role));
}

/** /footer <text> — change footer. Owner or editor. */
export async function handleFooter(
  env: Env,
  message: TelegramMessage,
  args: string,
): Promise<void> {
  const fromId = message.from?.id ?? 0;

  let role: Role | null = null;
  try {
    const authorized = await isAuthorized(env, fromId);
    if (!authorized) {
      await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
      return;
    }
    role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "footer: auth failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }

  if (!can(role, "change_footer")) {
    await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
    return;
  }

  const newFooter = args.trim();
  if (!newFooter) {
    await safeSend(
      env,
      message.chat.id,
      "⚠️ استفاده: <code>/footer متن فوتر</code>\nمثال: <code>/footer 🌀 @ILIVIR3</code>",
    );
    return;
  }

  try {
    const settings = await getSettings(env, fromId);
    settings.footerText = newFooter;
    await saveSettings(env, fromId, settings);
  } catch (e) {
    log("error", SCOPE, "footer: saveSettings failed", { error: String(e) });
    await safeSend(env, message.chat.id, "❌ خطا در ذخیره تنظیمات.");
    return;
  }

  await safeSend(
    env,
    message.chat.id,
    `✅ فوتر بروزرسانی شد:\n<blockquote>${escapeHtml(newFooter)}</blockquote>`,
  );
}

/** /checkperms — report bot permissions in TARGET_CHANNEL. Owner or editor. */
export async function handleCheckperms(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let role: Role | null = null;
  try {
    const authorized = await isAuthorized(env, fromId);
    if (!authorized) {
      await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
      return;
    }
    role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "checkperms: auth failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }

  if (!can(role, "change_settings")) {
    await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
    return;
  }

  let me: { username?: string; first_name?: string; id?: number } = {};
  let hook: {
    url?: string;
    pending_update_count?: number;
    last_error_date?: number;
    last_error_message?: string;
    max_connections?: number;
  } = {};
  try {
    me = await getMe(env.BOT_TOKEN);
    hook = await getWebhookInfo(env.BOT_TOKEN);
  } catch (e) {
    log("error", SCOPE, "checkperms: getMe/getWebhookInfo failed", { error: String(e) });
    await safeSend(env, message.chat.id, "❌ خطا در دریافت اطلاعات ربات.");
    return;
  }

  const lines: string[] = [];
  lines.push("🔍 <b>وضعیت ربات</b>\n");
  lines.push(`نام: ${escapeHtml(me.first_name ?? "?")}`);
  lines.push(`یوزرنیم: @${escapeHtml(me.username ?? "?")}`);
  lines.push(`کانال هدف: <code>${escapeHtml(env.TARGET_CHANNEL)}</code>`);
  lines.push("");
  lines.push("<b>Webhook</b>");
  lines.push(`URL: <code>${escapeHtml(hook.url ?? "(none)")}</code>`);
  lines.push(`پending updates: ${hook.pending_update_count ?? 0}`);
  lines.push(`max connections: ${hook.max_connections ?? "?"}`);
  if (hook.last_error_message) {
    const when = hook.last_error_date
      ? new Date(hook.last_error_date * 1000).toISOString()
      : "?";
    lines.push(`⚠️ آخرین خطا: <code>${escapeHtml(hook.last_error_message)}</code> @ ${when}`);
  }
  lines.push("");
  lines.push("ℹ️ نکته: برای ارسال پیام به کانال، ربات باید ادمین کانال با دسترسی <b>Post Messages</b> باشد. این دسترسی در Bot API قابل مشاهده نیست؛ از تنظیمات کانال بررسی کنید.");

  await safeSend(env, message.chat.id, lines.join("\n"));
}

/** /stats — global + per-admin stats. Any admin. */
export async function handleStats(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let role: Role | null = null;
  try {
    const authorized = await isAuthorized(env, fromId);
    if (!authorized) {
      await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
      return;
    }
    role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "stats: auth failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }

  if (!can(role, "view_stats")) {
    await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
    return;
  }

  let global: Stats;
  let mine: Stats;
  try {
    global = await getStats(env, "global");
    mine = await getStats(env, `u:${fromId}`);
  } catch (e) {
    log("error", SCOPE, "stats: getStats failed", { error: String(e) });
    await safeSend(env, message.chat.id, "❌ خطا در دریافت آمار.");
    return;
  }

  const fmt = (s: Stats, title: string): string => {
    return (
      `${title}:\n` +
      `  📥 دریافت‌شده: ${s.totalReceived}\n` +
      `  📤 منتشرشده: ${s.totalPublished}\n` +
      `  ✍️ بازنویسی‌شده: ${s.totalRewritten}\n` +
      `  ❌ ناموفق: ${s.totalFailed}\n` +
      `  ✅ تاییدها: ${s.totalApprovals}\n` +
      `  🚫 ردشده: ${s.totalRejected}\n` +
      `  📅 زمان‌بندی‌شده: ${s.totalScheduled}\n` +
      `  🤖 فراخوانی AI: ${s.aiCalls}\n` +
      `  ⚠️ شکست AI: ${s.aiFailures}`
    );
  };

  const last = global.lastUpdated
    ? new Date(global.lastUpdated).toISOString()
    : "?";

  // --- Bar chart + derived metrics (global only) ---
  const chartBlock = renderStatsChart(global);
  const successRateBlock = renderSuccessRate(global);
  const aiBlock = renderAiMetrics(global);

  const text =
    `📊 <b>آمار فعالیت</b>\n\n` +
    `${fmt(global, "🌐 کلی")}\n\n` +
    `${chartBlock}\n\n` +
    `${successRateBlock}\n\n` +
    `${aiBlock}\n\n` +
    `${fmt(mine, "👤 شما")}\n\n` +
    `آخرین بروزرسانی: <code>${last}</code>`;

  // Keep under Telegram's 4096 visible-char limit; chunk if needed.
  const parts = chunkHtml(text, 4000, "");
  for (const part of parts) {
    await safeSend(env, message.chat.id, part);
  }
}

// ============================================================
// Stats-chart helpers (Unicode block bars)
// ============================================================

/**
 * Render a horizontal bar chart of published / rewritten / failed counts.
 *
 * Bars are scaled relative to the largest of the three values, capped at
 * MAX_BAR_CHARS (20) characters wide. Each line ends with the raw count.
 * If all three values are zero, returns a small "(no data)" note.
 */
const BAR_FILL = "█";
const MAX_BAR_CHARS = 20;

function renderStatsChart(s: Stats): string {
  const items: { label: string; value: number }[] = [
    { label: "📤 انتشار", value: s.totalPublished },
    { label: "✏️ بازنویسی", value: s.totalRewritten },
    { label: "❌ خطا", value: s.totalFailed },
  ];

  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.every((i) => i.value === 0)) {
    return "<b>📈 نمودار</b>\n<i>(بدون داده)</i>";
  }

  const lines: string[] = ["<b>📈 نمودار</b>"];
  for (const it of items) {
    const width = it.value === 0 ? 0 : Math.max(1, Math.round((it.value / max) * MAX_BAR_CHARS));
    const bar = BAR_FILL.repeat(width);
    lines.push(`${it.label}: <code>${bar}</code> ${it.value}`);
  }
  return lines.join("\n");
}

/**
 * Success rate = published / (published + failed) * 100.
 * Returns "—" if denominator is zero (no terminations yet).
 */
function renderSuccessRate(s: Stats): string {
  const denom = s.totalPublished + s.totalFailed;
  if (denom === 0) {
    return "<b>🎯 نرخ موفقیت</b>: <i>—</i> (بدون داده)";
  }
  const rate = (s.totalPublished / denom) * 100;
  const rounded = Math.round(rate * 10) / 10;
  return (
    `<b>🎯 نرخ موفقیت</b>: <code>${rounded}%</code>\n` +
    `   (${s.totalPublished} منتشر / ${denom} کل)`
  );
}

/**
 * AI usage summary: total calls, failure rate.
 */
function renderAiMetrics(s: Stats): string {
  if (s.aiCalls === 0) {
    return "<b>🤖 هوش مصنوعی</b>: <i>بدون فراخوانی</i>";
  }
  const rate = (s.aiFailures / s.aiCalls) * 100;
  const rounded = Math.round(rate * 10) / 10;
  return (
    `<b>🤖 هوش مصنوعی</b>\n` +
    `   فراخوانی: <code>${s.aiCalls}</code>\n` +
    `   شکست: <code>${s.aiFailures}</code> (<code>${rounded}%</code>)`
  );
}

/** /admins — owner ONLY. List admins with management keyboard. */
export async function handleAdmins(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;

  // OWNER-ONLY: check isOwner directly. This is the central fix for V1 bug #4
  // (any admin could manage admins). We do NOT trust isAuthorized alone.
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "admins: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }

  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  let admins: import("../types").AdminRecord[] = [];
  try {
    admins = await listAdmins(env);
  } catch (e) {
    log("error", SCOPE, "admins: listAdmins failed", { error: String(e) });
    await safeSend(env, message.chat.id, "❌ خطا در دریافت لیست ادمین‌ها.");
    return;
  }

  const keyboard = adminListKeyboard(admins, ownerUserId(env));
  const text =
    `👥 <b>مدیریت ادمین‌ها</b>\n\n` +
    `تعداد: ${admins.length}\n` +
    `برای حذف، روی ردیف ادمین ضربه بزنید. مالک قابل حذف نیست.\n` +
    `برای افزودن، «➕ افزودن ادمین» را بزنید.`;
  await safeSend(env, message.chat.id, text, keyboard);
}

/** /schedule <time> — schedule the NEXT post for this user. Any admin. */
export async function handleSchedule(
  env: Env,
  message: TelegramMessage,
  args: string,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let role: Role | null = null;
  try {
    const authorized = await isAuthorized(env, fromId);
    if (!authorized) {
      await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
      return;
    }
    role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "schedule: auth failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }

  if (!can(role, "schedule")) {
    await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
    return;
  }

  const when = parseScheduleArg(args);
  if (when === null) {
    await safeSend(
      env,
      message.chat.id,
      "⚠️ فرمت زمان نامعتبر.\n\n" +
        "<b>مثال‌ها:</b>\n" +
        "<code>/schedule in 30m</code> — ۳۰ دقیقه دیگر\n" +
        "<code>/schedule in 2h</code> — ۲ ساعت دیگر\n" +
        "<code>/schedule at 15:30</code> — امروز ساعت ۱۵:۳۰ (به وقت تهران)\n" +
        "<code>/schedule tomorrow 09:00</code> — فردا ساعت ۰۹:۰۰",
    );
    return;
  }

  // Set the transient KV flag. The next non-command message from this user
  // will be processed as a scheduled post (the queue consumer honors this).
  const flagKey = `sched_next:${fromId}`;
  try {
    await env.AI_ADMIN_KV.put(flagKey, String(when), {
      expirationTtl: 6 * 60 * 60, // 6h max lead time
    });
  } catch (e) {
    log("error", SCOPE, "schedule: KV put failed", { error: String(e) });
    await safeSend(env, message.chat.id, "❌ خطا در ذخیره زمان‌بندی.");
    return;
  }

  const tehranTime = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(when));

  await safeSend(
    env,
    message.chat.id,
    `✅ زمان‌بندی فعال شد.\n\n` +
      `📅 پست بعدی شما در: <b>${escapeHtml(tehranTime)}</b>\n` +
      `⏱ شمارش معکوس: ${Math.max(0, Math.round((when - Date.now()) / 1000))} ثانیه\n\n` +
      `حالا پیام مورد نظر را بفرستید تا در زمان تعیین‌شده منتشر شود.\n` +
      `برای لغو: <code>/schedule cancel</code>`,
  );
}

/** /ping — owner. Uptime-ish info. */
export async function handlePing(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "ping: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }

  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک است.");
    return;
  }

  const now = new Date();
  const tehranNow = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "short",
    timeStyle: "medium",
  }).format(now);

  let hookPending = "?";
  try {
    const hook = await getWebhookInfo(env.BOT_TOKEN);
    hookPending = String(hook.pending_update_count ?? 0);
  } catch {
    /* ignore */
  }

  const text =
    `🏓 <b>pong</b>\n\n` +
    `نسخه: <code>${VERSION}</code>\n` +
    `زمان سرور: <code>${now.toISOString()}</code>\n` +
    `زمان تهران: <code>${escapeHtml(tehranNow)}</code>\n` +
    `صف Webhook: <code>${hookPending}</code>\n` +
    `کانال: <code>${escapeHtml(env.TARGET_CHANNEL)}</code>\n` +
    `مالک: <code>${ownerUserId(env)}</code>`;
  await safeSend(env, message.chat.id, text);
}

/** /version — version + build info. Anyone (public command). */
export async function handleVersion(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const now = new Date();
  const tehranNow = new Intl.DateTimeFormat("fa-IR", {
    timeZone: "Asia/Tehran",
    dateStyle: "full",
    timeStyle: "medium",
  }).format(now);

  const text =
    `🏷 <b>اطلاعات نسخه</b>\n\n` +
    `<b>نسخه</b>: <code>${VERSION}</code>\n` +
    `<b>تاریخ ساخت</b>: <code>${BUILD_DATE}</code>\n` +
    `<b>زمان سرور</b>: <code>${now.toISOString()}</code>\n` +
    `<b>زمان تهران</b>: <code>${escapeHtml(tehranNow)}</code>\n\n` +
    `<b>📦 آمار ساخت</b>\n` +
    `• فایل‌های تایپ‌اسکریپت: <code>40</code>\n` +
    `• مدل‌های هوش مصنوعی: <code>${ALL_MODELS.length}</code>\n` +
    `• کرون‌تریگرها: <code>1</code>\n\n` +
    `🌀 <i>AI Admin V2 — ساخته‌شده برای Cloudflare Workers</i>`;
  await safeSend(env, message.chat.id, text);
}

/** /models — list all 12 AI models + current health. Any admin. */
export async function handleModels(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let authorized = false;
  try {
    authorized = await isAuthorized(env, fromId);
  } catch (e) {
    log("error", SCOPE, "models: auth check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!authorized) {
    await safeSend(env, message.chat.id, "⛔ دسترسی غیرمجاز");
    return;
  }

  // Read the global (owner) settings to know which model is currently active.
  let activeProvider: "gemini" | "openrouter" = "gemini";
  let activeGeminiModel = "";
  let activeOpenrouterModel = "";
  try {
    const settings = await getGlobalSettings(env);
    activeProvider = settings.aiProvider;
    activeGeminiModel = settings.geminiModel;
    activeOpenrouterModel = settings.openrouterModel;
  } catch (e) {
    log("warn", SCOPE, "models: getGlobalSettings failed", { error: String(e) });
  }

  // Parallel KV reads for health cache (one read per model).
  const geminiHealth = await Promise.all(
    GEMINI_MODELS.map((m) => readHealthFor(env, "gemini", m.id)),
  );
  const openrouterHealth = await Promise.all(
    OPENROUTER_MODELS.map((m) => readHealthFor(env, "openrouter", m.id)),
  );

  const lines: string[] = [];
  lines.push("🤖 <b>لیست مدل‌های هوش مصنوعی</b>");
  lines.push(`تعداد کل: <code>${ALL_MODELS.length}</code>`);
  lines.push(`ارائه‌دهنده فعال: <code>${escapeHtml(activeProvider)}</code>`);
  lines.push("");

  lines.push("<blockquote><b>🔷 Gemini</b></blockquote>");
  GEMINI_MODELS.forEach((m, i) => {
    const isActive = activeProvider === "gemini" && activeGeminiModel === m.id;
    lines.push(formatModelLine(m, geminiHealth[i], isActive));
  });
  lines.push("");

  lines.push("<blockquote><b>🟠 OpenRouter</b></blockquote>");
  OPENROUTER_MODELS.forEach((m, i) => {
    const isActive =
      activeProvider === "openrouter" && activeOpenrouterModel === m.id;
    lines.push(formatModelLine(m, openrouterHealth[i], isActive));
  });

  lines.push("");
  lines.push("<i>✅ سالم — ⚠️ ناسالم — ❓ ناشناخته — 🟢 فعال</i>");

  await safeSend(env, message.chat.id, lines.join("\n"));
}

/** /health — system health check. Owner only. */
export async function handleHealth(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "health: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  const lines: string[] = [];
  lines.push("🩺 <b>وضعیت سیستم</b>\n");

  // --- Telegram Bot API ---
  try {
    const me = await getMe(env.BOT_TOKEN);
    lines.push(`🔵 <b>Telegram API</b>: 🟢 سالم — @${escapeHtml(me.username ?? "?")}`);
  } catch (e) {
    lines.push(
      `🔵 <b>Telegram API</b>: 🔴 قطع — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  // --- Webhook info ---
  try {
    const hook = await getWebhookInfo(env.BOT_TOKEN);
    const pending = hook.pending_update_count ?? 0;
    const lastErr = hook.last_error_message;
    if (pending > 0 || lastErr) {
      lines.push(`🔗 <b>Webhook</b>: 🟡 هشدار — pending: <code>${pending}</code>`);
      if (lastErr) {
        const when = hook.last_error_date
          ? new Date(hook.last_error_date * 1000).toISOString()
          : "?";
        lines.push(
          `   آخرین خطا: <code>${escapeHtml(lastErr)}</code> @ ${when}`,
        );
      }
    } else {
      lines.push(`🔗 <b>Webhook</b>: 🟢 سالم — pending: <code>0</code>`);
    }
  } catch (e) {
    lines.push(
      `🔗 <b>Webhook</b>: 🔴 خطا — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  // --- D1 ---
  try {
    const t0 = Date.now();
    const rows = await execAll<{ ok: number }>(env.DB, "SELECT 1 as ok");
    const latency = Date.now() - t0;
    const ok = rows.length > 0 && rows[0].ok === 1;
    lines.push(
      `🗄 <b>D1 Database</b>: ${ok ? "🟢" : "🔴"} ${ok ? "سالم" : "خطا"} — latency: <code>${latency}ms</code>`,
    );
  } catch (e) {
    lines.push(
      `🗄 <b>D1 Database</b>: 🔴 خطا — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  // --- KV (write + read probe) ---
  try {
    const t0 = Date.now();
    const probeValue = `probe-${Date.now()}`;
    await env.AI_ADMIN_KV.put("health:probe", probeValue, { expirationTtl: 60 });
    const readBack = await env.AI_ADMIN_KV.get("health:probe");
    const latency = Date.now() - t0;
    const ok = readBack === probeValue;
    lines.push(
      `📦 <b>KV Namespace</b>: ${ok ? "🟢" : "🔴"} ${ok ? "سالم" : "خطا"} — latency: <code>${latency}ms</code>`,
    );
  } catch (e) {
    lines.push(
      `📦 <b>KV Namespace</b>: 🔴 خطا — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  // --- Queue ---
  // Cloudflare Workers Queues cannot be probed directly from inside a fetch
  // handler without enqueuing a real message. We only report that the binding
  // exists (bounded).
  lines.push(
    `📨 <b>Queue</b>: 🟡 محدود (bounded) — تست مستقیم ممکن نیست، binding موجود است`,
  );

  // --- Global stats ---
  try {
    const stats = await getStats(env, "global");
    lines.push("");
    lines.push("<b>📊 آمار کلی</b>");
    lines.push(`📥 دریافت‌شده: <code>${stats.totalReceived}</code>`);
    lines.push(`📤 منتشرشده: <code>${stats.totalPublished}</code>`);
    lines.push(`❌ ناموفق: <code>${stats.totalFailed}</code>`);
  } catch (e) {
    lines.push(
      `📊 <b>آمار</b>: 🔴 خطا — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  await safeSend(env, message.chat.id, lines.join("\n"));
}

/** /diag — diagnostic dump. Owner only. Output may be chunked. */
export async function handleDiag(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "diag: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  const out: string[] = [];
  out.push("🔧 <b>Diag — گزارش تشخیصی کامل</b>\n");

  // --- Env config (masked secrets) ---
  out.push("<b>⚙️ پیکربندی محیط</b>");
  out.push(`BOT_TOKEN: <code>${escapeHtml(maskSecret(env.BOT_TOKEN))}</code>`);
  out.push(`WEBHOOK_SECRET: <code>${escapeHtml(maskSecret(env.WEBHOOK_SECRET))}</code>`);
  out.push(`GEMINI_API_KEY: <code>${escapeHtml(maskSecret(env.GEMINI_API_KEY))}</code>`);
  out.push(`OPENROUTER_API_KEY: <code>${escapeHtml(maskSecret(env.OPENROUTER_API_KEY))}</code>`);
  out.push(`ADMIN_ID: <code>${escapeHtml(env.ADMIN_ID)}</code>`);
  out.push(`TARGET_CHANNEL: <code>${escapeHtml(env.TARGET_CHANNEL)}</code>`);
  out.push(`FOOTER_TEXT: <code>${escapeHtml(env.FOOTER_TEXT ?? "")}</code>`);
  out.push(`DEFAULT_AI_PROVIDER: <code>${escapeHtml(env.DEFAULT_AI_PROVIDER ?? "")}</code>`);
  out.push(`GEMINI_MODEL: <code>${escapeHtml(env.GEMINI_MODEL ?? "")}</code>`);
  out.push(`OPENROUTER_MODEL: <code>${escapeHtml(env.OPENROUTER_MODEL ?? "")}</code>`);
  out.push(`OPENROUTER_FALLBACK_MODELS: <code>${escapeHtml(env.OPENROUTER_FALLBACK_MODELS ?? "")}</code>`);
  out.push(`DEBUG_MODE: <code>${escapeHtml(env.DEBUG_MODE ?? "")}</code>`);
  out.push(`CHANNEL_PROFILE: <code>${escapeHtml(env.CHANNEL_PROFILE ?? "")}</code>`);
  out.push("");

  // --- D1 row counts ---
  try {
    const adminCount = await execCount(env, "SELECT COUNT(*) as c FROM admins");
    const settingsCount = await execCount(env, "SELECT COUNT(*) as c FROM settings");
    const jobsPending = await execCount(env, "SELECT COUNT(*) as c FROM jobs WHERE status = 'pending'");
    const jobsPublished = await execCount(env, "SELECT COUNT(*) as c FROM jobs WHERE status = 'published'");
    const jobsRejected = await execCount(env, "SELECT COUNT(*) as c FROM jobs WHERE status = 'rejected'");
    const jobsFailed = await execCount(env, "SELECT COUNT(*) as c FROM jobs WHERE status = 'failed'");
    const jobsExpired = await execCount(env, "SELECT COUNT(*) as c FROM jobs WHERE status = 'expired'");
    const mgiPending = await execCount(env, "SELECT COUNT(*) as c FROM media_group_items WHERE finalized = 0");
    const debugCount = await execCount(env, "SELECT COUNT(*) as c FROM debug_events");

    out.push("<b>🗄 D1 — تعداد ردیف‌ها</b>");
    out.push(`admins: <code>${adminCount}</code>`);
    out.push(`settings: <code>${settingsCount}</code>`);
    out.push(`jobs (pending): <code>${jobsPending}</code>`);
    out.push(`jobs (published): <code>${jobsPublished}</code>`);
    out.push(`jobs (rejected): <code>${jobsRejected}</code>`);
    out.push(`jobs (failed): <code>${jobsFailed}</code>`);
    out.push(`jobs (expired): <code>${jobsExpired}</code>`);
    out.push(`media_group_items (pending): <code>${mgiPending}</code>`);
    out.push(`debug_events: <code>${debugCount}</code>`);
    out.push("");
  } catch (e) {
    out.push(
      `<b>🗄 D1</b>: 🔴 خطا در شمارش — <code>${escapeHtml(String(e))}</code>\n`,
    );
  }

  // --- KV health cache entries ---
  try {
    const list = await env.AI_ADMIN_KV.list({ prefix: "ai:health:" });
    out.push("<b>📦 KV — کش سلامت مدل‌ها</b>");
    out.push(`تعداد کلیدها: <code>${list.keys.length}</code>`);
    for (const k of list.keys) {
      out.push(`• <code>${escapeHtml(k.name)}</code>`);
    }
    out.push("");
  } catch (e) {
    out.push(
      `<b>📦 KV</b>: 🔴 خطا — <code>${escapeHtml(String(e))}</code>\n`,
    );
  }

  // --- Recent audit_log entries ---
  try {
    const auditRows = await execAll<{
      id: number;
      actor_id: number;
      action: string;
      target: string | null;
      detail: string | null;
      created_at: number;
    }>(
      env.DB,
      "SELECT id, actor_id, action, target, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT 5",
    );
    out.push("<b>📜 audit_log — ۵ رویداد اخیر</b>");
    if (auditRows.length === 0) {
      out.push("(خالی)");
    } else {
      for (const r of auditRows) {
        const when = new Date(r.created_at).toISOString();
        out.push(
          `• [${r.id}] <b>${escapeHtml(r.action)}</b> actor=<code>${r.actor_id}</code> target=<code>${escapeHtml(r.target ?? "")}</code> @ ${when}`,
        );
        if (r.detail) {
          out.push(`  <code>${escapeHtml(r.detail)}</code>`);
        }
      }
    }
    out.push("");
  } catch (e) {
    out.push(
      `<b>📜 audit_log</b>: 🔴 خطا — <code>${escapeHtml(String(e))}</code>\n`,
    );
  }

  // --- Recent debug_events ---
  try {
    const events = await listEvents(env, 5);
    out.push("<b>🐞 debug_events — ۵ رویداد اخیر</b>");
    if (events.length === 0) {
      out.push("(خالی)");
    } else {
      for (const e of events) {
        const when = new Date(e.created_at).toISOString();
        out.push(
          `• [<b>${escapeHtml(e.kind)}</b>] ${escapeHtml(e.summary ?? "")} @ ${when}`,
        );
        if (e.detail) {
          out.push(`  <code>${escapeHtml(e.detail)}</code>`);
        }
      }
    }
  } catch (e) {
    out.push(
      `<b>🐞 debug_events</b>: 🔴 خطا — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  // Chunk if the message exceeds Telegram's 4096 visible-char limit.
  const fullText = out.join("\n");
  const parts = chunkHtml(fullText, 4000, "");
  for (const part of parts) {
    await safeSend(env, message.chat.id, part);
  }
}

/** /test — owner ONLY. Run formatter + cleaner self-tests. */
export async function handleTest(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "test: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  // Pure function — never throws. Safe to call directly.
  const summary = runFormatterSelfTests();

  const lines: string[] = [];
  lines.push("🧪 <b>تست‌های قالب‌بندی</b>\n");
  lines.push(`✅ موفق: <code>${summary.passed}</code>`);
  lines.push(`❌ ناموفق: <code>${summary.failed}</code>`);

  if (summary.failures.length > 0) {
    lines.push("\n<b>جزئیات شکست‌ها:</b>");
    for (const f of summary.failures) {
      lines.push(
        `• <b>${escapeHtml(f.name)}</b>\n   <code>${escapeHtml(f.reason)}</code>`,
      );
    }
    lines.push(
      "\n⚠️ لطفاً گزارش شکست را بررسی کنید — ممکن است یک رگرشن در formatter یا cleaner وجود داشته باشد.",
    );
  } else {
    lines.push("\n🎉 همه تست‌ها موفق بودند.");
  }

  const fullText = lines.join("\n");
  const parts = chunkHtml(fullText, 4000, "");
  for (const part of parts) {
    await safeSend(env, message.chat.id, part);
  }
}

// ============================================================
// /reset — owner ONLY, dangerous, with KV-backed two-step confirmation
// ============================================================

type ResetTarget = "stats" | "debug" | "jobs" | "all";

const RESET_TARGETS: ReadonlySet<ResetTarget> = new Set([
  "stats",
  "debug",
  "jobs",
  "all",
]);

const RESET_CONFIRM_KV_PREFIX = "reset_confirm";
const RESET_CONFIRM_TTL_SEC = 30;

function resetConfirmKey(userId: number): string {
  return `${RESET_CONFIRM_KV_PREFIX}:${userId}`;
}

/**
 * /reset <stats|debug|jobs|all> — owner ONLY.
 *
 * Two-step confirmation:
 *   1. First call: replies with a warning and stores the requested target in
 *      KV (TTL 30s). No destructive action is taken.
 *   2. Second call (within 30s, same target): executes the reset, deletes the
 *      KV flag, and writes an audit_log row.
 *
 * The KV flag is per-user, so a stale confirmation from one owner cannot be
 * consumed by another. The TTL prevents the flag from lingering forever if
 * the owner abandons the operation.
 *
 * Targets:
 *   stats — zero out all numeric stats counters (kept rows; last_updated bumped).
 *   debug — DELETE FROM debug_events (all rows).
 *   jobs  — DELETE FROM jobs WHERE status IN ('published','rejected','expired','failed')
 *           (pending jobs are preserved so in-flight posts aren't dropped).
 *   all   — all of the above, run in parallel.
 */
export async function handleReset(
  env: Env,
  message: TelegramMessage,
  args: string,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "reset: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  const raw = args.trim().toLowerCase() as ResetTarget;
  if (!RESET_TARGETS.has(raw)) {
    await safeSend(
      env,
      message.chat.id,
      "⚠️ استفاده: <code>/reset &lt;stats|debug|jobs|all&gt;</code>\n\n" +
        "• <code>stats</code> — صفر کردن شمارنده‌های آماری\n" +
        "• <code>debug</code> — حذف همه رویدادهای دیباگ\n" +
        "• <code>jobs</code> — حذف شغل‌های تمام‌شده (pending نگه می‌ماند)\n" +
        "• <code>all</code> — همه موارد بالا",
    );
    return;
  }

  const confirmKey = resetConfirmKey(fromId);

  // --- Step 1: check for an existing confirmation flag ---
  let pending: string | null = null;
  try {
    pending = await env.AI_ADMIN_KV.get(confirmKey);
  } catch (e) {
    log("warn", SCOPE, "reset: KV read failed", { error: String(e) });
  }

  if (pending !== raw) {
    // No prior confirmation (or different target) → ask to confirm.
    try {
      await env.AI_ADMIN_KV.put(confirmKey, raw, {
        expirationTtl: RESET_CONFIRM_TTL_SEC,
      });
    } catch (e) {
      log("error", SCOPE, "reset: KV put failed", { error: String(e) });
      await safeSend(
        env,
        message.chat.id,
        "❌ خطا در ذخیره وضعیت تأیید. دوباره تلاش کنید.",
      );
      return;
    }

    const targetLabelFa: Record<ResetTarget, string> = {
      stats: "آمار (stats)",
      debug: "رویدادهای دیباگ (debug)",
      jobs: "شغل‌های تمام‌شده (jobs)",
      all: "همه (all)",
    };
    await safeSend(
      env,
      message.chat.id,
      `⚠️ <b>این عمل غیرقابل بازگشت است.</b>\n` +
        `هدف: <b>${escapeHtml(targetLabelFa[raw])}</b>\n` +
        `برای تأیید، در عرض ۳۰ ثانیه دوباره بفرستید:\n` +
        `<code>/reset ${escapeHtml(raw)}</code>`,
    );
    return;
  }

  // --- Step 2: confirmation matches → execute ---
  // Clear the flag FIRST so a retry can't double-fire if execution throws.
  try {
    await env.AI_ADMIN_KV.delete(confirmKey);
  } catch (e) {
    log("warn", SCOPE, "reset: KV delete failed", { error: String(e) });
  }

  const tasks: Promise<{ target: string; ok: boolean; detail: string }>[] = [];

  if (raw === "stats" || raw === "all") {
    tasks.push(resetStats(env));
  }
  if (raw === "debug" || raw === "all") {
    tasks.push(resetDebug(env));
  }
  if (raw === "jobs" || raw === "all") {
    tasks.push(resetJobs(env));
  }

  const results = await Promise.all(
    tasks.map((p) =>
      p.catch((e): { target: string; ok: boolean; detail: string } => ({
        target: "unknown",
        ok: false,
        detail: String(e),
      })),
    ),
  );

  // --- Audit log ---
  try {
    await audit(
      env,
      fromId,
      "reset",
      raw,
      JSON.stringify(
        results.map((r) => ({ target: r.target, ok: r.ok, detail: r.detail })),
      ),
    );
  } catch (e) {
    log("warn", SCOPE, "reset: audit log failed", { error: String(e) });
  }

  // --- Reply ---
  const lines: string[] = [];
  lines.push("🧹 <b>ریست اجرا شد</b>\n");
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    lines.push(
      `${icon} <b>${escapeHtml(r.target)}</b> — ${r.ok ? "انجام شد" : `<code>${escapeHtml(r.detail)}</code>`}`,
    );
  }
  lines.push(`\n🎯 هدف: <code>${escapeHtml(raw)}</code>`);
  lines.push("📜 در audit_log ثبت شد.");

  await safeSend(env, message.chat.id, lines.join("\n"));
}

/** Zero all numeric stats counters (rows kept; last_updated bumped). */
async function resetStats(
  env: Env,
): Promise<{ target: string; ok: boolean; detail: string }> {
  try {
    await exec(
      env.DB,
      `UPDATE stats SET
        total_received = 0,
        total_published = 0,
        total_rewritten = 0,
        total_failed = 0,
        total_approvals = 0,
        total_rejected = 0,
        total_scheduled = 0,
        ai_calls = 0,
        ai_failures = 0,
        last_updated = ?`,
      Date.now(),
    );
    return { target: "stats", ok: true, detail: "all counters zeroed" };
  } catch (e) {
    return { target: "stats", ok: false, detail: String(e) };
  }
}

/** Delete every row from debug_events. */
async function resetDebug(
  env: Env,
): Promise<{ target: string; ok: boolean; detail: string }> {
  try {
    const result = await exec(env.DB, "DELETE FROM debug_events");
    const deleted = result.meta?.changes ?? 0;
    return { target: "debug", ok: true, detail: `${deleted} rows deleted` };
  } catch (e) {
    return { target: "debug", ok: false, detail: String(e) };
  }
}

/** Delete finished jobs (published/rejected/expired/failed); keep pending. */
async function resetJobs(
  env: Env,
): Promise<{ target: string; ok: boolean; detail: string }> {
  try {
    const result = await exec(
      env.DB,
      "DELETE FROM jobs WHERE status IN ('published','rejected','expired','failed')",
    );
    const deleted = result.meta?.changes ?? 0;
    return { target: "jobs", ok: true, detail: `${deleted} rows deleted (pending kept)` };
  } catch (e) {
    return { target: "jobs", ok: false, detail: String(e) };
  }
}

// ============================================================
// /queue — owner ONLY. Job queue + status overview.
// ============================================================

interface JobStatusCount {
  status: string;
  c: number;
}

interface JobTypeCount {
  type: string;
  c: number;
}

interface PendingJobRow {
  id: string;
  type: string;
  scheduled_for: number | null;
  created_at: number;
}

interface FailedJobRow {
  id: string;
  type: string;
  error_message: string | null;
  created_at: number;
}

/**
 * /queue — owner ONLY. Show queue + job status.
 *
 * Returns:
 *   • Summary section — counts by status (pending/published/rejected/expired/
 *     failed), counts by type (scheduled_post vs approval), and a "due-now"
 *     counter (scheduled_for <= Date.now() AND status='pending').
 *   • Detail section — the 5 most recent pending jobs and the 3 oldest failed
 *     jobs (with error_message).
 *
 * All dynamic values are HTML-escaped. Output is chunked via chunkHtml so it
 * never exceeds the 4096-char Telegram limit.
 */
export async function handleQueue(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "queue: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  try {
    // Run all count queries in parallel for speed.
    const [statusCounts, typeCounts, dueNowRows, recentPending, oldestFailed] =
      await Promise.all([
        execAll<JobStatusCount>(
          env.DB,
          "SELECT status, COUNT(*) as c FROM jobs GROUP BY status",
        ),
        execAll<JobTypeCount>(
          env.DB,
          "SELECT type, COUNT(*) as c FROM jobs GROUP BY type",
        ),
        execAll<{ c: number }>(
          env.DB,
          "SELECT COUNT(*) as c FROM jobs WHERE status = 'pending' AND scheduled_for IS NOT NULL AND scheduled_for <= ?",
          Date.now(),
        ),
        execAll<PendingJobRow>(
          env.DB,
          "SELECT id, type, scheduled_for, created_at FROM jobs WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5",
        ),
        execAll<FailedJobRow>(
          env.DB,
          "SELECT id, type, error_message, created_at FROM jobs WHERE status = 'failed' ORDER BY created_at ASC LIMIT 3",
        ),
      ]);

    const byStatus = new Map<string, number>();
    for (const r of statusCounts) byStatus.set(r.status, r.c);
    const byType = new Map<string, number>();
    for (const r of typeCounts) byType.set(r.type, r.c);
    const dueNow = dueNowRows.length > 0 ? (dueNowRows[0].c ?? 0) : 0;

    const pending = byStatus.get("pending") ?? 0;
    const published = byStatus.get("published") ?? 0;
    const rejected = byStatus.get("rejected") ?? 0;
    const expired = byStatus.get("expired") ?? 0;
    const failed = byStatus.get("failed") ?? 0;
    const total = pending + published + rejected + expired + failed;

    const scheduledPost = byType.get("scheduled_post") ?? 0;
    const approval = byType.get("approval") ?? 0;

    const lines: string[] = [];
    lines.push("📥 <b>صف شغل‌ها</b>\n");

    // --- Summary section ---
    lines.push("<b>📊 خلاصه</b>");
    lines.push(`کل: <code>${total}</code>`);
    lines.push(
      `• در انتظار (pending): <code>${pending}</code>` +
        (dueNow > 0 ? ` — از این تعداد <b>${dueNow}</b> موعد‌رسیده` : ""),
    );
    lines.push(`• منتشرشده (published): <code>${published}</code>`);
    lines.push(`• ردشده (rejected): <code>${rejected}</code>`);
    lines.push(`• منقضی‌شده (expired): <code>${expired}</code>`);
    lines.push(`• ناموفق (failed): <code>${failed}</code>`);
    lines.push("");
    lines.push("<b>🔎 بر اساس نوع</b>");
    lines.push(`• زمان‌بندی‌شده: <code>${scheduledPost}</code>`);
    lines.push(`• تایید (approval): <code>${approval}</code>`);

    // --- Detail section: recent pending ---
    lines.push("");
    lines.push("<b>🗂 ۵ شغل در انتظار اخیر</b>");
    if (recentPending.length === 0) {
      lines.push("<i>(هیچ شغل در انتظاری وجود ندارد)</i>");
    } else {
      for (const j of recentPending) {
        const sched = j.scheduled_for
          ? new Date(j.scheduled_for).toISOString()
          : "—";
        const created = new Date(j.created_at).toISOString();
        lines.push(
          `• <code>${escapeHtml(j.id)}</code> <i>${escapeHtml(j.type)}</i>\n` +
            `   sched: <code>${sched}</code> • created: <code>${created}</code>`,
        );
      }
    }

    // --- Detail section: oldest failed ---
    lines.push("");
    lines.push("<b>⚠️ ۳ شغل ناموفق قدیمی</b>");
    if (oldestFailed.length === 0) {
      lines.push("<i>(هیچ شغل ناموفقی وجود ندارد)</i>");
    } else {
      for (const j of oldestFailed) {
        const created = new Date(j.created_at).toISOString();
        const err = j.error_message
          ? escapeHtml(j.error_message.slice(0, 200))
          : "<i>(بدون پیام خطا)</i>";
        lines.push(
          `• <code>${escapeHtml(j.id)}</code> <i>${escapeHtml(j.type)}</i>\n` +
            `   created: <code>${created}</code>\n` +
            `   error: <code>${err}</code>`,
        );
      }
    }

    // --- Note ---
    lines.push("");
    lines.push("ℹ️ Cron هر دقیقه این صف را پردازش می‌کند.");

    const fullText = lines.join("\n");
    const parts = chunkHtml(fullText, 4000, "");
    for (const part of parts) {
      await safeSend(env, message.chat.id, part);
    }
  } catch (e) {
    log("error", SCOPE, "queue: query failed", { error: String(e) });
    await safeSend(
      env,
      message.chat.id,
      "❌ خطا در دریافت وضعیت صف.\n<code>" + escapeHtml(String(e)) + "</code>",
    );
  }
}

// ============================================================
// /audit — owner ONLY. Recent audit log.
// ============================================================

interface AuditRow {
  actor_id: number;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
}

/**
 * /audit [limit] — owner ONLY. Show recent audit log entries.
 *
 * The optional limit arg defaults to 10 and is capped at 30. Entries are
 * formatted with a Persian relative timestamp (e.g. "۵ دقیقه پیش") plus the
 * actor_id, action, target, and detail. The whole entry is wrapped in a
 * <blockquote> for visual separation.
 */
export async function handleAudit(
  env: Env,
  message: TelegramMessage,
  args: string,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "audit: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  // Parse limit: default 10, max 30. Reject non-numeric args gracefully.
  let limit = 10;
  const raw = args.trim();
  if (raw) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      await safeSend(
        env,
        message.chat.id,
        "⚠️ استفاده: <code>/audit [n]</code>\nمثال: <code>/audit 20</code> — n عدد صحیح مثبت (حداکثر ۳۰)",
      );
      return;
    }
    limit = Math.min(30, n);
  }

  let rows: AuditRow[] = [];
  try {
    rows = await execAll<AuditRow>(
      env.DB,
      "SELECT actor_id, action, target, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?",
      limit,
    );
  } catch (e) {
    log("error", SCOPE, "audit: query failed", { error: String(e) });
    await safeSend(
      env,
      message.chat.id,
      "❌ خطا در خواندن audit_log.\n<code>" + escapeHtml(String(e)) + "</code>",
    );
    return;
  }

  if (rows.length === 0) {
    await safeSend(env, message.chat.id, "📜 هیچ رویداد حساسی ثبت نشده است.");
    return;
  }

  const lines: string[] = [];
  lines.push(`📜 <b>آخرین رویدادهای حساس</b> (${rows.length} مورد)\n`);
  for (const r of rows) {
    const when = relativeTime(r.created_at);
    const actor = `<code>${r.actor_id}</code>`;
    const action = escapeHtml(r.action);
    const target = r.target ? `(<code>${escapeHtml(r.target)}</code>)` : "";
    const detail = r.detail ? `: ${escapeHtml(r.detail)}` : "";
    lines.push(
      `<blockquote>[${when}] ${actor} → <b>${action}</b> ${target}${detail}</blockquote>`,
    );
  }

  const fullText = lines.join("\n");
  const parts = chunkHtml(fullText, 4000, "");
  for (const part of parts) {
    await safeSend(env, message.chat.id, part);
  }
}

/**
 * Format an epoch-ms timestamp as a short Persian relative-time string.
 *
 * Returns:
 *   • "همین الان"           for < 1 minute
 *   • "N دقیقه پیش"          for 1..59 minutes (N in Persian digits)
 *   • "N ساعت پیش"           for 1..23 hours
 *   • "N روز پیش"            for 1..29 days
 *   • ISO date (yyyy-mm-dd)  for 30+ days
 */
function relativeTime(ms: number): string {
  const now = Date.now();
  const diff = Math.max(0, now - ms);
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);

  const fa = (n: number): string =>
    n.toLocaleString("fa-IR", { useGrouping: false });

  if (sec < 60) return "همین الان";
  if (min < 60) return `${fa(min)} دقیقه پیش`;
  if (hr < 24) return `${fa(hr)} ساعت پیش`;
  if (day < 30) return `${fa(day)} روز پیش`;
  return new Date(ms).toISOString().slice(0, 10);
}

// ============================================================
// /webhook — owner ONLY. Manage the Telegram webhook.
// ============================================================

const WEBHOOK_ALLOWED_UPDATES: readonly string[] = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
  "callback_query",
];

/**
 * /webhook &lt;info|set &lt;url&gt;|delete|test&gt; — owner ONLY.
 *
 * Subcommands:
 *   (no arg) or "info"   → getWebhookInfo + color-coded health summary.
 *   "set <https-url>"    → setWebhook with env.WEBHOOK_SECRET + allowed_updates.
 *   "delete"             → deleteWebhook (drop_pending_updates=false).
 *   "test"               → reply with a confirmation message (proves the
 *                          webhook is receiving — if you see this, the webhook
 *                          delivered the update that triggered this command).
 *
 * Security: `set` rejects any URL that does not start with https:// (so a
 * misconfigured or attacker-controlled http:// URL can never be set). All
 * subcommands are audit-logged.
 */
export async function handleWebhook(
  env: Env,
  message: TelegramMessage,
  args: string,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "webhook: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  const trimmed = args.trim();
  const firstSpace = trimmed.indexOf(" ");
  const sub =
    firstSpace === -1
      ? trimmed.toLowerCase()
      : trimmed.slice(0, firstSpace).toLowerCase();
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  // Default to "info" if no subcommand given.
  const subcmd = sub === "" ? "info" : sub;

  switch (subcmd) {
    case "info":
      return handleWebhookInfo(env, message);
    case "set":
      return handleWebhookSet(env, message, rest, fromId);
    case "delete":
      return handleWebhookDelete(env, message, fromId);
    case "test":
      return handleWebhookTest(env, message);
    default:
      await safeSend(
        env,
        message.chat.id,
        "⚠️ استفاده نادرست.\n\n" +
          "<b>زیردستورها:</b>\n" +
          "<code>/webhook</code> یا <code>/webhook info</code> — وضعیت وب‌هوک\n" +
          "<code>/webhook set &lt;https-url&gt;</code> — تنظیم وب‌هوک\n" +
          "<code>/webhook delete</code> — حذف وب‌هوک\n" +
          "<code>/webhook test</code> — تست تحویل وب‌هوک",
      );
  }
}

/** /webhook info — show current webhook configuration + health. */
async function handleWebhookInfo(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  let hook;
  try {
    hook = await getWebhookInfo(env.BOT_TOKEN);
  } catch (e) {
    log("error", SCOPE, "webhook info: getWebhookInfo failed", {
      error: String(e),
    });
    await safeSend(
      env,
      message.chat.id,
      "❌ خطا در دریافت اطلاعات وب‌هوک.\n<code>" +
        escapeHtml(String(e)) +
        "</code>",
    );
    return;
  }

  const hasError = !!hook.last_error_message;
  const healthIcon = hasError ? "🔴" : "🟢";
  const healthLabel = hasError ? "ناسالم" : "سالم";

  const lines: string[] = [];
  lines.push(`${healthIcon} <b>وضعیت وب‌هوک: ${healthLabel}</b>\n`);
  lines.push(`URL: <code>${escapeHtml(hook.url || "(none)")}</code>`);
  lines.push(`pending updates: <code>${hook.pending_update_count ?? 0}</code>`);
  lines.push(`max connections: <code>${hook.max_connections ?? "?"}</code>`);
  const allowed = hook.allowed_updates?.length
    ? hook.allowed_updates.join(", ")
    : "(default: all)";
  lines.push(`allowed updates: <code>${escapeHtml(allowed)}</code>`);

  if (hook.last_error_message) {
    const when = hook.last_error_date
      ? new Date(hook.last_error_date * 1000).toISOString()
      : "?";
    lines.push(
      `⚠️ آخرین خطا: <code>${escapeHtml(hook.last_error_message)}</code> @ ${when}`,
    );
  } else {
    lines.push("✅ خطایی ثبت نشده است.");
  }

  if (hook.ip_address) {
    lines.push(`IP: <code>${escapeHtml(hook.ip_address)}</code>`);
  }
  if (hook.has_custom_certificate) {
    lines.push("🔐 گواهی سفارشی: بله");
  }

  await safeSend(env, message.chat.id, lines.join("\n"));
}

/** /webhook set <url> — install a new webhook (https:// only). */
async function handleWebhookSet(
  env: Env,
  message: TelegramMessage,
  url: string,
  actorId: number,
): Promise<void> {
  if (!url) {
    await safeSend(
      env,
      message.chat.id,
      "⚠️ استفاده: <code>/webhook set &lt;https-url&gt;</code>\n" +
        "مثال: <code>/webhook set https://example.com/webhook</code>",
    );
    return;
  }
  if (!url.startsWith("https://")) {
    await safeSend(
      env,
      message.chat.id,
      "⛔ URL باید با <code>https://</code> شروع شود.\n" +
        "برای جلوگیری از نشت ترافیک، http:// مجاز نیست.",
    );
    return;
  }

  try {
    await setWebhook(env.BOT_TOKEN, {
      url,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: [...WEBHOOK_ALLOWED_UPDATES],
    });
  } catch (e) {
    log("error", SCOPE, "webhook set: setWebhook failed", {
      error: String(e),
    });
    await safeSend(
      env,
      message.chat.id,
      "❌ تنظیم وب‌هوک ناموفق بود.\n<code>" +
        escapeHtml(String(e)) +
        "</code>",
    );
    return;
  }

  // Audit log the change.
  try {
    await audit(env, actorId, "webhook_set", url, "");
  } catch (e) {
    log("warn", SCOPE, "webhook set: audit log failed", { error: String(e) });
  }

  await safeSend(
    env,
    message.chat.id,
    "✅ وب‌هوک تنظیم شد.\n" +
      `URL: <code>${escapeHtml(url)}</code>\n` +
      `allowed_updates: <code>${escapeHtml(WEBHOOK_ALLOWED_UPDATES.join(", "))}</code>\n` +
      "📜 در audit_log ثبت شد.",
  );
}

/** /webhook delete — remove the current webhook. */
async function handleWebhookDelete(
  env: Env,
  message: TelegramMessage,
  actorId: number,
): Promise<void> {
  try {
    await deleteWebhook(env.BOT_TOKEN);
  } catch (e) {
    log("error", SCOPE, "webhook delete: deleteWebhook failed", {
      error: String(e),
    });
    await safeSend(
      env,
      message.chat.id,
      "❌ حذف وب‌هوک ناموفق بود.\n<code>" +
        escapeHtml(String(e)) +
        "</code>",
    );
    return;
  }

  // Audit log the change.
  try {
    await audit(env, actorId, "webhook_delete", "", "");
  } catch (e) {
    log("warn", SCOPE, "webhook delete: audit log failed", { error: String(e) });
  }

  await safeSend(
    env,
    message.chat.id,
    "🗑 وب‌هوک حذف شد.\n" +
      "نکته: ربات اکنون به long-polling (getUpdates) برمی‌گردد که در V2 استفاده نمی‌شود.\n" +
      "📜 در audit_log ثبت شد.",
  );
}

/** /webhook test — reply to confirm the webhook delivered this update. */
async function handleWebhookTest(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const now = new Date().toISOString();
  await safeSend(
    env,
    message.chat.id,
    "✅ تست وب‌هوک موفق بود.\n\n" +
      "اگر این پیام را می‌بینید، یعنی:\n" +
      "• Telegram آپدیت را به URL وب‌هوک ارسال کرده\n" +
      "• Worker آپدیت را دریافت و در صف گذاشته\n" +
      "• مصرف‌کننده صف این دستور را پردازش کرده\n\n" +
      `⏱ زمان سرور: <code>${now}</code>\n` +
      `💬 chat_id: <code>${message.chat.id}</code>\n` +
      `👤 from_id: <code>${message.from?.id ?? "?"}</code>`,
  );
}

// ============================================================
// /broadcast — owner ONLY. Send a message to every admin's private chat.
// ============================================================

/**
 * /broadcast &lt;text&gt; — owner ONLY. Send `text` to every admin's private
 * chat. Uses Promise.allSettled so a single blocked user can't abort the whole
 * broadcast. Reports per-admin success/failure counts.
 *
 * The text is HTML-escaped before sending (sendMessage uses parse_mode=HTML).
 * The broadcast is audit-logged.
 */
export async function handleBroadcast(
  env: Env,
  message: TelegramMessage,
  args: string,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let ownerOk = false;
  try {
    ownerOk = await isOwner(env, fromId);
  } catch (e) {
    log("error", SCOPE, "broadcast: isOwner check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ خطای داخلی.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ این دستور فقط برای مالک قابل استفاده است.");
    return;
  }

  const text = args.trim();
  if (!text) {
    await safeSend(
      env,
      message.chat.id,
      "⚠️ متن پیام را بعد از /broadcast بنویسید.\n" +
        "مثال: <code>/broadcast سلام به همه</code>",
    );
    return;
  }

  // Fetch all admin user_ids.
  let adminIds: number[] = [];
  try {
    const rows = await execAll<{ user_id: number }>(
      env.DB,
      "SELECT user_id FROM admins ORDER BY added_at ASC",
    );
    adminIds = rows.map((r) => r.user_id);
  } catch (e) {
    log("error", SCOPE, "broadcast: listAdmins failed", { error: String(e) });
    await safeSend(
      env,
      message.chat.id,
      "❌ خطا در دریافت لیست ادمین‌ها.\n<code>" +
        escapeHtml(String(e)) +
        "</code>",
    );
    return;
  }

  if (adminIds.length === 0) {
    await safeSend(env, message.chat.id, "⚠️ هیچ ادمینی ثبت نشده است.");
    return;
  }

  // HTML-escape the message text (sendMessage defaults to parse_mode=HTML).
  const safeText = escapeHtml(text);
  const header =
    "📣 <b>پیام از مالک</b>\n\n";
  const body = header + safeText;

  // Fan-out: Promise.allSettled so one failure doesn't abort the rest.
  const results = await Promise.allSettled(
    adminIds.map((uid) =>
      sendMessage(env.BOT_TOKEN, { chat_id: uid, text: body }),
    ),
  );

  let okCount = 0;
  const failed: number[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      okCount++;
    } else {
      failed.push(adminIds[i]);
      log("warn", SCOPE, "broadcast: sendMessage failed for admin", {
        adminId: adminIds[i],
        error: String(r.reason),
      });
    }
  });

  // Audit log the broadcast.
  try {
    await audit(
      env,
      fromId,
      "broadcast",
      String(adminIds.length),
      text.slice(0, 100),
    );
  } catch (e) {
    log("warn", SCOPE, "broadcast: audit log failed", { error: String(e) });
  }

  // Report back to the sender.
  const lines: string[] = [];
  lines.push("📣 <b>گزارش ارسال پیام</b>\n");
  lines.push(`پیام به <b>${okCount}</b> از <b>${adminIds.length}</b> ادمین ارسال شد.`);
  if (failed.length > 0) {
    lines.push("\n⚠️ <b>ارسال ناموفق به:</b>");
    for (const uid of failed) {
      lines.push(`• <code>${uid}</code>`);
    }
    lines.push(
      "\nنکته: معمولاً به این دلیل است که کاربر ربات را <b>block</b> کرده یا هنوز <code>/start</code> نفرستاده است.",
    );
  }
  lines.push("\n📜 در audit_log ثبت شد.");

  await safeSend(env, message.chat.id, lines.join("\n"));
}

// ============================================================
// Dispatcher
// ============================================================

/**
 * Route an incoming message to the right command handler based on text prefix.
 *
 * @returns true if the message was a recognized command and was handled;
 *          false if not (caller may route to pipeline / add-admin flow).
 */
export async function dispatchCommand(
  env: Env,
  _ctx: unknown,
  message: TelegramMessage,
  _content: unknown,
): Promise<boolean> {
  const text = message.text ?? "";
  if (!text.startsWith("/")) return false;

  // Split into command + args. Handle @botname suffix.
  const firstSpace = text.indexOf(" ");
  const head = firstSpace === -1 ? text : text.slice(0, firstSpace);
  const args = firstSpace === -1 ? "" : text.slice(firstSpace + 1).trim();

  // Strip optional @botname suffix.
  const cmd = head.replace(/@\w+$/, "").toLowerCase();

  // Special: /schedule cancel — clear the KV flag.
  if (cmd === "/schedule" && args.toLowerCase() === "cancel") {
    const fromId = message.from?.id ?? 0;
    try {
      await env.AI_ADMIN_KV.delete(`sched_next:${fromId}`);
    } catch (e) {
      log("warn", SCOPE, "schedule cancel: KV delete failed", { error: String(e) });
    }
    await safeSend(env, message.chat.id, "✅ زمان‌بندی لغو شد.");
    return true;
  }

  switch (cmd) {
    case "/start":
      await handleStart(env, message);
      return true;
    case "/help":
      await handleHelp(env, message);
      return true;
    case "/version":
      await handleVersion(env, message);
      return true;
    case "/menu":
      await handleMenu(env, message);
      return true;
    case "/footer":
      await handleFooter(env, message, args);
      return true;
    case "/checkperms":
      await handleCheckperms(env, message);
      return true;
    case "/stats":
      await handleStats(env, message);
      return true;
    case "/models":
      await handleModels(env, message);
      return true;
    case "/admins":
      await handleAdmins(env, message);
      return true;
    case "/schedule":
      await handleSchedule(env, message, args);
      return true;
    case "/ping":
      await handlePing(env, message);
      return true;
    case "/health":
      await handleHealth(env, message);
      return true;
    case "/diag":
      await handleDiag(env, message);
      return true;
    case "/test":
      await handleTest(env, message);
      return true;
    case "/reset":
      await handleReset(env, message, args);
      return true;
    case "/queue":
      await handleQueue(env, message);
      return true;
    case "/audit":
      await handleAudit(env, message, args);
      return true;
    case "/webhook":
      await handleWebhook(env, message, args);
      return true;
    case "/broadcast":
      await handleBroadcast(env, message, args);
      return true;
    default:
      await safeSend(env, message.chat.id, "⚠️ دستور ناشناخته. /help را ببینید.");
      return true;
  }
}

// ============================================================
// Schedule parser
// ============================================================

/**
 * Parse a schedule argument in Asia/Tehran timezone.
 *
 * Supported formats:
 *   "in 30m"     → 30 minutes from now
 *   "in 2h"      → 2 hours from now
 *   "in 1d"      → 1 day from now
 *   "at 15:30"   → today at 15:30 Tehran; if past, tomorrow same time
 *   "at 3:30pm"  → today at 15:30
 *   "tomorrow 09:00" → tomorrow at 09:00 Tehran
 *   "tomorrow at 09:00" → same
 *
 * @returns epoch ms, or null on parse failure.
 */
export function parseScheduleArg(args: string): number | null {
  const trimmed = args.trim().toLowerCase();
  if (!trimmed) return null;

  // --- "in Nu" ---
  const inMatch = trimmed.match(
    /^in\s+(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days|w|week|weeks)$/,
  );
  if (inMatch) {
    const n = parseInt(inMatch[1], 10);
    const unit = inMatch[2];
    let ms = 0;
    if (unit.startsWith("m")) ms = n * 60_000;
    else if (unit.startsWith("h")) ms = n * 3_600_000;
    else if (unit.startsWith("d")) ms = n * 86_400_000;
    else if (unit.startsWith("w")) ms = n * 604_800_000;
    return Date.now() + ms;
  }

  // --- "at HH:MM" or "at HH:MM am/pm" ---
  const atMatch = trimmed.match(
    /^at\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/,
  );
  if (atMatch) {
    let h = parseInt(atMatch[1], 10);
    const m = parseInt(atMatch[2], 10);
    const ap = atMatch[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || m > 59) return null;
    return tehranTodayOrTomorrow(h, m);
  }

  // --- "tomorrow [at] HH:MM" ---
  const tomMatch = trimmed.match(
    /^tomorrow(?:\s+at)?\s+(\d{1,2}):(\d{2})$/,
  );
  if (tomMatch) {
    const h = parseInt(tomMatch[1], 10);
    const m = parseInt(tomMatch[2], 10);
    if (h > 23 || m > 59) return null;
    return tehranTomorrow(h, m);
  }

  return null;
}

/**
 * Compute the UTC epoch ms for "today at HH:MM" in Tehran wall-clock. If that
 * time has already passed today, return tomorrow at the same time.
 */
function tehranTodayOrTomorrow(hour: number, minute: number): number {
  const today = tehranTodayAt(hour, minute);
  if (today > Date.now()) return today;
  return today + 86_400_000;
}

/** Compute the UTC epoch ms for "tomorrow at HH:MM" in Tehran wall-clock. */
function tehranTomorrow(hour: number, minute: number): number {
  return tehranTodayAt(hour, minute) + 86_400_000;
}

/**
 * Compute the UTC epoch ms for "today at HH:MM" in Tehran, where "today" is
 * derived from the current Tehran wall-clock. Uses Intl.DateTimeFormat to
 * discover Tehran's wall clock WITHOUT hardcoding the +03:30 offset (so the
 * code still works if Iran ever re-introduces DST).
 */
function tehranTodayAt(hour: number, minute: number): number {
  const now = new Date();
  // Format current time in Tehran to grab Y/M/D/H/M.
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== "literal") {
      const v = parseInt(p.value, 10);
      if (!Number.isNaN(v)) map[p.type] = p.value === "24" ? 0 : v;
    }
  }
  const y = map.year;
  const mo = map.month - 1;
  const d = map.day;

  // Construct a UTC date with Tehran's wall-clock components for the target
  // time. This is NOT the target instant yet — it's the target wall-clock
  // interpreted as UTC. We then apply Tehran's current UTC offset to correct.
  const wallAsUtc = Date.UTC(y, mo, d, hour, minute, 0, 0);

  // Compute Tehran's offset at the current instant by formatting `now` in
  // Tehran and comparing the wall-clock reading to the UTC value.
  const tehranWallNow = Date.UTC(
    map.year,
    map.month - 1,
    map.day,
    map.hour,
    map.minute,
    0,
    0,
  );
  const offsetMs = tehranWallNow - now.getTime();

  return wallAsUtc - offsetMs;
}

// ============================================================
// Helpers
// ============================================================

async function safeSend(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: string,
): Promise<void> {
  try {
    await sendMessage(env.BOT_TOKEN, {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
    });
  } catch (e) {
    log("warn", SCOPE, "safeSend failed", { error: String(e) });
  }
}

/**
 * Read a single model's health record from KV. Returns null on cache miss or
 * parse error. The key shape matches `ai/fallback.ts`: `ai:health:<provider>:<model>`.
 */
async function readHealthFor(
  env: Env,
  provider: "gemini" | "openrouter",
  model: string,
): Promise<ModelHealth | null> {
  try {
    const raw = await env.AI_ADMIN_KV.get(`ai:health:${provider}:${model}`);
    if (!raw) return null;
    return JSON.parse(raw) as ModelHealth;
  } catch {
    return null;
  }
}

/**
 * Render one model entry as a single Telegram-HTML line for /models.
 *
 * Format:
 *   ✅ <b>Gemini 2.5 Flash</b> (Stable default)
 *      <code>gemini-2.5-flash</code> — شکست‌ها: 0 🟢 فعال
 */
function formatModelLine(
  m: ModelEntry,
  h: ModelHealth | null,
  isActive: boolean,
): string {
  const icon = !h ? "❓" : h.healthy ? "✅" : "⚠️";
  const notes = m.notes ? ` <i>(${escapeHtml(m.notes)})</i>` : "";
  const label = escapeHtml(m.label);
  const id = escapeHtml(m.id);
  const fails = h ? ` — شکست‌ها: ${h.consecutiveFailures}` : " — بدون داده";
  const activeBadge = isActive ? " 🟢 <b>فعال</b>" : "";
  return `${icon} <b>${label}</b>${notes}\n   <code>${id}</code>${fails}${activeBadge}`;
}

/**
 * Mask a secret: show only the first 3 chars + "…". Strings of length ≤ 3 are
 * fully masked as "***" to avoid revealing short secrets entirely.
 */
function maskSecret(s: string | undefined): string {
  if (!s) return "(unset)";
  if (s.length <= 3) return "***";
  return s.slice(0, 3) + "…";
}

/** Run `SELECT COUNT(*) ... ` and return the integer count (0 on empty). */
async function execCount(
  env: Env,
  sql: string,
  ...params: unknown[]
): Promise<number> {
  const rows = await execAll<{ c: number }>(env.DB, sql, ...params);
  return rows.length > 0 ? (rows[0].c ?? 0) : 0;
}
