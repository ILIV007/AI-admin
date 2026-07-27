/**
 * src/admin/callbacks.ts
 * -----------------------------------------------------------------------------
 * Central callback-query router.
 *
 * Flow:
 *   1. Receive cq, read cq.data.
 *   2. `noop` buttons (info-only rows) — silent answer, return.
 *   3. `pub:` / `rej:` — delegate fully to approval.ts (which answers + edits).
 *   4. For all other callbacks: load auth (isAuthorized + getRole); reject if
 *      not authorized.
 *   5. Dispatch on prefix:
 *        set:*      settings nav + setting updates
 *        pick:*     open subkeyboards
 *        rmadmin:*  owner-only remove admin
 *        addadmin   owner-only start add-admin flow
 *        back:*     return to a higher-level menu
 *        menu:*     alias for back:menu
 *   6. After handling, `editMessageText` (or editMessageReplyMarkup) so the
 *      keyboard visually reflects the new state. This is the visible half of
 *      the fix for V1's "buttons remain clickable after callback" bug.
 *   7. Audit log important mutations (settings changes, admin add/remove).
 *
 * OWNER-ONLY CHECKS (V1 bug #4): callbacks that touch admin membership
 * (`set:admins`, `rmadmin:*`, `addadmin`) check `isOwner(userId)` directly —
 * NOT just `isAuthorized` or `role === "owner"`. The owner is the single
 * Telegram ID in env.ADMIN_ID; only that account can manage admins.
 * -----------------------------------------------------------------------------
 */

import type {
  Env,
  Role,
  Settings,
  Stats,
  TelegramCallbackQuery,
} from "../types";
import { ownerUserId } from "../config/env";
import { answerCallbackQuery, editMessageText } from "../telegram/client";
import { escapeHtml } from "../telegram/entities";
import { can, roleLabel } from "../domain/roles";
import { log } from "../observability/logger";
import { handleApprovalCallback } from "./approval";
import { setAddAdminFlag } from "./addadmin";
import {
  adminListKeyboard,
  editIntensityKeyboard,
  emojiLevelKeyboard,
  geminiModelKeyboard,
  languageModeKeyboard,
  mainMenuKeyboard,
  openrouterModelKeyboard,
  personalityModeKeyboard,
  providerKeyboard,
  rewriteModeKeyboard,
  settingsKeyboard,
} from "./keyboards";
import {
  audit,
  getRole,
  isAuthorized,
  isOwner,
  listAdmins,
  removeAdmin,
} from "../storage/repositories/admins";
import {
  getSettings,
  saveSettings,
} from "../storage/repositories/settings";
import { getStats } from "../storage/repositories/stats";

const SCOPE = "admin.callbacks";

// ============================================================
// Public entry
// ============================================================

export async function handleCallbackQuery(
  env: Env,
  cq: TelegramCallbackQuery,
): Promise<void> {
  const data = cq.data ?? "";
  if (!data) return;

  // Info-only buttons (e.g. owner row in admin list) — silent answer.
  if (data === "noop") {
    await safeAnswer(env, cq.id, "ℹ️ این دکمه قابل کلیک نیست");
    return;
  }

  // Approval callbacks delegate fully to approval.ts (which answers + edits).
  if (data.startsWith("pub:") || data.startsWith("rej:")) {
    await handleApprovalCallback(env, cq);
    return;
  }

  // Auth check for everything else.
  const fromId = cq.from.id;
  let authorized = false;
  let role: Role | null = null;
  try {
    authorized = await isAuthorized(env, fromId);
    if (authorized) role = await getRole(env, fromId);
  } catch (e) {
    log("error", SCOPE, "auth check failed", { error: String(e) });
    await safeAnswer(env, cq.id, "⚠️ خطای داخلی", true);
    return;
  }

  if (!authorized || !role) {
    await safeAnswer(env, cq.id, "⛔ دسترسی غیرمجاز", true);
    return;
  }

  try {
    if (data.startsWith("set:")) {
      await handleSet(env, cq, data, role);
    } else if (data.startsWith("pick:")) {
      await handlePick(env, cq, data, role);
    } else if (data.startsWith("rmadmin:")) {
      await handleRmAdmin(env, cq, data, role);
    } else if (data === "addadmin") {
      await handleAddAdmin(env, cq, role);
    } else if (data.startsWith("back:")) {
      await handleBack(env, cq, data, role);
    } else if (data === "menu" || data.startsWith("menu:")) {
      await editToMainMenu(env, cq, role);
    } else {
      await safeAnswer(env, cq.id, "⚠️ عملیات ناشناخته", true);
    }
  } catch (e) {
    log("error", SCOPE, "callback handler threw", { error: String(e), data });
    await safeAnswer(env, cq.id, "⚠️ خطای داخلی", true);
  }
}

