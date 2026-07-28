/**
 * src/admin/keyboards.ts
 * Inline-keyboard builders for the admin panel.
 * All text is in English (default UI language). Persian labels are available
 * via i18n but keyboards use English for consistency.
 */

import type { AdminRecord, RewriteMode, Role, Settings } from "../types";
import {
  GEMINI_MODELS,
  OPENROUTER_MODELS,
} from "../config/defaults";
import { buildInlineKeyboard } from "../telegram/entities";

// English labels (default UI language)

const REWRITE_LABELS: Record<RewriteMode, string> = {
  none: "Off",
  light: "Light",
  normal: "Normal",
  aggressive: "Aggressive",
};

const PERSONALITY_LABELS: Record<Settings["personalityMode"], string> = {
  friendly: "Friendly",
  professional: "Professional",
  neutral: "Neutral",
};

const LANGUAGE_LABELS: Record<Settings["languageMode"], string> = {
  auto: "Auto",
  fa: "Persian",
  en: "English",
};

const PROVIDER_LABELS: Record<Settings["aiProvider"], string> = {
  gemini: "Gemini",
  openrouter: "OpenRouter",
};

function mark(current: boolean): string {
  return current ? " ✅" : "";
}

// ============================================================
// Main menu
// ============================================================

export function mainMenuKeyboard(role: Role | null): string {
  const rows: { text: string; callback_data: string }[][] = [
    [
      { text: "⚙️ Settings", callback_data: "set:settings" },
      { text: "📊 Stats", callback_data: "set:stats" },
      { text: "📅 Schedule", callback_data: "set:schedule" },
    ],
    [
      { text: "🧪 Test AI", callback_data: "set:testai" },
      { text: "🔍 Status", callback_data: "set:status" },
      { text: "❓ Help", callback_data: "set:help" },
    ],
  ];

  if (role === "owner") {
    rows.push([
      { text: "👥 Admins", callback_data: "set:admins" },
    ]);
  }

  return buildInlineKeyboard(rows);
}

// ============================================================
// Settings
// ============================================================

export function settingsKeyboard(settings: Settings): string {
  const approvalOther = settings.approvalMode ? "off" : "on";
  const channelEditOther = settings.channelEditing ? "off" : "on";

  const rows: { text: string; callback_data: string }[][] = [
    [
      {
        text: `✍️ Rewrite: ${REWRITE_LABELS[settings.rewriteMode]}`,
        callback_data: "pick:rewrite",
      },
      {
        text: `🎭 Personality: ${PERSONALITY_LABELS[settings.personalityMode]}`,
        callback_data: "pick:personality",
      },
    ],
    [
      {
        text: `📊 Edit Intensity: ${settings.editIntensity}`,
        callback_data: "pick:editint",
      },
      {
        text: `😀 Emoji Level: ${settings.emojiLevel}`,
        callback_data: "pick:emoji",
      },
    ],
    [
      {
        text: `🌐 Language: ${LANGUAGE_LABELS[settings.languageMode]}`,
        callback_data: "pick:lang",
      },
      {
        text: `✅ Approval: ${settings.approvalMode ? "On" : "Off"}`,
        callback_data: `set:approval:${approvalOther}`,
      },
    ],
    [
      {
        text: `📝 Channel Edit: ${settings.channelEditing ? "On" : "Off"}`,
        callback_data: `set:channeledit:${channelEditOther}`,
      },
      {
        text: `🤖 AI: ${PROVIDER_LABELS[settings.aiProvider]}`,
        callback_data: "pick:provider",
      },
    ],
    [
      { text: "🔙 Back", callback_data: "back:menu" },
    ],
  ];

  return buildInlineKeyboard(rows);
}

// ============================================================
// Subkeyboards
// ============================================================

