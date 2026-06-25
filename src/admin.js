/**
 * src/admin.js
 * Telegram-based admin panel with inline keyboard buttons.
 *
 * Only the configured ADMIN_ID can interact. Everyone else is silently ignored.
 *
 * Per spec (PROMPT 3), the inline menu exposes 8 entries:
 *   ⚙️ Settings       → refresh current settings view
 *   🧠 AI Mode        → combined AI behavior submenu (provider + rewrite intensity)
 *   🌐 Language       → language mode submenu
 *   ✍️ Rewrite Level  → rewrite intensity submenu
 *   🎭 Personality    → personality submenu
 *   📢 Footer         → footer editor (prompt)
 *   🤖 AI Provider    → provider submenu
 *   📊 Stats          → statistics view
 *
 * Commands:
 *   /start            → open the admin panel (main menu)
 *   /footer <text>    → change footer text
 *   /help             → show help
 *
 * Callbacks (button clicks):
 *   menu:main | menu:settings | menu:aimode | menu:language | menu:rewrite |
 *   menu:personality | menu:footer | menu:provider | menu:stats
 *   set:lang:auto|fa|en
 *   set:rw:none|light|normal|summary
 *   set:pers:friendly|professional|technical|news
 *   set:prov:gemini|openrouter
 *   set:aimode:<provider>:<rw>   (combined AI mode shortcut)
 */

import { getSettings, updateSetting, getGlobalStats } from "./kv.js";
import {
  sendMessage,
  editMessageText,
  answerCallbackQuery,
} from "./telegram.js";

// ============================================================
// AUTHORIZATION
// ============================================================
export function isAuthorized(env, userId) {
  const adminId = String(env.ADMIN_ID || "");
  return String(userId) === adminId;
}

// ============================================================
// MENU BUILDERS
// ============================================================

/**
 * Main menu — 8 entries per spec + 1 toggle for channel editing.
 */
function mainMenuKeyboard(settings) {
  const channelEditLabel = settings?.channel_editing_enabled
    ? "📺 Channel Edit: ON ✅"
    : "📺 Channel Edit: OFF";
  return {
    inline_keyboard: [
      [
        { text: "⚙️ Settings", callback_data: "menu:settings" },
        { text: "🧠 AI Mode", callback_data: "menu:aimode" },
      ],
      [
        { text: "🌐 Language", callback_data: "menu:language" },
        { text: "✍️ Rewrite", callback_data: "menu:rewrite" },
      ],
      [
        { text: "🎭 Personality", callback_data: "menu:personality" },
        { text: "📢 Footer", callback_data: "menu:footer" },
      ],
      [
        { text: "🤖 AI Provider", callback_data: "menu:provider" },
        { text: "📊 Stats", callback_data: "menu:stats" },
      ],
      [
        { text: channelEditLabel, callback_data: "toggle:channeledit" },
      ],
    ],
  };
}

function languageKeyboard(current) {
  const mk = (val, label) => ({
    text: `${current === val ? "✅ " : ""}${label}`,
    callback_data: `set:lang:${val}`,
  });
  return {
    inline_keyboard: [
      [mk("auto", "Auto-detect"), mk("fa", "Persian"), mk("en", "English")],
      [{ text: "← Back", callback_data: "menu:main" }],
    ],
  };
}

function rewriteKeyboard(current) {
  const mk = (val, label) => ({
    text: `${current === val ? "✅ " : ""}${label}`,
    callback_data: `set:rw:${val}`,
  });
  return {
    inline_keyboard: [
      [mk("none", "None (format only)"), mk("light", "Light edit")],
      [mk("normal", "Normal edit"), mk("summary", "Summary")],
      [{ text: "← Back", callback_data: "menu:main" }],
    ],
  };
}

function personalityKeyboard(current) {
  const mk = (val, label) => ({
    text: `${current === val ? "✅ " : ""}${label}`,
    callback_data: `set:pers:${val}`,
  });
  return {
    inline_keyboard: [
      [mk("friendly", "Friendly"), mk("professional", "Professional")],
      [mk("technical", "Technical"), mk("news", "News style")],
      [{ text: "← Back", callback_data: "menu:main" }],
    ],
  };
}

