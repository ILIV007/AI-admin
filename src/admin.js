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
import { getAllProfiles, getProfile } from "../ai/profiles/index.js";

// ============================================================
// AUTHORIZATION
// ============================================================
// v0.6.9: isAuthorized is now async — checks global admin_list in KV
export async function isAuthorized(env, userId, SETTINGS) {
  const adminId = String(env.ADMIN_ID || "");
  const uid = String(userId);
  if (uid === adminId) return true;
  // v0.6.9: Check global admin list in KV (not per-user settings)
  if (SETTINGS) {
    const { isAdminInList } = await import("./kv.js");
    return await isAdminInList(SETTINGS, uid);
  }
  return false;
}

// v0.6.8: Check if user is the OWNER (not just an admin)
export function isOwner(env, userId) {
  return String(userId) === String(env.ADMIN_ID || "");
}

// ============================================================
// MENU BUILDERS
// ============================================================

function mainMenuKeyboard(settings, env) {
  const channelEditLabel = settings?.channel_editing_enabled
    ? "📺 Channel Edit: ON ✅"
    : "📺 Channel Edit: OFF";
  const profileLabel = settings?.active_profile
    ? `👤 Profile: ${getProfile(settings.active_profile)?.name || "?"} ✅`
    : "👤 Profile: None";
  const schedLabel = settings?.scheduling_enabled
    ? "📅 Schedule: ON ✅"
    : "📅 Schedule: OFF";
  const approveLabel = settings?.approve_enabled
    ? "🔐 Approve: ON"
    : "🔓 Approve: OFF";
  
  const keyboard = [
      [
        { text: schedLabel, callback_data: "menu:schedule" },
        { text: profileLabel, callback_data: "menu:profile" },
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
        { text: approveLabel, callback_data: "toggle:approve" },
      ],
    ];

  // v0.6.8: Admin management button — only for owner
  if (env && env.ADMIN_ID) {
    keyboard.push([{ text: "👤 Admins", callback_data: "menu:admins" }]);
  }

  return { inline_keyboard: keyboard };
}

// v0.6.8: Admin management keyboard
function adminsKeyboard(settings) {
  const adminList = settings?.admin_list || [];
  const rows = [];
  
  for (const adminId of adminList) {
    rows.push([{ text: `❌ Remove ${adminId}`, callback_data: `admin:remove:${adminId}` }]);
  }
  
  rows.push([{ text: "➕ Add Admin", callback_data: "admin:add" }]);
  rows.push([{ text: "← Back", callback_data: "menu:main" }]);
  
  return { inline_keyboard: rows };
}