// ============================================================
// set:* — settings navigation + setting updates
// ============================================================

async function handleSet(
  env: Env,
  cq: TelegramCallbackQuery,
  data: string,
  role: Role,
): Promise<void> {
  const fromId = cq.from.id;
  const parts = data.split(":");

  // --- Navigation callbacks (no settings mutation) ---
  switch (data) {
    case "set:settings": {
      if (!can(role, "change_settings")) {
        await safeAnswer(env, cq.id, "⛔ دسترسی غیرمجاز", true);
        return;
      }
      const settings = await getSettingsFor(env, fromId);
      await editText(
        env,
        cq,
        "⚙️ <b>تنظیمات</b>\nیک گزینه را برای تغییر انتخاب کنید:",
        settingsKeyboard(settings),
      );
      return;
    }
    case "set:stats": {
      if (!can(role, "view_stats")) {
        await safeAnswer(env, cq.id, "⛔ دسترسی غیرمجاز", true);
        return;
      }
      const text = await buildStatsText(env, fromId);
      await editText(env, cq, text);
      return;
    }
    case "set:schedule": {
      if (!can(role, "schedule")) {
        await safeAnswer(env, cq.id, "⛔ دسترسی غیرمجاز", true);
        return;
      }
      const flag = await env.AI_ADMIN_KV.get(`sched_next:${fromId}`).catch(() => null);
      const text = flag
        ? `📅 <b>زمان‌بندی فعال</b>\n\nپست بعدی شما در <code>${new Date(
            Number(flag),
          ).toISOString()}</code> منتشر خواهد شد.\nبرای لغو: <code>/schedule cancel</code>`
        : "📅 <b>زمان‌بندی</b>\n\nهیچ زمان‌بندی فعالی ندارید.\nبرای فعال‌سازی: <code>/schedule in 30m</code>";
      await editText(env, cq, text);
      return;
    }
    case "set:status": {
      const text = `🔍 <b>وضعیت</b>\n\nربات: آنلاین ✅\nکانال: <code>${escapeHtml(
        env.TARGET_CHANNEL,
      )}</code>\nمالک: <code>${ownerUserId(env)}</code>`;
      await editText(env, cq, text);
      return;
    }
    case "set:admins": {
      await showAdminList(env, cq, role);
      return;
    }
    case "set:help": {
      const text =
        "❓ <b>راهنما</b>\n\n" +
        "/start — معرفی\n/help — دستورات\n/menu — منو\n/footer &lt;متن&gt; — فوتر\n" +
        "/checkperms — دسترسی‌های ربات\n/stats — آمار\n/admins — ادمین‌ها\n" +
        "/schedule &lt;زمان&gt; — زمان‌بندی\n/ping — وضعیت سرور";
      await editText(env, cq, text);
      return;
    }
    case "set:testai": {
      await runAiTest(env, cq);
      return;
    }
  }

  // --- Setting-update callbacks (require change_settings permission) ---
  // Approval/reject buttons (set:approval:*) are the only set:* updates that
  // a reviewer might want — but per role matrix, only owner+editor have
  // change_settings, so we gate ALL set:* updates on change_settings.
  if (!can(role, "change_settings")) {
    await safeAnswer(env, cq.id, "⛔ دسترسی غیرمجاز", true);
    return;
  }

  const settings = await getSettingsFor(env, fromId);
  let mutated = false;
  let auditAction: string | undefined;
  let auditDetail: string | undefined;

  // set:rewrite:{mode}
  if (parts[1] === "rewrite" && parts[2]) {
    const mode = parts[2] as Settings["rewriteMode"];
    if (mode === "none" || mode === "light" || mode === "normal" || mode === "aggressive") {
      settings.rewriteMode = mode;
      mutated = true;
      auditAction = "settings.rewriteMode";
      auditDetail = mode;
    }
  } else if (parts[1] === "personality" && parts[2]) {
    const mode = parts[2] as Settings["personalityMode"];
    if (mode === "friendly" || mode === "professional" || mode === "neutral") {
      settings.personalityMode = mode;
      mutated = true;
      auditAction = "settings.personalityMode";
      auditDetail = mode;
    }
  } else if (parts[1] === "editint" && parts[2] != null) {
    const n = parseInt(parts[2], 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 100) {
      settings.editIntensity = n;
      mutated = true;
      auditAction = "settings.editIntensity";
      auditDetail = String(n);
    }
  } else if (parts[1] === "emoji" && parts[2] != null) {
    const n = parseInt(parts[2], 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 100) {
      settings.emojiLevel = n;
      mutated = true;
      auditAction = "settings.emojiLevel";
      auditDetail = String(n);
    }
  } else if (parts[1] === "lang" && parts[2]) {
    const mode = parts[2] as Settings["languageMode"];
    if (mode === "auto" || mode === "fa" || mode === "en") {
      settings.languageMode = mode;
      mutated = true;
      auditAction = "settings.languageMode";
      auditDetail = mode;
    }
  } else if (parts[1] === "approval" && (parts[2] === "on" || parts[2] === "off")) {
    settings.approvalMode = parts[2] === "on";
    mutated = true;
    auditAction = "settings.approvalMode";
    auditDetail = parts[2];
  } else if (parts[1] === "channeledit" && (parts[2] === "on" || parts[2] === "off")) {
    settings.channelEditing = parts[2] === "on";
    mutated = true;
    auditAction = "settings.channelEditing";
    auditDetail = parts[2];
  } else if (parts[1] === "provider" && (parts[2] === "gemini" || parts[2] === "openrouter")) {
    settings.aiProvider = parts[2];
    mutated = true;
    auditAction = "settings.aiProvider";
    auditDetail = parts[2];
  } else if (parts[1] === "gemodel" && parts[2]) {
    settings.geminiModel = parts.slice(2).join(":"); // model IDs may contain ":"
    mutated = true;
    auditAction = "settings.geminiModel";
    auditDetail = settings.geminiModel;
  } else if (parts[1] === "ormodel" && parts[2]) {
    settings.openrouterModel = parts.slice(2).join(":");
    mutated = true;
    auditAction = "settings.openrouterModel";
    auditDetail = settings.openrouterModel;
  }

  if (!mutated) {
    await safeAnswer(env, cq.id, "⚠️ مقدار نامعتبر", true);
    return;
  }

  // Persist + audit.
  try {
    await saveSettings(env, fromId, settings);
  } catch (e) {
    log("error", SCOPE, "saveSettings failed", { error: String(e) });
    await safeAnswer(env, cq.id, "❌ خطا در ذخیره", true);
    return;
  }

  if (auditAction) {
    void auditLog(env, fromId, auditAction, `u:${fromId}`, auditDetail);
  }

  // Re-render the settings keyboard so the user sees the new value.
  await safeAnswer(env, cq.id, "✅ ذخیره شد");
  await editText(
    env,
    cq,
    "⚙️ <b>تنظیمات</b>\nیک گزینه را برای تغییر انتخاب کنید:",
    settingsKeyboard(settings),
  );
}