function providerKeyboard(current) {
  const mk = (val, label) => ({
    text: `${current === val ? "✅ " : ""}${label}`,
    callback_data: `set:prov:${val}`,
  });
  return {
    inline_keyboard: [
      [mk("gemini", "Google Gemini")],
      [mk("openrouter", "OpenRouter")],
      [{ text: "← Back", callback_data: "menu:main" }],
    ],
  };
}

/**
 * Combined AI Mode submenu — quick presets combining provider + rewrite intensity.
 * Lets the admin pick a behavioral profile in one tap.
 */
function aiModeKeyboard(provider, rewrite) {
  // Each preset: [label, provider, rewrite]
  const presets = [
    ["🚀 Fast & Free",       "gemini",     "light"],
    ["✨ Balanced",          "gemini",     "normal"],
    ["📝 Summarize",         "gemini",     "summary"],
    ["🛡️ No AI (format only)","gemini",    "none"],
    ["🔁 Fallback: OpenRouter","openrouter","normal"],
  ];

  const rows = presets.map(([label, p, r]) => {
    const active = provider === p && rewrite === r;
    return [{ text: `${active ? "✅ " : ""}${label}`, callback_data: `set:aimode:${p}:${r}` }];
  });

  rows.push([{ text: "← Back", callback_data: "menu:main" }]);
  return { inline_keyboard: rows };
}

function backOnlyKeyboard() {
  return { inline_keyboard: [[{ text: "← Back", callback_data: "menu:main" }]] };
}

// ============================================================
// MENU TEXT BUILDERS
// ============================================================

function mainMenuText(settings) {
  return [
    `<b>⚙️ ILIVIR3 AI Admin — Settings</b>`,
    ``,
    `<b>Current configuration:</b>`,
    `🌐 Language: <code>${settings.language_mode}</code>`,
    `✍️ Rewrite: <code>${settings.rewrite_mode}</code>`,
    `🎭 Personality: <code>${settings.personality_mode}</code>`,
    `🤖 AI Provider: <code>${settings.ai_provider}</code>`,
    `📢 Footer: <code>${settings.footer_text}</code>`,
    `📺 Channel Edit: <code>${settings.channel_editing_enabled ? "ON" : "OFF"}</code>`,
    ``,
    `<i>Send any post to this bot to process and publish it.</i>`,
  ].join("\n");
}

function settingsMenuText(settings) {
  // Same as main menu — "Settings" button just refreshes the view
  return mainMenuText(settings);
}

function aiModeMenuText(provider, rewrite) {
  return [
    `<b>🧠 AI Mode</b>`,
    ``,
    `Current provider: <code>${provider}</code>`,
    `Current rewrite:  <code>${rewrite}</code>`,
    ``,
    `<i>Quick presets — pick a behavioral profile:</i>`,
    ``,
    `🚀 <b>Fast &amp; Free</b> — Gemini + light edit`,
    `✨ <b>Balanced</b> — Gemini + normal rewrite`,
    `📝 <b>Summarize</b> — Gemini + summary`,
    `🛡️ <b>No AI</b> — format only, no AI calls`,
    `🔁 <b>Fallback</b> — OpenRouter + normal rewrite`,
  ].join("\n");
}

function languageMenuText(current) {
  return [
    `<b>🌐 Language Mode</b>`,
    ``,
    `Current: <code>${current}</code>`,
    ``,
    `<i>Auto = keep input language</i>`,
    `<i>Persian / English = force output language</i>`,
  ].join("\n");
}

function rewriteMenuText(current) {
  return [
    `<b>✍️ Rewrite Level</b>`,
    ``,
    `Current: <code>${current}</code>`,
    ``,
    `<i>None = format only (no AI)</i>`,
    `<i>Light = slight rewording</i>`,
    `<i>Normal = moderate rewrite</i>`,
    `<i>Summary = shorten long content</i>`,
  ].join("\n");
}

function personalityMenuText(current) {
  return [
    `<b>🎭 Personality Mode</b>`,
    ``,
    `Current: <code>${current}</code>`,
    ``,
    `<i>Friendly / Professional / Technical / News</i>`,
  ].join("\n");
}