function adminsMenuText(settings, env) {
  const adminList = settings?.admin_list || [];
  const ownerId = env?.ADMIN_ID || "?";
  let text = [
    `<b>👤 Admin Management</b>`,
    ``,
    `<b>👑 Owner:</b> <code>${ownerId}</code>`,
    `<b>Additional Admins:</b> ${adminList.length}`,
    ``,
  ];
  
  if (adminList.length > 0) {
    text.push(`<b>Admin list:</b>`);
    for (let i = 0; i < adminList.length; i++) {
      text.push(`${i + 1}. <code>${adminList[i]}</code>`);
    }
  } else {
    text.push(`<i>No additional admins. Only the owner can use the bot.</i>`);
  }
  
  text.push(``);
  text.push(`<i>Tap "➕ Add Admin" and send the user's Telegram ID.</i>`);
  text.push(`<i>To get an ID: forward a message to @userinfobot</i>`);
  
  return text.join("\n");
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
      [mk("0", "0% (Format only)"), mk("20", "20% (Minimal)")],
      [mk("40", "40% (Light)"), mk("60", "60% (Normal) ⭐")],
      [mk("80", "80% (Strong)"), mk("100", "100% (Maximum)")],
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
      [mk("0", "0% (None 🚫)"), mk("20", "20% (Minimal ⭐)")],
      [mk("50", "50% (Moderate 😎)"), mk("100", "100% (Heavy 🤩)")],
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

function profileKeyboard(currentProfile) {
  const profiles = getAllProfiles();
  const rows = profiles.map((p) => [
    { text: `${currentProfile === p.key ? "✅ " : ""}${p.name}`, callback_data: `set:profile:${p.key}` },
  ]);
  if (currentProfile) {
    rows.push([{ text: "❌ Deactivate Profile", callback_data: "set:profile:none" }]);
  }
  rows.push([{ text: "← Back", callback_data: "menu:main" }]);
  return { inline_keyboard: rows };
}

function profileMenuText(currentProfile) {
  const activeProfile = currentProfile ? getProfile(currentProfile) : null;
  let text = [`<b>👤 Profile</b>`, ``, `Current: <code>${activeProfile ? activeProfile.name : "None (individual settings)"}</code>`, ``];
  if (activeProfile) {
    text.push(`<b>Active: ${activeProfile.name}</b>`);
    text.push(`<i>${activeProfile.description}</i>`);
    text.push(``);
    text.push(`<i>When active, Soul + Style + Rules replace individual settings.</i>`);
  } else {
    text.push(`<b>Available profiles:</b>`);
    for (const p of getAllProfiles()) {
      text.push(`• <b>${p.name}</b> — ${p.description}`);
    }
  }
  return text.join("\n");
}

function scheduleKeyboard(s) {
  const enabled = s?.scheduling_enabled;
  const delay = s?.schedule_delay_hours ?? 24;
  const interval = s?.schedule_interval_minutes ?? 30;
  const ppd = s?.schedule_posts_per_day ?? 0;
  return {
    inline_keyboard: [
      [{ text: enabled ? "🟢 Stop Scheduling" : "🔴 Start Scheduling", callback_data: "set:sched:toggle" }],
      [
        { text: "⏱ Delay", callback_data: "ignore" },
        { text: "−", callback_data: "set:sched:delay:dec" },
        { text: `${delay}h`, callback_data: "ignore" },
        { text: "+", callback_data: "set:sched:delay:inc" },
      ],
      [
        { text: "📏 Spacing", callback_data: "ignore" },
        { text: "−", callback_data: "set:sched:interval:dec" },
        { text: `${interval}m`, callback_data: "ignore" },
        { text: "+", callback_data: "set:sched:interval:inc" },
      ],
      [
        { text: "📊 Posts/day", callback_data: "ignore" },
        { text: "−", callback_data: "set:sched:posts:dec" },
        { text: `${ppd > 0 ? ppd : "∞"}`, callback_data: "ignore" },
        { text: "+", callback_data: "set:sched:posts:inc" },
      ],
      [{ text: "← Back", callback_data: "menu:main" }],
    ],
  };
}

function scheduleMenuText(s) {
  const enabled = s?.scheduling_enabled;
  const delay = s?.schedule_delay_hours ?? 24;
  const interval = s?.schedule_interval_minutes ?? 30;
  const ppd = s?.schedule_posts_per_day ?? 0;
  const ppdText = ppd > 0 ? `${ppd} (auto-spacing: ${Math.floor(1440/ppd)}m)` : "∞ (manual spacing)";
  return [
    `<b>📅 Schedule Manager</b>`,
    ``,
    `Status: <b>${enabled ? "🟢 ON" : "🔴 OFF"}</b>`,
    `Delay: <b>${delay} hours</b>`,
    `Spacing: <b>${interval} minutes</b>`,
    `Posts/day: <b>${ppdText}</b>`,
    ``,
    `<i>How it works:</i>`,
    `• Posts are delayed by ${delay}h`,
    `• Multiple posts are spaced by ${ppd > 0 ? Math.floor(1440/ppd) : interval}m`,
    `• You still receive immediate feedback`,
    `• Channel edits are NOT scheduled`,
  ].join("\n");
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
    `🎨 Intensity: <code>${settings.edit_intensity ?? 60}%</code>`,
    `😀 Emoji: <code>${settings.emoji_level ?? 20}%</code>`,
    `🎭 Personality: <code>${settings.personality_mode}</code>`,
    `🤖 AI Provider: <code>${settings.ai_provider}</code>`,
    `📢 Footer: <code>${settings.footer_text}</code>`,
    `📺 Channel Edit: <code>${settings.channel_editing_enabled ? "ON" : "OFF"}</code>`,
    `🔐 Approve: <code>${settings.approve_enabled ? "ON" : "OFF"}</code>`,
    ``,
    `<i>Send any post to this bot to process and publish it.</i>`,
  ].join("\n");
}