// ============================================================
// pick:* — open a subkeyboard
// ============================================================

async function handlePick(
  env: Env,
  cq: TelegramCallbackQuery,
  data: string,
  role: Role,
): Promise<void> {
  if (!can(role, "change_settings")) {
    await safeAnswer(env, cq.id, "⛔ دسترسی غیرمجاز", true);
    return;
  }
  const fromId = cq.from.id;
  const settings = await getSettingsFor(env, fromId);
  const which = data.slice("pick:".length);

  let keyboard: string;
  let text: string;
  switch (which) {
    case "rewrite":
      keyboard = rewriteModeKeyboard(settings.rewriteMode);
      text = "✍️ <b>حالت بازنویسی</b>\nیک گزینه را انتخاب کنید:";
      break;
    case "personality":
      keyboard = personalityModeKeyboard(settings.personalityMode);
      text = "🎭 <b>شخصیت</b>\nیک گزینه را انتخاب کنید:";
      break;
    case "editint":
      keyboard = editIntensityKeyboard(settings.editIntensity);
      text = "📊 <b>شدت ویرایش</b>\nمقدار را انتخاب کنید:";
      break;
    case "emoji":
      keyboard = emojiLevelKeyboard(settings.emojiLevel);
      text = "😀 <b>سطح ایموجی</b>\nمقدار را انتخاب کنید:";
      break;
    case "lang":
      keyboard = languageModeKeyboard(settings.languageMode);
      text = "🌐 <b>زبان</b>\nیک گزینه را انتخاب کنید:";
      break;
    case "provider":
      keyboard = providerKeyboard(settings.aiProvider);
      text = "🤖 <b>ارائه‌دهنده AI</b>\nیک گزینه را انتخاب کنید:";
      break;
    case "gemodel":
      keyboard = geminiModelKeyboard(settings.geminiModel);
      text = "💎 <b>مدل Gemini</b>\nیک مدل را انتخاب کنید:";
      break;
    case "ormodel":
      keyboard = openrouterModelKeyboard(settings.openrouterModel);
      text = "🦙 <b>مدل OpenRouter</b>\nیک مدل را انتخاب کنید:";
      break;
    default:
      await safeAnswer(env, cq.id, "⚠️ عملیات ناشناخته", true);
      return;
  }
  await safeAnswer(env, cq.id, "");
  await editText(env, cq, text, keyboard);
}

