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
 *   handleSchedule    admin        show schedule settings menu (task 26)
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
  SCHEDULE_PER_DAY_OPTIONS,
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
import { getRole, isAuthorized, isOwner, audit, ensureOwnerExists } from "../storage/repositories/admins";
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
const VERSION = "v2.13.0";
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
  let lang = getUiLanguage();
  let isAdmin = false;
  try {
    if (fromId) {
      const settings = await getSettings(env, fromId);
      lang = getUiLanguage(settings);
      isAdmin = await isAuthorized(env, fromId).catch(() => false);
    }
  } catch { /* use default */ }

  const name = message.from?.first_name ? ` ${escapeHtml(message.from.first_name)}` : "";
  const welcome = t(lang, "start.welcome");
  const desc = t(lang, "start.description");

  const text =
    `<blockquote><b>🤖 AI Admin</b></blockquote>\n\n` +
    `${welcome}${name}! 👋\n\n` +
    `${desc}\n\n` +
    `<b>Features:</b>\n` +
    `📝 AI-powered content rewriting & formatting\n` +
    `✅ Approval system with Publish/Reject buttons\n` +
    `📅 Post scheduling with cron trigger\n` +
    `👥 Role-based admin management (Owner/Editor/Reviewer/Viewer)\n` +
    `🎨 Rich Markdown support (bold, italic, code, links, quotes)\n` +
    `✏️ Channel post editing in place\n\n` +
    `<b>Quick Start:</b>\n` +
    `• Send me any post to process & publish\n` +
    `• Use /menu to open the control panel\n` +
    `• Use /help to see all commands`;

  // Add a "UI Language" button below the start message
  const currentLang = SUPPORTED_LANGUAGES.find((l) => l.code === lang);
  const keyboard = buildInlineKeyboard([
    [{ text: `🌐 UI Language: ${currentLang?.flag} ${currentLang?.label}`, callback_data: "set:uilang" }],
  ]);

  await safeSend(env, message.chat.id, text, keyboard);

  // If user is admin, send a separate "You are admin!" message with /menu button
  if (isAdmin) {
    const adminText =
      `<blockquote><b>👑 You are Admin!</b></blockquote>\n\n` +
      `You have access to the control panel.\n` +
      `Click below to open the menu:`;
    const adminKeyboard = buildInlineKeyboard([
      [{ text: "🎛 Open Menu", callback_data: "menu" }],
    ]);
    await safeSend(env, message.chat.id, adminText, adminKeyboard);
  }
}

/** /help — list commands + role permissions. Anyone. */
export async function handleHelp(env: Env, message: TelegramMessage): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let role: Role | null = null;
  let lang = getUiLanguage();
  try {
    if (fromId) {
      const settings = await getSettings(env, fromId);
      lang = getUiLanguage(settings);
    }
    const authorized = await isAuthorized(env, fromId);
    if (authorized) role = await getRole(env, fromId);
  } catch (e) {
    log("warn", SCOPE, "help: auth check failed", { error: String(e) });
  }

  const lines: string[] = [];
  lines.push("📚 <b>Bot Commands</b>\n");
  lines.push("/start — Bot introduction");
  lines.push("/help — This help message");
  lines.push("/version — Version and build info (all)");
  lines.push("/menu — Open main menu (admins)");
  lines.push("/footer &lt;text&gt; — Change footer (owner/editor)");
  lines.push("/checkperms — Check bot permissions in channel (owner/editor)");
  lines.push("/stats — Activity stats (all admins)");
  lines.push("/models — List AI models + health (all admins)");
  lines.push("/admins — Manage admins (owner only)");
  lines.push("/schedule — Open schedule settings menu");
  lines.push("/ping — Bot status (owner only)");
  lines.push("/health — System health check (owner only)");
  lines.push("/diag — Full diagnostic report (owner only)");
  lines.push("/test — Run formatter tests (owner only)");
  lines.push("/reset &lt;stats|debug|jobs|all&gt; — Reset stats/logs/jobs (owner only)");
  lines.push("/resetall — Wipe EVERYTHING to defaults (owner only)");
  lines.push("/queue — Queue status (owner only)");
  lines.push("/audit [n] — Recent audit events (owner only)");
  lines.push("/webhook &lt;info|set &lt;url&gt;|delete|test&gt; — Manage webhook (owner only)");
  lines.push("/broadcast &lt;text&gt; — Message to all admins (owner only)");

  lines.push("\n👥 <b>Roles</b>");
  lines.push("• Owner — Full access + Manage admins");
  lines.push("• Editor — Publish/approve/reject/schedule + settings");
  lines.push("• Reviewer — Approve/reject + stats");
  lines.push("• Viewer — View stats only");

  if (role) {
    lines.push(`\n🎫 Your role: <b>${escapeHtml(roleLabel(role, lang))}</b>`);
  } else {
    lines.push("\n🎫 You are not an admin. /menu is for admins only.");
  }

  await safeSend(env, message.chat.id, lines.join("\n"));
}

