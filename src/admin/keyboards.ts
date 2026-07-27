/**
 * src/admin/keyboards.ts
 * -----------------------------------------------------------------------------
 * Inline-keyboard builders for the admin panel.
 *
 * Every builder returns a JSON-encoded `reply_markup` string ready to pass to
 * `sendMessage` / `editMessageText` / etc. Buttons carry `callback_data`
 * strings that the callback router in `./callbacks.ts` dispatches on.
 *
 * CALLBACK_DATA NAMESPACE (kept ≤ 64 bytes per Telegram limit):
 *
 *   menu:                        (re-show main menu)
 *   set:settings                 show settings keyboard
 *   set:stats                    show stats
 *   set:schedule                 show schedule info
 *   set:status                   show bot status
 *   set:admins                   owner: show admin list
 *   set:help                     show help
 *   set:testai                   run a tiny AI test
 *   pick:rewrite                 open rewrite-mode subkeyboard
 *   pick:personality             open personality subkeyboard
 *   pick:editint                 open edit-intensity subkeyboard
 *   pick:emoji                   open emoji-level subkeyboard
 *   pick:lang                    open language subkeyboard
 *   pick:provider                open AI-provider subkeyboard
 *   pick:gemodel                 open gemini-model subkeyboard
 *   pick:ormodel                 open openrouter-model subkeyboard
 *   set:rewrite:{mode}           set settings.rewriteMode
 *   set:personality:{mode}       set settings.personalityMode
 *   set:editint:{n}              set settings.editIntensity
 *   set:emoji:{n}                set settings.emojiLevel
 *   set:lang:{mode}              set settings.languageMode
 *   set:approval:{on|off}        set settings.approvalMode
 *   set:channeledit:{on|off}     set settings.channelEditing
 *   set:provider:{gemini|openrouter}
 *   set:gemodel:{id}             set settings.geminiModel
 *   set:ormodel:{id}             set settings.openrouterModel
 *   pub:{jobId}                  approve+publish an approval job
 *   rej:{jobId}                  reject an approval job
 *   rmadmin:{userId}             remove an admin (owner only)
 *   addadmin                     start add-admin flow
 *   back:menu                    back to main menu
 *   back:settings                back to settings keyboard
 *   back:admins                  back to admin list
 *   noop                         no-op (used for non-clickable info buttons)
 * -----------------------------------------------------------------------------
 */

import type { AdminRecord, RewriteMode, Role, Settings } from "../types";
import {
  GEMINI_MODELS,
  OPENROUTER_MODELS,
} from "../config/defaults";
import { buildInlineKeyboard } from "../telegram/entities";

// ============================================================
// Persian label helpers
// ============================================================

const REWRITE_LABELS_FA: Record<RewriteMode, string> = {
  none: "خاموش",
  light: "سبک",
  normal: "معمول",
  aggressive: "پرخاشگر",
};

const PERSONALITY_LABELS_FA: Record<Settings["personalityMode"], string> = {
  friendly: "دوستانه",
  professional: "حرفه‌ای",
  neutral: "خنثی",
};

const LANGUAGE_LABELS_FA: Record<Settings["languageMode"], string> = {
  auto: "خودکار",
  fa: "فارسی",
  en: "انگلیسی",
};