// ============================================================
// rmadmin:* — owner-only remove admin
// ============================================================

async function handleRmAdmin(
  env: Env,
  cq: TelegramCallbackQuery,
  data: string,
  _role: Role,
): Promise<void> {
  const fromId = cq.from.id;
  if (!(await isOwnerCheck(env, fromId))) {
    await safeAnswer(env, cq.id, "⛔ فقط مالک می‌تواند ادمین حذف کند", true);
    return;
  }

  const targetId = parseInt(data.slice("rmadmin:".length), 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    await safeAnswer(env, cq.id, "⚠️ آیدی نامعتبر", true);
    return;
  }
  if (targetId === ownerUserId(env)) {
    await safeAnswer(env, cq.id, "⚠️ مالک قابل حذف نیست", true);
    return;
  }

  try {
    await removeAdmin(env, targetId);
  } catch (e) {
    log("error", SCOPE, "removeAdmin failed", { error: String(e) });
    await safeAnswer(env, cq.id, "❌ خطا در حذف", true);
    return;
  }

  void auditLog(env, fromId, "admin.remove", `u:${targetId}`);
  await safeAnswer(env, cq.id, "✅ ادمین حذف شد");

  // Refresh the admin list keyboard.
  await showAdminList(env, cq, "owner");
}

// ============================================================
// addadmin — owner-only start add-admin flow
// ============================================================

async function handleAddAdmin(
  env: Env,
  cq: TelegramCallbackQuery,
  _role: Role,
): Promise<void> {
  const fromId = cq.from.id;
  if (!(await isOwnerCheck(env, fromId))) {
    await safeAnswer(env, cq.id, "⛔ فقط مالک می‌تواند ادمین اضافه کند", true);
    return;
  }

  await setAddAdminFlag(env, fromId);
  await safeAnswer(env, cq.id, "");
  await editText(
    env,
    cq,
    "➕ <b>افزودن ادمین</b>\n\nآیدی عددی کاربر را بفرستید.\n" +
      "فرمت: <code>آیدی نقش</code>\n" +
      "نقش‌ها: <code>editor</code>, <code>reviewer</code>, <code>viewer</code>\n\n" +
      "مثال: <code>123456789 editor</code>\n" +
      "⚠️ این حالت تا ۲ دقیقه فعال است.",
  );
}