export function rewriteModeKeyboard(current: RewriteMode): string {
  const modes: RewriteMode[] = ["none", "light", "normal", "aggressive"];
  const rows: { text: string; callback_data: string }[][] = [
    modes.map((m) => ({
      text: `${REWRITE_LABELS[m]}${mark(current === m)}`,
      callback_data: `set:rewrite:${m}`,
    })),
    [{ text: "🔙 Back", callback_data: "set:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

export function personalityKeyboard(current: Settings["personalityMode"]): string {
  const modes: Settings["personalityMode"][] = ["friendly", "professional", "neutral"];
  const rows: { text: string; callback_data: string }[][] = [
    modes.map((m) => ({
      text: `${PERSONALITY_LABELS[m]}${mark(current === m)}`,
      callback_data: `set:personality:${m}`,
    })),
    [{ text: "🔙 Back", callback_data: "set:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

export function editIntensityKeyboard(current: number): string {
  const levels = [0, 20, 40, 60, 80, 100];
  const rows: { text: string; callback_data: string }[][] = [
    levels.map((n) => ({
      text: `${n}${mark(current === n)}`,
      callback_data: `set:editint:${n}`,
    })),
    [{ text: "🔙 Back", callback_data: "set:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

export function emojiLevelKeyboard(current: number): string {
  const levels = [0, 20, 40, 60, 80, 100];
  const rows: { text: string; callback_data: string }[][] = [
    levels.map((n) => ({
      text: `${n}${mark(current === n)}`,
      callback_data: `set:emoji:${n}`,
    })),
    [{ text: "🔙 Back", callback_data: "set:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

export function languageKeyboard(current: Settings["languageMode"]): string {
  const modes: Settings["languageMode"][] = ["auto", "fa", "en"];
  const rows: { text: string; callback_data: string }[][] = [
    modes.map((m) => ({
      text: `${LANGUAGE_LABELS[m]}${mark(current === m)}`,
      callback_data: `set:lang:${m}`,
    })),
    [{ text: "🔙 Back", callback_data: "set:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

export function providerKeyboard(current: string): string {
  const rows: { text: string; callback_data: string }[][] = [
    [
      { text: `Gemini${mark(current === "gemini")}`, callback_data: "set:provider:gemini" },
      { text: `OpenRouter${mark(current === "openrouter")}`, callback_data: "set:provider:openrouter" },
    ],
    [{ text: "🔙 Back", callback_data: "set:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

export function geminiModelKeyboard(current: string): string {
  const rows: { text: string; callback_data: string }[][] = [
    GEMINI_MODELS.map((m) => ({
      text: `${m.label}${mark(current === m.id)}`,
      callback_data: `set:gemodel:${m.id}`,
    })),
    [{ text: "🔙 Back", callback_data: "set:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

export function openrouterModelKeyboard(current: string): string {
  const rows: { text: string; callback_data: string }[][] = [
    OPENROUTER_MODELS.map((m) => ({
      text: `${m.label}${mark(current === m.id)}`,
      callback_data: `set:ormodel:${m.id}`,
    })),
    [{ text: "🔙 Back", callback_data: "set:settings" }],
  ];
  return buildInlineKeyboard(rows);
}

// ============================================================
// Approval keyboard
// ============================================================

export function approvalKeyboard(jobId: string): string {
  return buildInlineKeyboard([
    [
      { text: "✅ Publish", callback_data: `pub:${jobId}` },
      { text: "❌ Reject", callback_data: `rej:${jobId}` },
    ],
  ]);
}

// ============================================================
// Admin list keyboard
// ============================================================

export function adminListKeyboard(admins: AdminRecord[], ownerId: number): string {
  const rows: { text: string; callback_data?: string }[][] = admins.map((a) => {
    const roleIcon = a.role === "owner" ? "👑" : a.role === "editor" ? "✏️" : a.role === "reviewer" ? "🔍" : "👁️";
    const label = `${roleIcon} ${a.username || a.firstName || a.userId}`;
    if (a.userId === ownerId) {
      return [{ text: `${label} (You)`, callback_data: "noop" }];
    }
    return [{ text: label, callback_data: "noop" }, { text: "🗑️", callback_data: `rmadmin:${a.userId}` }];
  });
  rows.push([{ text: "➕ Add Admin", callback_data: "addadmin" }]);
  rows.push([{ text: "🔙 Back", callback_data: "back:menu" }]);
  return buildInlineKeyboard(rows);
}

// ============================================================
// Disabled keyboard (used after callback to disable buttons)
// ============================================================

export function disabledKeyboard(text: string): string {
  return buildInlineKeyboard([[{ text, callback_data: "noop" }]]);
}