const PROVIDER_LABELS_FA: Record<Settings["aiProvider"], string> = {
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

/** Mark the currently-selected option with ✅. */
function mark(current: boolean): string {
  return current ? " ✅" : "";
}

// ============================================================
// Main menu
// ============================================================

/**
 * Build the main admin menu. The "👥 ادمین‌ها" button appears ONLY for the
 * owner — this is the first line of defense for V1 bug #4 (any admin could
 * manage admins). The router also re-checks `isOwner` on the callback, so a
 * spoofed `set:admins` callback_data from a non-owner is still rejected.
 */
export function mainMenuKeyboard(role: Role | null): string {
  const rows: { text: string; callback_data: string }[][] = [
    [
      { text: "⚙️ تنظیمات", callback_data: "set:settings" },
      { text: "📊 آمار", callback_data: "set:stats" },
      { text: "📅 زمان‌بندی", callback_data: "set:schedule" },
    ],
    [
      { text: "🧪 تست AI", callback_data: "set:testai" },
      { text: "🔍 وضعیت", callback_data: "set:status" },
      { text: "❓ راهنما", callback_data: "set:help" },
    ],
  ];

  if (role === "owner") {
    rows.push([
      { text: "👥 ادمین‌ها", callback_data: "set:admins" },
    ]);
  }

  return buildInlineKeyboard(rows);
}

// ============================================================
// Settings
// ============================================================

/**
 * Settings keyboard. Each row shows a setting with its current value; clicking
 * opens a subkeyboard (via `pick:*`) or toggles a boolean directly
 * (via `set:approval:{other}` / `set:channeledit:{other}`).
 */
export function settingsKeyboard(settings: Settings): string {
  const approvalOther = settings.approvalMode ? "off" : "on";
  const channelEditOther = settings.channelEditing ? "off" : "on";

  const rows: { text: string; callback_data: string }[][] = [
    [
      {
        text: `✍️ بازنویسی: ${REWRITE_LABELS_FA[settings.rewriteMode]}`,
        callback_data: "pick:rewrite",
      },
      {
        text: `🎭 شخصیت: ${PERSONALITY_LABELS_FA[settings.personalityMode]}`,
        callback_data: "pick:personality",
      },
    ],
    [
      {
        text: `📊 شدت ویرایش: ${settings.editIntensity}`,
        callback_data: "pick:editint",
      },
      {
        text: `😀 ایموجی: ${settings.emojiLevel}`,
        callback_data: "pick:emoji",
      },
    ],
    [
      {
        text: `🌐 زبان: ${LANGUAGE_LABELS_FA[settings.languageMode]}`,
        callback_data: "pick:lang",
      },
      {
        text: `✅ تایید: ${settings.approvalMode ? "روشن" : "خاموش"}`,
        callback_data: `set:approval:${approvalOther}`,
      },
    ],
    [
      {
        text: `📝 ویرایش کانال: ${settings.channelEditing ? "روشن" : "خاموش"}`,
        callback_data: `set:channeledit:${channelEditOther}`,
      },
      {
        text: `🤖 هوش مصنوعی: ${PROVIDER_LABELS_FA[settings.aiProvider]}`,
        callback_data: "pick:provider",
      },
    ],
    [
      { text: "🔙 بازگشت", callback_data: "back:menu" },
    ],
  ];

  return buildInlineKeyboard(rows);
}

// ============================================================
// Subkeyboards
// ============================================================

/**
 * Rewrite-mode picker. Four options; the current mode is marked with ✅.
 * Clicking a button calls `set:rewrite:{mode}` which updates settings and
 * re-renders the settings keyboard (so the user sees their choice reflected).
 */
export function rewriteModeKeyboard(current: RewriteMode): string {
  const modes: RewriteMode[] = ["none", "light", "normal", "aggressive"];
  const rows: { text: string; callback_data: string }[][] = [
    modes.map((m) => ({
      text: `${REWRITE_LABELS_FA[m]}${mark(current === m)}`,
      callback_data: `set:rewrite:${m}`,
    })),
    [{ text: "🔙 بازگشت", callback_data: "back:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

/**
 * Personality-mode picker (3 options).
 */
export function personalityModeKeyboard(
  current: Settings["personalityMode"],
): string {
  const modes: Settings["personalityMode"][] = [
    "friendly",
    "professional",
    "neutral",
  ];
  const rows: { text: string; callback_data: string }[][] = [
    modes.map((m) => ({
      text: `${PERSONALITY_LABELS_FA[m]}${mark(current === m)}`,
      callback_data: `set:personality:${m}`,
    })),
    [{ text: "🔙 بازگشت", callback_data: "back:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

/**
 * Edit-intensity picker (4 presets: 0 / 30 / 60 / 100).
 */
export function editIntensityKeyboard(current: number): string {
  const presets = [0, 30, 60, 100];
  const rows: { text: string; callback_data: string }[][] = [
    presets.map((n) => ({
      text: `${n}${mark(current === n)}`,
      callback_data: `set:editint:${n}`,
    })),
    [{ text: "🔙 بازگشت", callback_data: "back:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

/**
 * Emoji-level picker (4 presets: 0 / 20 / 50 / 100).
 */
export function emojiLevelKeyboard(current: number): string {
  const presets = [0, 20, 50, 100];
  const rows: { text: string; callback_data: string }[][] = [
    presets.map((n) => ({
      text: `${n}${mark(current === n)}`,
      callback_data: `set:emoji:${n}`,
    })),
    [{ text: "🔙 بازگشت", callback_data: "back:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

/**
 * Language-mode picker (3 options).
 */
export function languageModeKeyboard(
  current: Settings["languageMode"],
): string {
  const modes: Settings["languageMode"][] = ["auto", "fa", "en"];
  const rows: { text: string; callback_data: string }[][] = [
    modes.map((m) => ({
      text: `${LANGUAGE_LABELS_FA[m]}${mark(current === m)}`,
      callback_data: `set:lang:${m}`,
    })),
    [{ text: "🔙 بازگشت", callback_data: "back:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

/**
 * AI-provider picker (2 options). Selecting a provider does NOT change the
 * active model — that's a separate subkeyboard reached via `pick:gemodel` /
 * `pick:ormodel`.
 */
export function providerKeyboard(current: string): string {
  const rows: { text: string; callback_data: string }[][] = [
    [
      {
        text: `Gemini${mark(current === "gemini")}`,
        callback_data: "set:provider:gemini",
      },
      {
        text: `OpenRouter${mark(current === "openrouter")}`,
        callback_data: "set:provider:openrouter",
      },
    ],
    [{ text: "🔙 بازگشت", callback_data: "back:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

/**
 * Gemini model picker. Renders ALL configured Gemini models from the catalog
 * (currently 6), marks the current one, plus a back button.
 */
export function geminiModelKeyboard(current: string): string {
  const rows: { text: string; callback_data: string }[][] = [];
  // Two per row for readability of the labels.
  for (let i = 0; i < GEMINI_MODELS.length; i += 2) {
    const slice = GEMINI_MODELS.slice(i, i + 2);
    rows.push(
      slice.map((m) => ({
        text: `${m.label}${mark(current === m.id)}`,
        callback_data: `set:gemodel:${m.id}`,
      })),
    );
  }
  rows.push([{ text: "🔙 بازگشت", callback_data: "back:settings" }]);
  return buildInlineKeyboard(rows);
}

/**
 * OpenRouter model picker. Renders ALL configured OpenRouter models
 * (currently 6), marks the current one, plus a back button.
 */
export function openrouterModelKeyboard(current: string): string {
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < OPENROUTER_MODELS.length; i += 2) {
    const slice = OPENROUTER_MODELS.slice(i, i + 2);
    rows.push(
      slice.map((m) => ({
        text: `${m.label}${mark(current === m.id)}`,
        callback_data: `set:ormodel:${m.id}`,
      })),
    );
  }
  rows.push([{ text: "🔙 بازگشت", callback_data: "back:settings" }]);
  return buildInlineKeyboard(rows);
}

// ============================================================
// Approval
// ============================================================

/**
 * Approval keyboard attached to the preview message. Two buttons:
 *
 *   ✅ انتشار → pub:{jobId}   publishes the post to TARGET_CHANNEL
 *   ❌ رد     → rej:{jobId}   rejects the post (marks job rejected)
 *
 * The jobId is a stable identifier; the approval state machine in
 * `./approval.ts` uses a conditional UPDATE (WHERE status='pending') so that
 * a double-click on the same button is a no-op (idempotent). After handling,
 * the preview message is edited to a `disabledKeyboard` so the buttons
 * visually disappear — fixes V1 bug where buttons remained clickable after
 * approval.
 */
export function approvalKeyboard(jobId: string): string {
  const rows: { text: string; callback_data: string }[][] = [
    [
      { text: "✅ انتشار", callback_data: `pub:${jobId}` },
      { text: "❌ رد", callback_data: `rej:${jobId}` },
    ],
  ];
  return buildInlineKeyboard(rows);
}

// ============================================================
// Admin list
// ============================================================

/**
 * Admin list keyboard. One row per admin:
 *   👤 {name} — {roleLabel} {👑 for owner / 🗑 for others}
 *
 * The owner row has `callback_data: "noop"` (clicking does nothing — owner
 * cannot be removed). All other rows carry `rmadmin:{userId}` so clicking
 * them removes that admin (router re-checks isOwner).
 *
 * The final row has "➕ افزودن ادمین" (callback `addadmin`) which kicks off
 * the add-admin flow, and "🔙 بازگشت".
 */
export function adminListKeyboard(
  admins: AdminRecord[],
  ownerId: number,
): string {
  const rows: { text: string; callback_data: string }[][] = [];

  for (const a of admins) {
    const isOwner = a.userId === ownerId;
    const name = a.firstName || a.username || `(${a.userId})`;
    const roleTag = isOwner ? "مالک 👑" : roleTagFa(a.role);
    const text = `👤 ${name} — ${roleTag}${isOwner ? "" : " 🗑"}`;
    rows.push([
      {
        text,
        callback_data: isOwner ? "noop" : `rmadmin:${a.userId}`,
      },
    ]);
  }

  rows.push([{ text: "➕ افزودن ادمین", callback_data: "addadmin" }]);
  rows.push([{ text: "🔙 بازگشت", callback_data: "back:menu" }]);

  return buildInlineKeyboard(rows);
}

/** Small helper for non-owner role tags in the admin list. */
function roleTagFa(role: Role): string {
  switch (role) {
    case "owner":
      return "مالک";
    case "editor":
      return "ویراستار";
    case "reviewer":
      return "بازبین";
    case "viewer":
      return "بیننده";
  }
}

// ============================================================
// Disabled keyboard (post-callback visual lock)
// ============================================================

/**
 * Return a single-button keyboard used to REPLACE the approval keyboard after
 * the user has acted. The button text describes the final state (e.g.
 * "✅ انتشار شد"). The button carries `callback_data: "noop"` so even if the
 * user taps it again, nothing happens — this is the visual half of the fix
 * for V1's "buttons remain clickable after approval" bug. The other half is
 * the conditional UPDATE in approval-repo that makes the state transition
 * idempotent.
 */
export function disabledKeyboard(text: string): string {
  return buildInlineKeyboard([[{ text, callback_data: "noop" }]]);
}
