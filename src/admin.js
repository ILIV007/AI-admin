/**
 * src/admin.js
 * Telegram-based admin panel with inline keyboard buttons.
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
        { text: "🎨 Intensity", callback_data: "menu:intensity" },
      ],
      [
        { text: "📢 Footer", callback_data: "menu:footer" },
        { text: "😀 Emoji Level", callback_data: "menu:emoji" },
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
      [mk("normal", "Normal edit"), mk("deep", "Deep edit")],
      [mk("summary", "Summary")],
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

function intensityKeyboard(current) {
  const mk = (val, label) => ({
    text: `${current === val ? "✅ " : ""}${label}`,
    callback_data: `set:intensity:${val}`,
  });
  return {
    inline_keyboard: [
      [mk("20", "20% (Minimal)"), mk("40", "40% (Light)")],
      [mk("50", "50% (Normal)"), mk("70", "70% (Strong)")],
      [mk("100", "100% (Maximum)"), mk("0", "0% (Format only)")],
      [{ text: "← Back", callback_data: "menu:main" }],
    ],
  };
}

function emojiKeyboard(current) {
  const mk = (val, label) => ({
    text: `${current === val ? "✅ " : ""}${label}`,
    callback_data: `set:emoji:${val}`,
  });
  return {
    inline_keyboard: [
      [mk("0", "None 🚫"), mk("1", "Minimal 🙂")],
      [mk("2", "Moderate 😎"), mk("3", "Heavy 🤩")],
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

function backOnlyKeyboard() {
  return { inline_keyboard: [[{ text: "← Back", callback_data: "menu:main" }]] };
}

// ============================================================
// MENU TEXT BUILDERS
// ============================================================

function mainMenuText(settings) {
  return [
    `<b>⚙️ AI Admin — Settings</b>`,
    ``,
    `<b>Current configuration:</b>`,
    `🌐 Language: <code>${settings.language_mode}</code>`,
    `✍️ Rewrite: <code>${settings.rewrite_mode}</code>`,
    `🎨 Intensity: <code>${settings.edit_intensity ?? 50}%</code>`,
    `😀 Emoji: <code>${["None", "Minimal", "Moderate", "Heavy"][settings.emoji_level ?? 2]}</code>`,
    `🎭 Personality: <code>${settings.personality_mode}</code>`,
    `🤖 AI Provider: <code>${settings.ai_provider}</code>`,
    `📢 Footer: <code>${settings.footer_text}</code>`,
    `📺 Channel Edit: <code>${settings.channel_editing_enabled ? "ON" : "OFF"}</code>`,
    ``,
    `<i>Send any post to this bot to process and publish it.</i>`,
  ].join("\n");
}

function intensityMenuText(current) {
  return [
    `<b>🎨 Edit Intensity</b>`,
    ``,
    `Current: <code>${current ?? 50}%</code>`,
    ``,
    `<i>Controls how much the bot changes each post:</i>`,
    `<b>0%</b> = format only (no rewrite, just links + footer)`,
    `<b>20%</b> = minimal (only quote links/footer)`,
    `<b>40%</b> = light rewrite`,
    `<b>50%</b> = normal balanced rewrite`,
    `<b>70%</b> = strong rewrite with more formatting`,
    `<b>100%</b> = maximum rewrite + heavy emoji + full markdown`,
  ].join("\n");
}

function emojiMenuText(current) {
  const labels = ["None", "Minimal", "Moderate", "Heavy"];
  return [
    `<b>😀 Emoji Level</b>`,
    ``,
    `Current: <code>${labels[current ?? 2]}</code>`,
    ``,
    `<i>Controls how many emojis are added to posts:</i>`,
    `<b>None</b> = no emojis at all`,
    `<b>Minimal</b> = 1-2 emojis max`,
    `<b>Moderate</b> = 3-5 emojis, natural placement`,
    `<b>Heavy</b> = lots of emojis for visual impact`,
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
    `<i>Light = minimal changes (~10-15%)</i>`,
    `<i>Normal = moderate rewrite (~20-30%)</i>`,
    `<i>Deep = significant rewrite (~30-50%)</i>`,
    `<i>Summary = condense long content</i>`,
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
const FOOTER_MAX_LEN = 200;

export async function handleFooterCommand(env, SETTINGS, msg, args) {
  if (!args || !args.trim()) {
    const settings = await getSettings(SETTINGS, msg.from.id);
    await sendMessage(env.BOT_TOKEN, msg.chat.id, footerMenuText(settings), {
      reply_markup: backOnlyKeyboard(),
    });
    return;
  }
  const newFooter = args.trim();
  if (newFooter.length === 0) {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, "❌ Footer cannot be empty.", {
      reply_markup: backOnlyKeyboard(),
    });
    return;
  }
  if (newFooter.length > FOOTER_MAX_LEN) {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, `❌ Footer too long (${newFooter.length} chars, max ${FOOTER_MAX_LEN}).`, {
      reply_markup: backOnlyKeyboard(),
    });
    return;
  }
  await updateSetting(SETTINGS, msg.from.id, "footer_text", newFooter);
  await sendMessage(env.BOT_TOKEN, msg.chat.id, `✅ Footer updated to:\n<code>${escapeHtml(newFooter)}</code>`, {
    reply_markup: backOnlyKeyboard(),
  });
}

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
    newText = mainMenuText(settings);
    newKb = mainMenuKeyboard(settings);
  } else if (data === "menu:intensity") {
    newText = intensityMenuText(settings.edit_intensity);
    newKb = intensityKeyboard(settings.edit_intensity);
  } else if (data === "menu:emoji") {
    newText = emojiMenuText(settings.emoji_level);
    newKb = emojiKeyboard(settings.emoji_level);
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
  // ----- Toggle channel editing -----
  else if (data === "toggle:channeledit") {
    const newVal = !settings.channel_editing_enabled;
    const updated = await updateSetting(SETTINGS, userId, "channel_editing_enabled", newVal);
    newText = mainMenuText(updated);
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
    } else if (scope === "intensity") {
      const updated = await updateSetting(SETTINGS, userId, "edit_intensity", parseInt(value));
      newText = intensityMenuText(updated.edit_intensity);
      newKb = intensityKeyboard(updated.edit_intensity);
      toast = `✅ Intensity: ${value}%`;
    } else if (scope === "emoji") {
      const updated = await updateSetting(SETTINGS, userId, "emoji_level", parseInt(value));
      newText = emojiMenuText(updated.emoji_level);
      newKb = emojiKeyboard(updated.emoji_level);
      toast = `✅ Emoji: ${["None", "Minimal", "Moderate", "Heavy"][updated.emoji_level]}`;
    } else if (scope === "prov") {
      const updated = await updateSetting(SETTINGS, userId, "ai_provider", value);
      newText = providerMenuText(updated.ai_provider);
      newKb = providerKeyboard(updated.ai_provider);
      toast = "✅ Provider updated";
    } else {
      await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Unknown setting");
      return;
    }
  } else {
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Unknown action");
    return;
  }

  // Update the menu message in place
  if (newText && newKb) {
    const editRes = await editMessageText(env.BOT_TOKEN, chatId, messageId, newText, {
      reply_markup: newKb,
    });
    if (!editRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, newText, { reply_markup: newKb });
    }
  }

  await answerCallbackQuery(env.BOT_TOKEN, cq.id, toast);
}