// ============================================================
// back:* — return to a higher-level menu
// ============================================================

async function handleBack(
  env: Env,
  cq: TelegramCallbackQuery,
  data: string,
  role: Role,
): Promise<void> {
  const target = data.slice("back:".length);
  switch (target) {
    case "menu":
      await editToMainMenu(env, cq, role);
      return;
    case "settings": {
      if (!can(role, "change_settings")) {
        await editToMainMenu(env, cq, role);
        return;
      }
      const settings = await getSettingsFor(env, cq.from.id);
      await editText(
        env,
        cq,
        "⚙️ <b>تنظیمات</b>\nیک گزینه را برای تغییر انتخاب کنید:",
        settingsKeyboard(settings),
      );
      return;
    }
    case "admins":
      await showAdminList(env, cq, role);
      return;
    default:
      await editToMainMenu(env, cq, role);
      return;
  }
}

// ============================================================
// Helpers — message editing
// ============================================================

async function editToMainMenu(
  env: Env,
  cq: TelegramCallbackQuery,
  role: Role,
): Promise<void> {
  const text =
    `🎛 <b>منوی مدیریت</b>\n\n` +
    `نقش: <b>${escapeHtml(roleLabel(role))}</b>\n` +
    `یک گزینه را انتخاب کنید:`;
  await editText(env, cq, text, mainMenuKeyboard(role));
}

async function showAdminList(
  env: Env,
  cq: TelegramCallbackQuery,
  _role: Role,
): Promise<void> {
  if (!(await isOwnerCheck(env, cq.from.id))) {
    await safeAnswer(env, cq.id, "⛔ فقط مالک", true);
    return;
  }

  let admins: import("../types").AdminRecord[] = [];
  try {
    admins = await listAdmins(env);
  } catch (e) {
    log("error", SCOPE, "listAdmins failed", { error: String(e) });
    await safeAnswer(env, cq.id, "❌ خطا", true);
    return;
  }

  const keyboard = adminListKeyboard(admins, ownerUserId(env));
  const text =
    `👥 <b>مدیریت ادمین‌ها</b>\n\n` +
    `تعداد: ${admins.length}\n` +
    `برای حذف، روی ردیف ادمین ضربه بزنید. مالک قابل حذف نیست.`;
  await editText(env, cq, text, keyboard);
}

async function runAiTest(
  env: Env,
  cq: TelegramCallbackQuery,
): Promise<void> {
  // Quick answer so the spinner clears; we'll edit the message with results.
  await safeAnswer(env, cq.id, "🧪 در حال آزمایش…");

  const fromId = cq.from.id;
  const settings = await getSettingsFor(env, fromId);

  let resultText: string;
  try {
    const aiMod: {
      rewriteWithFallback?: (
        env: Env,
        req: import("../types").AIRequest,
      ) => Promise<import("../types").AIResult>;
    } = await import("../ai/fallback");
    if (!aiMod.rewriteWithFallback) {
      throw new Error("rewriteWithFallback not available");
    }

    const { getProfile } = await import("../config/defaults");
    const profile = getProfile(settings.profile);
    const req: import("../types").AIRequest = {
      text: "Python 3.13 released with improved error messages and faster CPython startup.",
      classification: {
        category: "news",
        language: "en",
        hasCode: false,
        hasGithubLink: false,
        hasLongText: false,
        wordCount: 10,
        recommendedRewrite: "light",
        recommendedNeedsRewrite: true,
      },
      settings,
      profile,
      mode: "rewrite",
    };
    const t0 = Date.now();
    const r = await aiMod.rewriteWithFallback(env, req);
    const dt = Date.now() - t0;
    if (r.ok) {
      resultText =
        `🧪 <b>تست AI موفق</b>\n\n` +
        `<blockquote>${escapeHtml(r.text)}</blockquote>\n\n` +
        `ارائه‌دهنده: <code>${escapeHtml(r.provider)}</code>\n` +
        `مدل: <code>${escapeHtml(r.model)}</code>\n` +
        `زمان: ${dt}ms\n` +
        `توکن: ${r.tokensIn ?? "?"} → ${r.tokensOut ?? "?"}`;
    } else {
      resultText =
        `🧪 <b>تست AI ناموفق</b>\n\n` +
        `خطا: <code>${escapeHtml(r.error ?? "نامشخص")}</code>\n` +
        `ارائه‌دهنده: <code>${escapeHtml(r.provider)}</code>\n` +
        `مدل: <code>${escapeHtml(r.model)}</code>`;
    }
  } catch (e) {
    resultText = `🧪 <b>تست AI خطا</b>\n\n<code>${escapeHtml(String(e))}</code>`;
  }
  await editText(env, cq, resultText);
}