function providerMenuText(current) {
  return [
    `<b>🤖 AI Provider</b>`,
    ``,
    `Current: <code>${current}</code>`,
    ``,
    `<i>Gemini = primary (free tier)</i>`,
    `<i>OpenRouter = fallback (also free)</i>`,
    ``,
    `<i>If primary fails, the other is used automatically.</i>`,
  ].join("\n");
}

function footerMenuText(settings) {
  return [
    `<b>📢 Footer Text</b>`,
    ``,
    `Current: <code>${settings.footer_text}</code>`,
    ``,
    `<i>To change: send a new message starting with</i>`,
    `<code>/footer Your new footer text</code>`,
  ].join("\n");
}

async function statsMenuText(SETTINGS, settings) {
  const global = await getGlobalStats(SETTINGS);
  const local = settings.stats || { processed: 0, rewritten: 0, failed: 0 };
  return [
    `<b>📊 Statistics</b>`,
    ``,
    `<b>This admin:</b>`,
    `✅ Processed: <code>${local.processed}</code>`,
    `✍️ Rewritten: <code>${local.rewritten}</code>`,
    `❌ Failed: <code>${local.failed}</code>`,
    ``,
    `<b>Global (all admins):</b>`,
    `✅ Processed: <code>${global.processed}</code>`,
    `✍️ Rewritten: <code>${global.rewritten}</code>`,
    `❌ Failed: <code>${global.failed}</code>`,
  ].join("\n");
}

// ============================================================
// COMMAND: /start
// ============================================================
export async function handleStart(env, SETTINGS, msg) {
  const settings = await getSettings(SETTINGS, msg.from.id);
  await sendMessage(env.BOT_TOKEN, msg.chat.id, mainMenuText(settings), {
    reply_markup: mainMenuKeyboard(settings),
  });
}

// ============================================================
// COMMAND: /footer <text>
// ============================================================
const FOOTER_MAX_LEN = 200; // Telegram caption limit is 1024, but footer should be short

export async function handleFooterCommand(env, SETTINGS, msg, args) {
  if (!args || !args.trim()) {
    const settings = await getSettings(SETTINGS, msg.from.id);
    await sendMessage(env.BOT_TOKEN, msg.chat.id, footerMenuText(settings), {
      reply_markup: backOnlyKeyboard(),
    });
    return;
  }
  const newFooter = args.trim();

  // Validation: footer is MANDATORY per spec (PROMPT 4 rule 8).
  // Reject empty / too-long values to prevent silent footer loss.
  if (newFooter.length === 0) {
    await sendMessage(
      env.BOT_TOKEN,
      msg.chat.id,
      "❌ Footer cannot be empty. The footer is mandatory per the system spec.\n\nTry: `/footer 🌀 @ILIVIR3`",
      { reply_markup: backOnlyKeyboard() }
    );
    return;
  }
  if (newFooter.length > FOOTER_MAX_LEN) {
    await sendMessage(
      env.BOT_TOKEN,
      msg.chat.id,
      `❌ Footer too long (${newFooter.length} chars, max ${FOOTER_MAX_LEN}).`,
      { reply_markup: backOnlyKeyboard() }
    );
    return;
  }

  await updateSetting(SETTINGS, msg.from.id, "footer_text", newFooter);
  await sendMessage(env.BOT_TOKEN, msg.chat.id, `✅ Footer updated to:\n<code>${escapeHtml(newFooter)}</code>`, {
    reply_markup: backOnlyKeyboard(),
  });
}