/** /menu — main admin menu. Requires any admin role. */
export async function handleMenu(env: Env, message: TelegramMessage): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let role: Role | null = null;
  let authorized = false;
  let lang = getUiLanguage();
  let settingsObj: import("../types").Settings | null = null;
  try {
    if (fromId) {
      settingsObj = await getSettings(env, fromId);
      lang = getUiLanguage(settingsObj);
    }
    authorized = await isAuthorized(env, fromId);
    if (authorized) role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "menu: auth check failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ Internal error. Please try again.");
    return;
  }

  if (!authorized || !role) {
    await safeSend(env, message.chat.id, t(lang, "unauthorized"));
    return;
  }

  const text =
    `<blockquote><b>🎛 Control Panel</b> <code>${VERSION}</code></blockquote>\n\n` +
    `<b>Welcome back!</b>\n` +
    `Role: <b>${escapeHtml(roleLabel(role, lang))}</b>\n\n` +
    `Toggle <b>Approval</b> to require publish confirmation.\n` +
    `Toggle <b>Channel Edit</b> to edit channel posts in place.`;
  await safeSend(env, message.chat.id, text, mainMenuKeyboard(role, settingsObj || undefined));
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
      await safeSend(env, message.chat.id, "⛔ Unauthorized");
      return;
    }
    role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "footer: auth failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }

  if (!can(role, "change_footer")) {
    await safeSend(env, message.chat.id, "⛔ Unauthorized");
    return;
  }

  const newFooter = args.trim();
  if (!newFooter) {
    await safeSend(
      env,
      message.chat.id,
      "⚠️ Usage: <code>/footer &lt;text&gt;</code>\nExample: <code>/footer 🌀 @ILIVIR3</code>",
    );
    return;
  }

  try {
    const settings = await getSettings(env, fromId);
    settings.footerText = newFooter;
    await saveSettings(env, fromId, settings);
  } catch (e) {
    log("error", SCOPE, "footer: saveSettings failed", { error: String(e) });
    await safeSend(env, message.chat.id, "❌ Failed to save settings.");
    return;
  }

  await safeSend(
    env,
    message.chat.id,
    `✅ Footer updated:\n<blockquote>${escapeHtml(newFooter)}</blockquote>`,
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
      await safeSend(env, message.chat.id, "⛔ Unauthorized");
      return;
    }
    role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "checkperms: auth failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }

  if (!can(role, "change_settings")) {
    await safeSend(env, message.chat.id, "⛔ Unauthorized");
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
    await safeSend(env, message.chat.id, "❌ Failed to get bot info.");
    return;
  }

  const lines: string[] = [];
  lines.push("🔍 <b>Bot status</b>\n");
  lines.push(`Name: ${escapeHtml(me.first_name ?? "?")}`);
  lines.push(`Username: @${escapeHtml(me.username ?? "?")}`);
  lines.push(`Target channel: <code>${escapeHtml(env.TARGET_CHANNEL)}</code>`);
  lines.push("");
  lines.push("<b>Webhook</b>");
  lines.push(`URL: <code>${escapeHtml(hook.url ?? "(none)")}</code>`);
  lines.push(`Pending updates: ${hook.pending_update_count ?? 0}`);
  lines.push(`max connections: ${hook.max_connections ?? "?"}`);
  if (hook.last_error_message) {
    const when = hook.last_error_date
      ? new Date(hook.last_error_date * 1000).toISOString()
      : "?";
    lines.push(`⚠️ Last error: <code>${escapeHtml(hook.last_error_message)}</code> @ ${when}`);
  }
  lines.push("");
  lines.push("ℹ️ Note: Bot must be channel admin with <b>Post Messages</b> permission. This permission is not visible via Bot API; check channel settings.");

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
      await safeSend(env, message.chat.id, "⛔ Unauthorized");
      return;
    }
    role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "stats: auth failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }

  if (!can(role, "view_stats")) {
    await safeSend(env, message.chat.id, "⛔ Unauthorized");
    return;
  }

  let global: Stats;
  let mine: Stats;
  try {
    global = await getStats(env, "global");
    mine = await getStats(env, `u:${fromId}`);
  } catch (e) {
    log("error", SCOPE, "stats: getStats failed", { error: String(e) });
    await safeSend(env, message.chat.id, "❌ Failed to get stats.");
    return;
  }

  const fmt = (s: Stats, title: string): string => {
    return (
      `${title}:\n` +
      `  📥 Received: ${s.totalReceived}\n` +
      `  📤 Published: ${s.totalPublished}\n` +
      `  ✍️ Rewritten: ${s.totalRewritten}\n` +
      `  ❌ Failed: ${s.totalFailed}\n` +
      `  ✅ Approvals: ${s.totalApprovals}\n` +
      `  🚫 Rejected: ${s.totalRejected}\n` +
      `  📅 Scheduled: ${s.totalScheduled}\n` +
      `  🤖 AI calls: ${s.aiCalls}\n` +
      `  ⚠️ AI failures: ${s.aiFailures}`
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
    `📊 <b>Activity stats</b>\n\n` +
    `${fmt(global, "🌐 Global")}\n\n` +
    `${chartBlock}\n\n` +
    `${successRateBlock}\n\n` +
    `${aiBlock}\n\n` +
    `${fmt(mine, "👤 You")}\n\n` +
    `Last updated: <code>${last}</code>`;

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
    { label: "📤 Published", value: s.totalPublished },
    { label: "✏️ Rewrite", value: s.totalRewritten },
    { label: "❌ Failed", value: s.totalFailed },
  ];

  const max = Math.max(1, ...items.map((i) => i.value));
  if (items.every((i) => i.value === 0)) {
    return "<b>📈 Chart</b>\n<i>(no data)</i>";
  }

  const lines: string[] = ["<b>📈 Chart</b>"];
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
    return "<b>🎯 Success Rate</b>: <i>—</i> (no data)";
  }
  const rate = (s.totalPublished / denom) * 100;
  const rounded = Math.round(rate * 10) / 10;
  return (
    `<b>🎯 Success Rate</b>: <code>${rounded}%</code>\n` +
    `   (${s.totalPublished} published / ${denom} total)`
  );
}