// ============================================================
// Helpers — settings / stats / audit / answer
// ============================================================

/**
 * Read settings for a user. Falls back to defaults on failure (best-effort;
 * the underlying repo also merges defaults on read).
 */
async function getSettingsFor(env: Env, userId: number): Promise<Settings> {
  try {
    return await getSettings(env, userId);
  } catch (e) {
    log("warn", SCOPE, "getSettings failed; using defaults", { error: String(e) });
    const { DEFAULT_SETTINGS } = await import("../config/defaults");
    return { ...DEFAULT_SETTINGS };
  }
}

async function buildStatsText(env: Env, userId: number): Promise<string> {
  let global: Stats | null = null;
  let mine: Stats | null = null;
  try {
    global = await getStats(env, "global");
    mine = await getStats(env, `u:${userId}`);
  } catch (e) {
    log("warn", SCOPE, "getStats failed", { error: String(e) });
  }
  const fmt = (s: Stats | null, t: string): string => {
    if (!s) return `${t}: (داده‌ای ثبت نشده)`;
    return (
      `${t}:\n📥 ${s.totalReceived}  📤 ${s.totalPublished}  ✍️ ${s.totalRewritten}\n` +
      `❌ ${s.totalFailed}  ✅ ${s.totalApprovals}  🚫 ${s.totalRejected}\n` +
      `📅 ${s.totalScheduled}  🤖 ${s.aiCalls}  ⚠️ ${s.aiFailures}`
    );
  };
  return `📊 <b>آمار</b>\n\n${fmt(global, "🌐 کلی")}\n\n${fmt(mine, "👤 شما")}`;
}

/**
 * Owner check that falls back to env.ADMIN_ID if the auth repo is
 * unavailable. Used by rmadmin / addadmin / set:admins callbacks.
 */
async function isOwnerCheck(env: Env, userId: number): Promise<boolean> {
  try {
    return await isOwner(env, userId);
  } catch (e) {
    log("warn", SCOPE, "isOwner check fell back to env", { error: String(e) });
    return userId === ownerUserId(env);
  }
}

/**
 * Best-effort audit wrapper. The underlying `audit` requires a non-empty
 * `detail` string; we substitute "-" when the caller has no detail.
 */
async function auditLog(
  env: Env,
  actorId: number,
  action: string,
  target: string,
  detail?: string,
): Promise<void> {
  try {
    await audit(env, actorId, action, target, detail && detail.length > 0 ? detail : "-");
  } catch (e) {
    log("warn", SCOPE, "audit failed", { error: String(e) });
  }
}

async function editText(
  env: Env,
  cq: TelegramCallbackQuery,
  text: string,
  replyMarkup?: string,
): Promise<void> {
  if (!cq.message) return;
  try {
    await editMessageText(env.BOT_TOKEN, {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text,
      reply_markup: replyMarkup,
    });
  } catch (e) {
    // "message is not modified" is benign — happens when the new text/keyboard
    // is identical to the current one (e.g. clicking the same button twice).
    log("warn", SCOPE, "editText failed", { error: String(e) });
  }
}

async function safeAnswer(
  env: Env,
  cqId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  try {
    await answerCallbackQuery(env.BOT_TOKEN, {
      callback_query_id: cqId,
      text: text || undefined,
      show_alert: showAlert,
    });
  } catch (e) {
    // Most common failure: query was already answered (Telegram allows only
    // the first answerCallbackQuery to show text). Safe to ignore.
    log("info", SCOPE, "answerCallbackQuery failed (likely already answered)", { error: String(e) });
  }
}