/** Minimal HTML escaper for user-provided strings shown in <code> tags */
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// CALLBACK QUERY DISPATCHER
// ============================================================
export async function handleCallbackQuery(env, SETTINGS, cq) {
  const chatId = cq.message?.chat?.id;
  const messageId = cq.message?.message_id;
  const data = cq.data || "";
  const userId = cq.from?.id;

  if (!chatId || !messageId) {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, "Error: missing context");
    return;
  }

  const settings = await getSettings(SETTINGS, userId);

  let newText = null;
  let newKb = null;
  let toast = null;

  // ----- Navigation menus -----
  if (data === "menu:main" || data === "menu:settings") {
    newText = settingsMenuText(settings);
    newKb = mainMenuKeyboard(settings);
  } else if (data === "menu:aimode") {
    newText = aiModeMenuText(settings.ai_provider, settings.rewrite_mode);
    newKb = aiModeKeyboard(settings.ai_provider, settings.rewrite_mode);
  } else if (data === "menu:language") {
    newText = languageMenuText(settings.language_mode);
    newKb = languageKeyboard(settings.language_mode);
  } else if (data === "menu:rewrite") {
    newText = rewriteMenuText(settings.rewrite_mode);
    newKb = rewriteKeyboard(settings.rewrite_mode);
  } else if (data === "menu:personality") {
    newText = personalityMenuText(settings.personality_mode);
    newKb = personalityKeyboard(settings.personality_mode);
  } else if (data === "menu:provider") {
    newText = providerMenuText(settings.ai_provider);
    newKb = providerKeyboard(settings.ai_provider);
  } else if (data === "menu:footer") {
    newText = footerMenuText(settings);
    newKb = backOnlyKeyboard();
  } else if (data === "menu:stats") {
    newText = await statsMenuText(SETTINGS, settings);
    newKb = backOnlyKeyboard();
  }
  // ----- Toggle (channel editing on/off) -----
  else if (data === "toggle:channeledit") {
    const newVal = !settings.channel_editing_enabled;
    const updated = await updateSetting(SETTINGS, userId, "channel_editing_enabled", newVal);
    newText = settingsMenuText(updated);
    newKb = mainMenuKeyboard(updated);
    toast = newVal ? "✅ Channel editing ON" : "✅ Channel editing OFF";
  }
  // ----- Setting changes -----
  else if (data.startsWith("set:")) {
    const [, scope, ...rest] = data.split(":");
    const value = rest.join(":");

    if (scope === "lang") {
      const updated = await updateSetting(SETTINGS, userId, "language_mode", value);
      newText = languageMenuText(updated.language_mode);
      newKb = languageKeyboard(updated.language_mode);
      toast = "✅ Language updated";
    } else if (scope === "rw") {
      const updated = await updateSetting(SETTINGS, userId, "rewrite_mode", value);
      newText = rewriteMenuText(updated.rewrite_mode);
      newKb = rewriteKeyboard(updated.rewrite_mode);
      toast = "✅ Rewrite mode updated";
    } else if (scope === "pers") {
      const updated = await updateSetting(SETTINGS, userId, "personality_mode", value);
      newText = personalityMenuText(updated.personality_mode);
      newKb = personalityKeyboard(updated.personality_mode);
      toast = "✅ Personality updated";
    } else if (scope === "prov") {
      const updated = await updateSetting(SETTINGS, userId, "ai_provider", value);
      newText = providerMenuText(updated.ai_provider);
      newKb = providerKeyboard(updated.ai_provider);
      toast = "✅ Provider updated";
    } else if (scope === "aimode") {
      // Combined preset: value = "<provider>:<rewrite>"
      const [prov, rw] = value.split(":");
      let updated = await updateSetting(SETTINGS, userId, "ai_provider", prov);
      updated = await updateSetting(SETTINGS, userId, "rewrite_mode", rw);
      newText = aiModeMenuText(updated.ai_provider, updated.rewrite_mode);
      newKb = aiModeKeyboard(updated.ai_provider, updated.rewrite_mode);
      toast = `✅ AI Mode: ${prov} / ${rw}`;
    } else {
      await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Unknown setting");
      return;
    }
  } else {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Unknown action");
    return;
  }

  // Update the menu message in place (don't send a new one — UX rule: minimal messages).
  // Fallback: if editMessageText fails (e.g. message is older than 48h, or content is
  // unchanged), send a fresh message so the admin still sees the updated menu.
  if (newText && newKb) {
    const editRes = await editMessageText(env.BOT_TOKEN, chatId, messageId, newText, {
      reply_markup: newKb,
    });
    if (!editRes.ok) {
      console.warn(`[admin] editMessageText failed (${editRes.error_code}); falling back to sendMessage`);
      await sendMessage(env.BOT_TOKEN, chatId, newText, { reply_markup: newKb });
    }
  }

  // Always answer the callback query to clear the loading spinner
  await answerCallbackQuery(env.BOT_TOKEN, cq.id, toast);
}