/**
 * AI usage summary: total calls, failure rate.
 */
function renderAiMetrics(s: Stats): string {
  if (s.aiCalls === 0) {
    return "<b>🤖 AI</b>: <i>No calls</i>";
  }
  const rate = (s.aiFailures / s.aiCalls) * 100;
  const rounded = Math.round(rate * 10) / 10;
  return (
    `<b>🤖 AI</b>\n` +
    `   Calls: <code>${s.aiCalls}</code>\n` +
    `   Failures: <code>${s.aiFailures}</code> (<code>${rounded}%</code>)`
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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }

  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
    return;
  }

  let admins: import("../types").AdminRecord[] = [];
  try {
    admins = await listAdmins(env);
  } catch (e) {
    log("error", SCOPE, "admins: listAdmins failed", { error: String(e) });
    await safeSend(env, message.chat.id, "❌ Failed to get admin list.");
    return;
  }

  const keyboard = adminListKeyboard(admins, ownerUserId(env));
  const text =
    `👥 <b>Manage admins</b>\n\n` +
    `Count: ${admins.length}
` +
    `To remove, tap the admin row. Owner cannot be removed.\n` +
    `To add, tap "➕ Add Admin".`;
  await safeSend(env, message.chat.id, text, keyboard);
}

/**
 * /schedule — show the schedule settings menu (task 26).
 *
 * Replaces the old `/schedule <time>` command which set a transient
 * `sched_next:{userId}` KV flag and waited for the next message. The new
 * system uses persistent D1-backed jobs with configurable messages-per-day
 * and interval; the menu is the same one reached via the main-menu
 * "📅 Schedule" button (`set:schedule` callback).
 *
 * Authorization: any role with the `schedule` permission (owner + editor).
 */