function intensityMenuText(current) {
  return [
    `<b>🎨 Edit Intensity</b>`,
    ``,
    `Current: <code>${current ?? 60}%</code>`,
    ``,
    `<i>Controls how much the bot changes + formats each post:</i>`,
    `<b>0%</b> = format only (no AI rewrite, just links + footer quoted)`,
    `<b>20%</b> = minimal (links + footer quoted, NO paragraph quoting)`,
    `<b>40%</b> = light rewrite + quote long paragraphs`,
    `<b>60%</b> = NORMAL ⭐ — quote paragraphs + bold key terms + moderate rewrite`,
    `<b>80%</b> = strong rewrite + heavy formatting`,
    `<b>100%</b> = maximum — full rewrite + heavy quoting + bold + emoji`,
  ].join("\n");
}

function emojiMenuText(current) {
  return [
    `<b>😀 Emoji Level</b>`,
    ``,
    `Current: <code>${current ?? 20}%</code>`,
    ``,
    `<i>Controls how many emojis the AI adds to posts:</i>`,
    `<b>0%</b> = no emojis at all`,
    `<b>20%</b> = MINIMAL ⭐ — 1-3 emojis for polish (default)`,
    `<b>50%</b> = moderate — 3-5 emojis`,
    `<b>100%</b> = heavy — lots of emojis`,
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
// v0.6.2: COMMAND: /start — Full bot introduction (ALL users, not just admins)
// ============================================================
const INTRO_TEXT = [
  `🤖 <b>AI Admin — Intelligent Content Processing Bot</b>`,
  ``,
  `A powerful bot for processing, editing, and intelligently publishing posts in Telegram channels. Built on Cloudflare Workers — 100% free and serverless.`,
  ``,
  `✨ <b>Features:</b>`,
  `<blockquote>`,
  `• AI-powered content editing (Gemini + OpenRouter)`,
  `• AI prompt detection & protection (Midjourney, Stable Diffusion)`,
  `• Smart scheduling with cron fallback`,
  `• Approve mode — review before publishing`,
  `• RTL support for Persian/Arabic text`,
  `• Media group (album) support`,
  `• Collapsible quotes for long prompts`,
  `• Debug dashboard at /debug`,
  `</blockquote>`,
  ``,
  `🌀 <b>Creator Channel:</b> @ILIVIR3`,
  ``,
  `Send /menu for admin settings.`,
  `Send any post to process and publish it.`,
].join("\n");

export async function handleStart(env, SETTINGS, msg) {
  await sendMessage(env.BOT_TOKEN, msg.chat.id, INTRO_TEXT, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ============================================================
// v0.6.2: COMMAND: /menu — Admin settings panel (admin only)
// (Previously /start — renamed in v0.6.2 to split intro from admin panel)
// ============================================================
export async function handleMenu(env, SETTINGS, msg) {
  const settings = await getSettings(SETTINGS, msg.from.id);
  await sendMessage(env.BOT_TOKEN, msg.chat.id, mainMenuText(settings), {
    parse_mode: "HTML",
    reply_markup: mainMenuKeyboard(settings, env),
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
      parse_mode: "HTML",
      reply_markup: backOnlyKeyboard(),
    });
    return;
  }
  const newFooter = args.trim();
  if (newFooter.length === 0) {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, "❌ Footer cannot be empty.", {
      parse_mode: "HTML",
      reply_markup: backOnlyKeyboard(),
    });
    return;
  }
  if (newFooter.length > FOOTER_MAX_LEN) {
    await sendMessage(env.BOT_TOKEN, msg.chat.id, `❌ Footer too long (${newFooter.length} chars, max ${FOOTER_MAX_LEN}).`, {
      parse_mode: "HTML",
      reply_markup: backOnlyKeyboard(),
    });
    return;
  }
  await updateSetting(SETTINGS, msg.from.id, "footer_text", newFooter);
  await sendMessage(env.BOT_TOKEN, msg.chat.id, `✅ Footer updated to:\n<code>${escapeHtml(newFooter)}</code>`, {
    parse_mode: "HTML",
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
  if (data === "menu:main") {
    newText = mainMenuText(settings);
    newKb = mainMenuKeyboard(settings, env);
  } else if (data === "menu:schedule") {
    newText = scheduleMenuText(settings);
    newKb = scheduleKeyboard(settings);
  } else if (data === "menu:profile") {
    newText = profileMenuText(settings.active_profile);
    newKb = profileKeyboard(settings.active_profile);
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
  // v0.6.8: Admin management
  else if (data === "menu:admins") {
    newText = adminsMenuText(settings, env);
    newKb = adminsKeyboard(settings);
  }
  else if (data === "admin:add") {
    // Prompt for admin ID — set a flag in KV
    await SETTINGS.put(`admin:adding:${userId}`, "1", { expirationTtl: 300 });
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, "");
    await sendMessage(env.BOT_TOKEN, chatId,
      `➕ <b>Add Admin</b>\n\nSend the Telegram user ID of the person you want to add as admin.\n\n<i>To get an ID: forward a message to @userinfobot</i>`,
      { parse_mode: "HTML", disable_web_page_preview: true });
    return;
  }
  else if (data.startsWith("admin:remove:")) {
    const removeId = data.split(":")[2];
    const currentList = settings.admin_list || [];
    const newList = currentList.filter(id => String(id) !== String(removeId));
    const updated = await updateSetting(SETTINGS, userId, "admin_list", newList);
    newText = adminsMenuText(updated, env);
    newKb = adminsKeyboard(updated);
    toast = `✅ Admin ${removeId} removed`;
  }
  // ----- Toggle channel editing -----
  else if (data === "toggle:channeledit") {
    const newVal = !settings.channel_editing_enabled;
    const updated = await updateSetting(SETTINGS, userId, "channel_editing_enabled", newVal);
    newText = mainMenuText(updated);
    newKb = mainMenuKeyboard(updated, env);
    toast = newVal ? "✅ Channel editing ON" : "✅ Channel editing OFF";
  }
  // v0.6.8: Approve toggle
  else if (data === "toggle:approve") {
    const newVal = !settings.approve_enabled;
    const updated = await updateSetting(SETTINGS, userId, "approve_enabled", newVal);
    newText = mainMenuText(updated);
    newKb = mainMenuKeyboard(updated, env);
    toast = newVal ? "✅ Approve mode ON" : "✅ Approve mode OFF";
  }
  // v0.6.8: Approve post callback
  else if (data.startsWith("approve:publish:")) {
    const parts = data.split(":");
    const targetChatId = parts[2];
    const previewMsgId = parts[3];
    const storageKey = `approve:${previewMsgId}`;
    const storedRaw = await SETTINGS.get(storageKey);
    if (!storedRaw) {
      await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Post data expired. Please resend.");
      return;
    }
    let postData;
    try { postData = JSON.parse(storedRaw); } catch { await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Invalid post data"); return; }
    const { publishToChannel } = await import("./telegram.js");
    const pubRes = await publishToChannel(env.BOT_TOKEN, postData.targetChannel, {
      text: postData.text, mediaType: postData.mediaType, mediaFileId: postData.mediaFileId,
      extra: { parse_mode: postData.parseMode, disable_web_page_preview: false },
    });
    if (pubRes.ok) {
      if (postData.extraParts && postData.extraParts.length > 0) {
        const firstMsgId = pubRes.result?.message_id;
        for (let i = 0; i < postData.extraParts.length; i++) {
          const isLast = i === postData.extraParts.length - 1;
          const partFooter = isLast ? (postData.footerHtml || "") : "";
          await publishToChannel(env.BOT_TOKEN, postData.targetChannel, {
            text: postData.extraParts[i] + partFooter, mediaType: null, mediaFileId: null,
            extra: { parse_mode: postData.parseMode, reply_to_message_id: firstMsgId },
          }).catch(() => {});
          if (!isLast) await new Promise((r) => setTimeout(r, 500));
        }
      }
      await answerCallbackQuery(env.BOT_TOKEN, cq.id, "✅ Published to channel!");
      await sendMessage(env.BOT_TOKEN, targetChatId,
        `✅ <b>Published to channel!</b>\n📍 <code>${postData.targetChannel}</code>`,
        { parse_mode: "HTML" }).catch(() => {});
    } else {
      await answerCallbackQuery(env.BOT_TOKEN, cq.id, `❌ Failed: ${pubRes.description}`);
    }
    await SETTINGS.delete(storageKey);
    return;
  }
  else if (data.startsWith("approve:reject:")) {
    const parts = data.split(":");
    const targetChatId = parts[2];
    const previewMsgId = parts[3];
    await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Post rejected");
    await sendMessage(env.BOT_TOKEN, targetChatId,
      `❌ <b>Post rejected</b>`, { parse_mode: "HTML" }).catch(() => {});
    await SETTINGS.delete(`approve:${previewMsgId}`);
    return;
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
    } else if (scope === "profile") {
      if (value === "none") {
        await updateSetting(SETTINGS, userId, "active_profile", null);
        newText = profileMenuText(null);
        newKb = profileKeyboard(null);
        toast = "✅ Profile deactivated";
      } else {
        const profile = getProfile(value);
        if (profile) {
          await updateSetting(SETTINGS, userId, "active_profile", value);
          newText = profileMenuText(value);
          newKb = profileKeyboard(value);
          toast = `✅ Profile: ${profile.name}`;
        } else {
          await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Unknown profile");
          return;
        }
      }
    } else if (scope === "sched") {
      // v0.5.1: Scheduling controls
      if (value === "toggle") {
        const updated = await updateSetting(SETTINGS, userId, "scheduling_enabled", !settings.scheduling_enabled);
        newText = scheduleMenuText(updated);
        newKb = scheduleKeyboard(updated);
        toast = updated.scheduling_enabled ? "✅ Scheduling ON" : "✅ Scheduling OFF";
      } else if (value === "delay:inc") {
        const newDelay = Math.min(168, (settings.schedule_delay_hours ?? 24) + 1);
        const updated = await updateSetting(SETTINGS, userId, "schedule_delay_hours", newDelay);
        newText = scheduleMenuText(updated);
        newKb = scheduleKeyboard(updated);
        toast = `✅ Delay: ${newDelay}h`;
      } else if (value === "delay:dec") {
        const newDelay = Math.max(0, (settings.schedule_delay_hours ?? 24) - 1);
        const updated = await updateSetting(SETTINGS, userId, "schedule_delay_hours", newDelay);
        newText = scheduleMenuText(updated);
        newKb = scheduleKeyboard(updated);
        toast = `✅ Delay: ${newDelay}h`;
      } else if (value === "interval:inc") {
        const newInt = Math.min(360, (settings.schedule_interval_minutes ?? 30) + 5);
        const updated = await updateSetting(SETTINGS, userId, "schedule_interval_minutes", newInt);
        newText = scheduleMenuText(updated);
        newKb = scheduleKeyboard(updated);
        toast = `✅ Spacing: ${newInt}m`;
      } else if (value === "interval:dec") {
        const newInt = Math.max(5, (settings.schedule_interval_minutes ?? 30) - 5);
        const updated = await updateSetting(SETTINGS, userId, "schedule_interval_minutes", newInt);
        newText = scheduleMenuText(updated);
        newKb = scheduleKeyboard(updated);
        toast = `✅ Spacing: ${newInt}m`;
      } else if (value === "posts:inc") {
        const newVal = Math.min(50, (settings.schedule_posts_per_day ?? 0) + 1);
        const updated = await updateSetting(SETTINGS, userId, "schedule_posts_per_day", newVal);
        newText = scheduleMenuText(updated);
        newKb = scheduleKeyboard(updated);
        toast = `✅ Posts/day: ${newVal > 0 ? newVal : "∞"}`;
      } else if (value === "posts:dec") {
        const newVal = Math.max(0, (settings.schedule_posts_per_day ?? 0) - 1);
        const updated = await updateSetting(SETTINGS, userId, "schedule_posts_per_day", newVal);
        newText = scheduleMenuText(updated);
        newKb = scheduleKeyboard(updated);
        toast = `✅ Posts/day: ${newVal > 0 ? newVal : "∞"}`;
      } else {
        await answerCallbackQuery(env.BOT_TOKEN, cq.id, "❌ Unknown schedule action");
        return;
      }
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
      parse_mode: "HTML",
      reply_markup: newKb,
    });
    if (!editRes.ok) {
      await sendMessage(env.BOT_TOKEN, chatId, newText, { parse_mode: "HTML", reply_markup: newKb });
    }
  }

  await answerCallbackQuery(env.BOT_TOKEN, cq.id, toast);
}