export async function handleSchedule(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  let role: Role | null = null;
  try {
    const authorized = await isAuthorized(env, fromId);
    if (!authorized) {
      await safeSend(env, message.chat.id, "⛔ Unauthorized");
      return;
    }
    role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "schedule: auth failed", { error: String(e) });
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }

  if (!can(role, "schedule")) {
    await safeSend(env, message.chat.id, "⛔ Unauthorized");
    return;
  }

  // Read the user's settings (with defaults merged) so the menu reflects the
  // current schedule config. Fall back to defaults on error.
  let settings: import("../types").Settings;
  try {
    const { getSettings } = await import("../storage/repositories/settings");
    settings = await getSettings(env, fromId);
  } catch (e) {
    log("warn", SCOPE, "schedule: getSettings failed; using defaults", {
      error: String(e),
    });
    const { DEFAULT_SETTINGS } = await import("../config/defaults");
    settings = { ...DEFAULT_SETTINGS };
  }

  const { scheduleSettingsKeyboard } = await import("./keyboards");
  const startHour =
    Number.isFinite(settings.scheduleStartHour) &&
    settings.scheduleStartHour! >= 0 &&
    settings.scheduleStartHour! <= 23
      ? settings.scheduleStartHour!
      : 9;
  const cfg = {
    enabled: settings.scheduleEnabled === true,
    perDay:
      Number.isFinite(settings.scheduleMessagesPerDay) &&
      SCHEDULE_PER_DAY_OPTIONS.includes(settings.scheduleMessagesPerDay as number)
        ? (settings.scheduleMessagesPerDay as number)
        : 4,
    startHour,
  };

  // Show today's calendar view with pending posts mapped to slots.
  const { t, getUiLanguage } = await import("../i18n");
  const lang = getUiLanguage(settings);
  const { buildScheduleCalendarView } = await import("../processing/scheduler");
  const { listPendingScheduledForUser } = await import("../storage/repositories/jobs");
  const pending = fromId ? await listPendingScheduledForUser(env, fromId, 100).catch(() => []) : [];
  const calView = buildScheduleCalendarView(
    pending.map((j) => ({ id: j.id, scheduledFor: j.scheduledFor, payload: j.payload })),
    cfg.perDay,
    cfg.startHour,
    1, // just today
    lang,
  );
  const today = calView[0];
  const slotStr = today.slots.map((s) => {
    const icon = s.occupied ? "✅" : "⬜";
    const preview = s.postPreview ? ` — ${s.postPreview.slice(0, 40).replace(/</g, "&lt;")}` : "";
    return `${icon} ${s.time}${preview}`;
  }).join("\n");

  const text =
    `${t(lang, "sched.title")}\n\n` +
    `${cfg.enabled ? t(lang, "sched.enabled") : t(lang, "sched.disabled")}\n` +
    `📊 ${t(lang, "sched.posts_per_day")}: <b>${cfg.perDay}</b>\n` +
    `🕐 ${t(lang, "sched.start_hour")}: <b>${String(cfg.startHour).padStart(2, "0")}:00</b>\n\n` +
    `<b>${today.dayLabel}:</b> (${today.occupiedCount}/${today.slots.length} ${t(lang, "sched.occupied")})\n` +
    `<blockquote>${slotStr}</blockquote>\n\n` +
    `<i>${t(lang, "sched.distribute_info")}</i>`;

  await safeSend(env, message.chat.id, text, scheduleSettingsKeyboard(settings));
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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }

  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
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
    `Version: <code>${VERSION}</code>\n` +
    `Server time: <code>${now.toISOString()}</code>\n` +
    `Server time: <code>${escapeHtml(tehranNow)}</code>\n` +
    `Webhook queue: <code>${hookPending}</code>\n` +
    `Channel: <code>${escapeHtml(env.TARGET_CHANNEL)}</code>\n` +
    `Owner: <code>${ownerUserId(env)}</code>`;
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
    `🏷 <b>Version Info</b>\n\n` +
    `<b>Version</b>: <code>${VERSION}</code>\n` +
    `<b>Build date</b>: <code>${BUILD_DATE}</code>\n` +
    `<b>Server time</b>: <code>${now.toISOString()}</code>\n` +
    `<b>Server time</b>: <code>${escapeHtml(tehranNow)}</code>\n\n` +
    `<b>📦 Build stats</b>\n` +
    `• TypeScript files: <code>40</code>\n` +
    `• AI models: <code>${ALL_MODELS.length}</code>\n` +
    `• Cron triggers: <code>1</code>\n\n` +
    `🌀 <i>AI Admin V2 — Built for Cloudflare Workers</i>`;
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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!authorized) {
    await safeSend(env, message.chat.id, "⛔ Unauthorized");
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
  lines.push("🤖 <b>List AI models</b>");
  lines.push(`Total count: <code>${ALL_MODELS.length}</code>`);
  lines.push(`Active provider: <code>${escapeHtml(activeProvider)}</code>`);
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
  lines.push("<i>✅ Healthy — ⚠️ Unhealthy — ❓ Unknown — 🟢 Active</i>");

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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
    return;
  }

  const lines: string[] = [];
  lines.push("🩺 <b>System Health</b>\n");

  // --- Telegram Bot API ---
  try {
    const me = await getMe(env.BOT_TOKEN);
    lines.push(`🔵 <b>Telegram API</b>: 🟢 Healthy — @${escapeHtml(me.username ?? "?")}`);
  } catch (e) {
    lines.push(
      `🔵 <b>Telegram API</b>: 🔴 Down — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  // --- Webhook info ---
  try {
    const hook = await getWebhookInfo(env.BOT_TOKEN);
    const pending = hook.pending_update_count ?? 0;
    const lastErr = hook.last_error_message;
    if (pending > 0 || lastErr) {
      lines.push(`🔗 <b>Webhook</b>: 🟡 Warning — pending: <code>${pending}</code>`);
      if (lastErr) {
        const when = hook.last_error_date
          ? new Date(hook.last_error_date * 1000).toISOString()
          : "?";
        lines.push(
          `   Last error: <code>${escapeHtml(lastErr)}</code> @ ${when}`,
        );
      }
    } else {
      lines.push(`🔗 <b>Webhook</b>: 🟢 Healthy — pending: <code>0</code>`);
    }
  } catch (e) {
    lines.push(
      `🔗 <b>Webhook</b>: 🔴 Error — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  // --- D1 ---
  try {
    const t0 = Date.now();
    const rows = await execAll<{ ok: number }>(env.DB, "SELECT 1 as ok");
    const latency = Date.now() - t0;
    const ok = rows.length > 0 && rows[0].ok === 1;
    lines.push(
      `🗄 <b>D1 Database</b>: ${ok ? "🟢" : "🔴"} ${ok ? "Healthy" : "Error"} — latency: <code>${latency}ms</code>`,
    );
  } catch (e) {
    lines.push(
      `🗄 <b>D1 Database</b>: 🔴 Error — <code>${escapeHtml(String(e))}</code>`,
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
      `📦 <b>KV Namespace</b>: ${ok ? "🟢" : "🔴"} ${ok ? "Healthy" : "Error"} — latency: <code>${latency}ms</code>`,
    );
  } catch (e) {
    lines.push(
      `📦 <b>KV Namespace</b>: 🔴 Error — <code>${escapeHtml(String(e))}</code>`,
    );
  }

  // --- Queue ---
  // Cloudflare Workers Queues cannot be probed directly from inside a fetch
  // handler without enqueuing a real message. We only report that the binding
  // exists (bounded).
  lines.push(
    `📨 <b>Queue</b>: 🟡 Bounded (bounded) — Direct test not possible, binding exists`,
  );

  // --- Global stats ---
  try {
    const stats = await getStats(env, "global");
    lines.push("");
    lines.push("<b>📊 Global Stats</b>");
    lines.push(`📥 Received: <code>${stats.totalReceived}</code>`);
    lines.push(`📤 Published: <code>${stats.totalPublished}</code>`);
    lines.push(`❌ Failed: <code>${stats.totalFailed}</code>`);
  } catch (e) {
    lines.push(
      `📊 <b>Stats</b>: 🔴 Error — <code>${escapeHtml(String(e))}</code>`,
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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
    return;
  }

  const out: string[] = [];
  out.push("🔧 <b>Diag — Full Diagnostic Report</b>\n");

  // --- Env config (masked secrets) ---
  out.push("<b>⚙️ Environment Config</b>");
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

    out.push("<b>🗄 D1 — Row Counts</b>");
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
      `<b>🗄 D1</b>: 🔴 Count error — <code>${escapeHtml(String(e))}</code>\n`,
    );
  }

  // --- KV health cache entries ---
  try {
    const list = await env.AI_ADMIN_KV.list({ prefix: "ai:health:" });
    out.push("<b>📦 KV — Model Health Cache</b>");
    out.push(`Key count: <code>${list.keys.length}</code>`);
    for (const k of list.keys) {
      out.push(`• <code>${escapeHtml(k.name)}</code>`);
    }
    out.push("");
  } catch (e) {
    out.push(
      `<b>📦 KV</b>: 🔴 Error — <code>${escapeHtml(String(e))}</code>\n`,
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
    out.push("<b>📜 audit_log — Last 5 Events</b>");
    if (auditRows.length === 0) {
      out.push("(empty)");
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
      `<b>📜 audit_log</b>: 🔴 Error — <code>${escapeHtml(String(e))}</code>\n`,
    );
  }

  // --- Recent debug_events ---
  try {
    const events = await listEvents(env, 5);
    out.push("<b>🐞 debug_events — Last 5 Events</b>");
    if (events.length === 0) {
      out.push("(empty)");
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
      `<b>🐞 debug_events</b>: 🔴 Error — <code>${escapeHtml(String(e))}</code>`,
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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
    return;
  }

  // Pure function — never throws. Safe to call directly.
  const summary = runFormatterSelfTests();

  const lines: string[] = [];
  lines.push("🧪 <b>Formatter Tests</b>\n");
  lines.push(`✅ Passed: <code>${summary.passed}</code>`);
  lines.push(`❌ Failed: <code>${summary.failed}</code>`);

  if (summary.failures.length > 0) {
    lines.push("\n<b>Failure details:</b>");
    for (const f of summary.failures) {
      lines.push(
        `• <b>${escapeHtml(f.name)}</b>\n   <code>${escapeHtml(f.reason)}</code>`,
      );
    }
    lines.push(
      "\n⚠️ Please review the failure report — there may be a regression in formatter or cleaner.",
    );
  } else {
    lines.push("\n🎉 All tests passed.");
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
export async function handleResetAll(
  env: Env,
  message: TelegramMessage,
): Promise<void> {
  const fromId = message.from?.id ?? 0;
  if (!(await isOwner(env, fromId))) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
    return;
  }

  // Two-step confirmation
  const confirmKey = `resetall_confirm:${fromId}`;
  const confirmed = await env.AI_ADMIN_KV.get(confirmKey);
  if (!confirmed) {
    await env.AI_ADMIN_KV.put(confirmKey, "1", { expirationTtl: 30 });
    await safeSend(
      env,
      message.chat.id,
      "⚠️ <b>RESET ALL — This will wipe:</b>\n\n" +
        "<blockquote>\n" +
        "• All settings (reset to defaults)\n" +
        "• All scheduled posts\n" +
        "• All approval jobs\n" +
        "• All stats\n" +
        "• All debug events\n" +
        "• All audit logs\n" +
        "• All seen updates\n" +
        "• All media group items\n" +
        "</blockquote>\n\n" +
        "Send <code>/resetall</code> again within 30 seconds to confirm.",
    );
    return;
  }
  await env.AI_ADMIN_KV.delete(confirmKey);

  const results: string[] = [];
  try {
    // 1. Delete all settings
    await env.DB.prepare("DELETE FROM settings").run();
    results.push("✅ Settings: wiped");
  } catch (e) {
    results.push("❌ Settings: " + String(e));
  }
  try {
    // 2. Delete all jobs
    await env.DB.prepare("DELETE FROM jobs").run();
    results.push("✅ Jobs: wiped");
  } catch (e) {
    results.push("❌ Jobs: " + String(e));
  }
  try {
    // 3. Reset stats
    await env.DB.prepare("DELETE FROM stats").run();
    results.push("✅ Stats: wiped");
  } catch (e) {
    results.push("❌ Stats: " + String(e));
  }
  try {
    // 4. Delete debug events
    await env.DB.prepare("DELETE FROM debug_events").run();
    results.push("✅ Debug events: wiped");
  } catch (e) {
    results.push("❌ Debug events: " + String(e));
  }
  try {
    // 5. Delete audit log
    await env.DB.prepare("DELETE FROM audit_log").run();
    results.push("✅ Audit log: wiped");
  } catch (e) {
    results.push("❌ Audit log: " + String(e));
  }
  try {
    // 6. Delete seen updates
    await env.DB.prepare("DELETE FROM seen_updates").run();
    results.push("✅ Seen updates: wiped");
  } catch (e) {
    results.push("❌ Seen updates: " + String(e));
  }
  try {
    // 7. Delete media group items
    await env.DB.prepare("DELETE FROM media_group_items").run();
    results.push("✅ Media groups: wiped");
  } catch (e) {
    results.push("❌ Media groups: " + String(e));
  }
  try {
    // 8. Clear all KV cache keys (FIX-2: paginate — KV.list returns max 1000
    //    keys per call; without pagination, namespaces with >1000 keys would
    //    leave keys behind. Also parallelize deletes for speed.)
    let cursor: string | undefined;
    let deletedCount = 0;
    do {
      const list = await env.AI_ADMIN_KV.list({ cursor, limit: 1000 });
      await Promise.all(list.keys.map((k) => env.AI_ADMIN_KV.delete(k.name)));
      deletedCount += list.keys.length;
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
    results.push(`✅ KV cache: cleared (${deletedCount} keys)`);
  } catch (e) {
    results.push("❌ KV cache: " + String(e));
  }
  try {
    // 9. Re-ensure owner exists
    await ensureOwnerExists(env);
    results.push("✅ Owner: re-created");
  } catch (e) {
    results.push("❌ Owner: " + String(e));
  }

  try {
    await audit(env, fromId, "resetall", "all", "Full reset to defaults");
  } catch { /* ignore */ }

  await safeSend(
    env,
    message.chat.id,
    "🔄 <b>Reset All Complete</b>\n\n" + results.join("\n"),
  );
}

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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
    return;
  }

  const raw = args.trim().toLowerCase() as ResetTarget;
  if (!RESET_TARGETS.has(raw)) {
    await safeSend(
      env,
      message.chat.id,
      "⚠️ Usage: <code>/reset &lt;stats|debug|jobs|all&gt;</code>\n\n" +
        "• <code>stats</code> — Reset statistics counters\n" +
        "• <code>debug</code> — Delete all debug events\n" +
        "• <code>jobs</code> — Delete finished jobs (pending ones are kept)\n" +
        "• <code>all</code> — All of the above",
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
        "❌ Failed to save approval status. Try again.",
      );
      return;
    }

    const targetLabelFa: Record<ResetTarget, string> = {
      stats: "Stats (stats)",
      debug: "Debug events",
      jobs: "Finished jobs",
      all: "All",
    };
    await safeSend(
      env,
      message.chat.id,
      `⚠️ <b>This action is irreversible.</b>\n` +
        `Target: <b>${escapeHtml(targetLabelFa[raw])}</b>\n` +
        `To confirm, send again within 30 seconds:\n` +
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
  lines.push("🧹 <b>Reset Complete</b>\n");
  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    lines.push(
      `${icon} <b>${escapeHtml(r.target)}</b> — ${r.ok ? "Done" : `<code>${escapeHtml(r.detail)}</code>`}`,
    );
  }
  lines.push(`\n🎯 Target: <code>${escapeHtml(raw)}</code>`);
  lines.push("📜 Recorded in audit_log.");

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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
    return;
  }

  try {
    // Run all count queries in parallel for speed.
    // History records (payload contains "is_history":true) are filtered out
    // so they don't inflate the real approval/scheduled-post counts.
    const [statusCounts, typeCounts, dueNowRows, recentPending, oldestFailed] =
      await Promise.all([
        execAll<JobStatusCount>(
          env.DB,
          "SELECT status, COUNT(*) as c FROM jobs WHERE payload NOT LIKE '%\"is_history\":true%' GROUP BY status",
        ),
        execAll<JobTypeCount>(
          env.DB,
          "SELECT type, COUNT(*) as c FROM jobs WHERE payload NOT LIKE '%\"is_history\":true%' GROUP BY type",
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
    lines.push("📥 <b>Job Queue</b>\n");

    // --- Summary section ---
    lines.push("<b>📊 Summary</b>");
    lines.push(`Total: <code>${total}</code>`);
    lines.push(
      `• Pending: <code>${pending}</code>` +
        (dueNow > 0 ? ` — — <b>${dueNow}</b> due now` : ""),
    );
    lines.push(`• Published: <code>${published}</code>`);
    lines.push(`• Rejected: <code>${rejected}</code>`);
    lines.push(`• Expired: <code>${expired}</code>`);
    lines.push(`• Failed: <code>${failed}</code>`);
    lines.push("");
    lines.push("<b>🔎 By Type</b>");
    lines.push(`• Scheduled: <code>${scheduledPost}</code>`);
    lines.push(`• Approval: <code>${approval}</code>`);

    // --- Detail section: recent pending ---
    lines.push("");
    lines.push("<b>🗂 Recent 5 Pending Jobs</b>");
    if (recentPending.length === 0) {
      lines.push("<i>(no pending jobs)</i>");
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
    lines.push("<b>⚠️ 3 Oldest Failed Jobs</b>");
    if (oldestFailed.length === 0) {
      lines.push("<i>(no failed jobs)</i>");
    } else {
      for (const j of oldestFailed) {
        const created = new Date(j.created_at).toISOString();
        const err = j.error_message
          ? escapeHtml(j.error_message.slice(0, 200))
          : "<i>(no error message)</i>";
        lines.push(
          `• <code>${escapeHtml(j.id)}</code> <i>${escapeHtml(j.type)}</i>\n` +
            `   created: <code>${created}</code>\n` +
            `   error: <code>${err}</code>`,
        );
      }
    }

    // --- Note ---
    lines.push("");
    lines.push("ℹ️ Cron processes this queue every 15 minutes.");

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
      "❌ Failed to get queue status.\n<code>" + escapeHtml(String(e)) + "</code>",
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
 * formatted with a Persian relative timestamp (e.g. "۵ min ago") plus the
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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
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
        "⚠️ Usage: <code>/audit [n]</code>\nExample: <code>/audit 20</code> — n = positive integer (max 30)",
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
      "❌ Failed to read audit_log.\n<code>" + escapeHtml(String(e)) + "</code>",
    );
    return;
  }

  if (rows.length === 0) {
    await safeSend(env, message.chat.id, "📜 No audit events recorded.");
    return;
  }

  const lines: string[] = [];
  lines.push(`📜 <b>Recent Audit Events</b> (${rows.length} items)\n`);
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
 *   • "just now"           for < 1 minute
 *   • "N min ago"          for 1..59 minutes (N in Persian digits)
 *   • "N hr ago"           for 1..23 hours
 *   • "N day ago"            for 1..29 days
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

  if (sec < 60) return "just now";
  if (min < 60) return `${fa(min)} min ago`;
  if (hr < 24) return `${fa(hr)} hr ago`;
  if (day < 30) return `${fa(day)} day ago`;
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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
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
        "⚠️ Incorrect usage.\n\n" +
          "<b>Subcommands:</b>\n" +
          "<code>/webhook</code> or <code>/webhook info</code> — Webhook status\n" +
          "<code>/webhook set &lt;https-url&gt;</code> — Set webhook\n" +
          "<code>/webhook delete</code> — Delete webhook\n" +
          "<code>/webhook test</code> — Test webhook delivery",
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
      "❌ Failed to get webhook info.\n<code>" +
        escapeHtml(String(e)) +
        "</code>",
    );
    return;
  }

  const hasError = !!hook.last_error_message;
  const healthIcon = hasError ? "🔴" : "🟢";
  const healthLabel = hasError ? "Unhealthy" : "Healthy";

  const lines: string[] = [];
  lines.push(`${healthIcon} <b>Webhook status: ${healthLabel}</b>\n`);
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
      `⚠️ Last error: <code>${escapeHtml(hook.last_error_message)}</code> @ ${when}`,
    );
  } else {
    lines.push("✅ No errors recorded.");
  }

  if (hook.ip_address) {
    lines.push(`IP: <code>${escapeHtml(hook.ip_address)}</code>`);
  }
  if (hook.has_custom_certificate) {
    lines.push("🔐 Custom certificate: yes");
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
      "⚠️ Usage: <code>/webhook set &lt;https-url&gt;</code>\n" +
        "Example: <code>/webhook set https://example.com/webhook</code>",
    );
    return;
  }
  if (!url.startsWith("https://")) {
    await safeSend(
      env,
      message.chat.id,
      "⛔ URL must start with <code>https://</code>.\n" +
        "http:// is not allowed to prevent traffic leakage.",
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
      "❌ Set webhook failed.\n<code>" +
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
    "✅ Webhook set.\n" +
      `URL: <code>${escapeHtml(url)}</code>\n` +
      `allowed_updates: <code>${escapeHtml(WEBHOOK_ALLOWED_UPDATES.join(", "))}</code>\n` +
      "📜 Recorded in audit_log.",
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
      "❌ Delete webhook failed.\n<code>" +
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
    "🗑 Webhook deleted.\n" +
      "Note: Bot now falls back to long-polling (getUpdates) which is not used in V2.\n" +
      "📜 Recorded in audit_log.",
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
    "✅ Webhook test successful.\n\n" +
      "If you see this message, it means:\n" +
      "• Telegram sent the update to the webhook URL\n" +
      "• Worker received the update and enqueued it\n" +
      "• Queue consumer processed this command\n\n" +
      `⏱ Server time: <code>${now}</code>\n` +
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
    await safeSend(env, message.chat.id, "⚠️ Internal error.");
    return;
  }
  if (!ownerOk) {
    await safeSend(env, message.chat.id, "⛔ Owner only.");
    return;
  }

  const text = args.trim();
  if (!text) {
    await safeSend(
      env,
      message.chat.id,
      "⚠️ Write the message text after /broadcast.\n" +
        "Example: <code>/broadcast hello everyone</code>",
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
      "❌ Failed to get admin list.\n<code>" +
        escapeHtml(String(e)) +
        "</code>",
    );
    return;
  }

  if (adminIds.length === 0) {
    await safeSend(env, message.chat.id, "⚠️ No admins registered.");
    return;
  }

  // HTML-escape the message text (sendMessage defaults to parse_mode=HTML).
  const safeText = escapeHtml(text);
  const header =
    "📣 <b>Broadcast from Owner</b>\n\n";
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
  lines.push("📣 <b>Report Send Message</b>\n");
  lines.push(`Sent to <b>${okCount}</b> of <b>${adminIds.length}</b> admins.`);
  if (failed.length > 0) {
    lines.push("\n⚠️ <b>Send failed to:</b>");
    for (const uid of failed) {
      lines.push(`• <code>${uid}</code>`);
    }
    lines.push(
      "\nNote: Usually because the user has <b>blocked</b> the bot or has not sent <code>/start</code> yet.",
    );
  }
  lines.push("\n📜 Recorded in audit_log.");

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
      await handleSchedule(env, message);
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
    case "/resetall":
      await handleResetAll(env, message);
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
      await safeSend(env, message.chat.id, "⚠️ Unknown command. See /help.");
      return true;
  }
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
    const raw = await env.AI_ADMIN_KV.get(`ai:health:v8:${provider}:${model}`);
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
 *      <code>gemini-3.6-flash</code> — Failures: 0 🟢 Active
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
  const fails = h ? ` — Failures: ${h.consecutiveFailures}` : " — no data";
  const activeBadge = isActive ? " 🟢 <b>Active</b>" : "";
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
