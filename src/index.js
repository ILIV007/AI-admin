/**
 * src/index.js
 * AI Admin — Cloudflare Worker entry point (v0.2.1)
 *
 * Features:
 *   - Pipeline with 55s timeout + AbortController
 *   - Parallel AI providers (Gemini + OpenRouter race)
 *   - Media group buffering (per-item KV keys, leader election)
 *   - Reply chain context
 *   - Debug dashboard at /debug
 *   - Raw request logging
 */

import {
  extractContent,
  publishToChannel,
  verifyScheduled,
  checkSchedulingPermissions,
  sendMessage,
  answerCallbackQuery,
  getMe,
  editMessageText,
  editMessageCaption,
  sendChatAction,
  sendMediaGroup,
} from "./telegram.js";
import {
  getSettings,
  bumpStats,
  bumpGlobalStats,
  saveMediaGroupItem,
  listMediaGroupItems,
  deleteMediaGroup,
  getLastScheduledTime,
  setLastScheduledTime,
  enqueueScheduled,
  listDueScheduled,
  deleteScheduledItem,
} from "./kv.js";
import { classify } from "./classifier.js";
import { cleanContent, detectLanguage } from "./cleaner.js";
import { formatPost } from "./formatter.js";
import { aiRewrite, aiSummarize } from "./ai.js";
import { isAuthorized, handleStart, handleFooterCommand, handleCallbackQuery } from "./admin.js";
import {
  checkDebugAuth,
  getStatus,
  sendTestMessage,
  testKV,
  testAI,
  clearDebugLogs,
  logUpdate,
  logError,
  logRawRequest,
  debugHTML,
} from "./debug.js";

const VERSION = "0.2.1";

// ============================================================
// MAIN EXPORT
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // GET / : health check
    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, name: "AI Admin", version: VERSION, time: new Date().toISOString() });
    }

    // /debug/* routes
    if (url.pathname === "/debug" || url.pathname.startsWith("/debug/")) {
      return handleDebugRoute(request, url, env);
    }

    // GET /webhook/info
    if (request.method === "GET" && url.pathname === "/webhook/info") {
      const me = await getMe(env.BOT_TOKEN);
      return json({ ok: me.ok, bot: me.result });
    }

    // POST /webhook
    if (request.method === "POST" && url.pathname === "/webhook") {
      const SETTINGS = env.SETTINGS;
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      const hasSecretCheck = !!env.WEBHOOK_SECRET;
      const secretMatches = !hasSecretCheck || secret === env.WEBHOOK_SECRET;

      let update = null;
      let bodyParseError = null;
      let bodySize = 0;
      try {
        const text = await request.text();
        bodySize = text.length;
        update = JSON.parse(text);
      } catch (e) {
        bodyParseError = e.message;
      }

      const updateInfo = extractUpdateInfoForLog(update);

      if (hasSecretCheck && !secretMatches) {
        console.warn(`[webhook] 403 — secret mismatch`);
        ctx.waitUntil(logRawRequest(SETTINGS, {
          method: request.method, path: url.pathname,
          hasSecret: !!secret, secretMatch: false, bodySize,
          updateType: updateInfo.updateType, fromId: updateInfo.fromId,
          chatId: updateInfo.chatId, textPreview: updateInfo.textPreview,
          status: "rejected_403",
          detail: `Expected ${env.WEBHOOK_SECRET.slice(0, 3)}…, got ${secret ? secret.slice(0, 3) + "…" : "(missing)"}`,
        }));
        return new Response("Forbidden", { status: 403 });
      }

      if (!update) {
        console.warn("[webhook] 400 — invalid JSON");
        ctx.waitUntil(logRawRequest(SETTINGS, {
          method: request.method, path: url.pathname,
          hasSecret: !!secret, secretMatch: secretMatches, bodySize,
          updateType: "invalid_json", fromId: null, chatId: null,
          textPreview: bodyParseError, status: "rejected_400",
          detail: "Invalid JSON",
        }));
        return new Response("Bad Request", { status: 400 });
      }

      console.log(`[webhook] 200 — type=${updateInfo.updateType} from=${updateInfo.fromId}`);

      ctx.waitUntil((async () => {
        await logRawRequest(SETTINGS, {
          method: request.method, path: url.pathname,
          hasSecret: !!secret, secretMatch: secretMatches, bodySize,
          updateType: updateInfo.updateType, fromId: updateInfo.fromId,
          chatId: updateInfo.chatId, textPreview: updateInfo.textPreview,
          status: "ok", detail: "processed",
        });
        await handleUpdate(update, env);
      })());
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },

  // v0.5.7: CRON HANDLER — sends scheduled messages stored in KV
  // Telegram's `schedule_date` is unreliable for bots, so we use our own queue.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledQueue(env));
  },
};

// ============================================================
// DEBUG ROUTE HANDLER
// ============================================================
function handleDebugRoute(request, url, env) {
  const SETTINGS = env.SETTINGS;
  const auth = checkDebugAuth(request, env);
  if (!auth.ok) return new Response("Forbidden", { status: 403 });

  if (request.method === "GET" && url.pathname === "/debug") {
    return new Response(debugHTML(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  if (request.method === "GET" && url.pathname === "/debug/api/ping") {
    return json({
      ok: true, time: new Date().toISOString(),
      has_bot_token: !!env.BOT_TOKEN, has_admin_id: !!env.ADMIN_ID,
      has_kv: !!SETTINGS, has_webhook_secret: !!env.WEBHOOK_SECRET,
    });
  }

  if (request.method === "GET" && url.pathname === "/debug/api/status") {
    return getStatus(env, SETTINGS).then(
      (data) => json(data),
      (e) => json({ ok: false, error: e.message }, 500)
    );
  }

  if (request.method === "POST" && url.pathname === "/debug/api/test/message") {
    return sendTestMessage(env).then((d) => json(d), (e) => json({ ok: false, error: e.message }, 500));
  }
  if (request.method === "POST" && url.pathname === "/debug/api/test/kv") {
    return testKV(SETTINGS).then((d) => json(d), (e) => json({ ok: false, error: e.message }, 500));
  }
  if (request.method === "POST" && url.pathname === "/debug/api/test/ai") {
    return testAI(env).then((d) => json(d), (e) => json({ ok: false, error: e.message }, 500));
  }
  if (request.method === "POST" && url.pathname === "/debug/api/clear") {
    return clearDebugLogs(SETTINGS).then(() => json({ ok: true }), (e) => json({ ok: false, error: e.message }, 500));
  }

  return new Response("Not Found", { status: 404 });
}

// ============================================================
// v0.5.7: SCHEDULED QUEUE PROCESSOR (called by cron trigger every minute)
// ============================================================
async function processScheduledQueue(env) {
  const SETTINGS = env.SETTINGS;
  if (!SETTINGS) {
    console.error("[cron] SETTINGS KV not bound");
    return;
  }

  console.log(`[cron] Checking for due scheduled messages at ${new Date().toISOString()}`);
  const due = await listDueScheduled(SETTINGS);
  console.log(`[cron] Found ${due.length} due messages`);

  for (const item of due) {
    try {
      console.log(`[cron] Sending scheduled message ${item.id} to ${item.chatId} (was scheduled for ${new Date(item.scheduledTime).toISOString()})`);

      let res;

      // v0.5.7: Handle media groups (stored as mediaGroupItems array)
      if (item.mediaGroupItems && item.mediaGroupItems.length > 0) {
        res = await sendMediaGroup(env.BOT_TOKEN, item.chatId, item.mediaGroupItems, {
          parse_mode: item.parseMode,
        });
      } else {
        // Regular message (text or single media)
        res = await publishToChannel(env.BOT_TOKEN, item.chatId, {
          text: item.text,
          mediaType: item.mediaType,
          mediaFileId: item.mediaFileId,
          extra: { parse_mode: item.parseMode, disable_web_page_preview: false },
        });
      }

      if (res.ok) {
        console.log(`[cron] ✓ Sent message ${item.id}`);
        await deleteScheduledItem(SETTINGS, item._kvKey);

        // Notify admin
        if (item.notifyChatId) {
          await sendMessage(env.BOT_TOKEN, item.notifyChatId,
            `✅ <b>Scheduled post published</b>\n📅 Was scheduled for: ${new Date(item.scheduledTime).toLocaleString('en-US', { timeZone: 'UTC', hour12: false })} UTC\n📍 Channel: <code>${item.chatId}</code>`,
            { disable_web_page_preview: true }).catch(() => {});
        }
      } else {
        console.error(`[cron] ✗ Failed to send message ${item.id}: ${res.description}`);
        // If it's a permanent error, delete to avoid retries
        const permanentErrors = ["chat not found", "bot was blocked by the user", "CHAT_ADMIN_REQUIRED", "bad request: chat not found"];
        const isPermanent = permanentErrors.some((e) => (res.description || "").toLowerCase().includes(e.toLowerCase()));
        if (isPermanent) {
          console.error(`[cron] Permanent error — deleting message ${item.id} from queue`);
          await deleteScheduledItem(SETTINGS, item._kvKey);
          if (item.notifyChatId) {
            await sendMessage(env.BOT_TOKEN, item.notifyChatId,
              `❌ <b>Scheduled post failed permanently</b>\n📅 Was scheduled for: ${new Date(item.scheduledTime).toLocaleString('en-US', { timeZone: 'UTC', hour12: false })} UTC\n❌ <code>${(res.description || "").slice(0, 200)}</code>`,
              { disable_web_page_preview: true }).catch(() => {});
          }
        } else {
          console.warn(`[cron] Temporary error — will retry on next cron run`);
        }
      }
    } catch (e) {
      console.error(`[cron] Exception processing message ${item.id}:`, e.message);
    }
  }
}

// ============================================================
// UPDATE INFO EXTRACTOR (for raw logging)
// ============================================================
function extractUpdateInfoForLog(update) {
  if (!update) return { updateType: "invalid", fromId: null, chatId: null, textPreview: "" };
  if (update.callback_query) {
    return { updateType: "callback_query", fromId: update.callback_query.from?.id, chatId: update.callback_query.message?.chat?.id, textPreview: update.callback_query.data || "" };
  }
  if (update.message) {
    return { updateType: "message", fromId: update.message.from?.id, chatId: update.message.chat?.id, textPreview: update.message.text || update.message.caption || "" };
  }
  if (update.channel_post) {
    return { updateType: "channel_post", fromId: update.channel_post.from?.id || update.channel_post.sender_chat?.id, chatId: update.channel_post.chat?.id, textPreview: update.channel_post.text || update.channel_post.caption || "" };
  }
  return { updateType: "other", fromId: null, chatId: null, textPreview: "" };
}

// ============================================================
// UPDATE HANDLER
// ============================================================
async function handleUpdate(update, env) {
  const SETTINGS = env.SETTINGS;
  const startTime = Date.now();

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      if (!isAuthorized(env, cq.from.id)) {
        await answerCallbackQuery(env.BOT_TOKEN, cq.id, "⛔ Unauthorized");
        await logUpdate(SETTINGS, update, "unauthorized", `from=${cq.from.id}`);
        return;
      }
      await handleCallbackQuery(env, SETTINGS, cq);
      await logUpdate(SETTINGS, update, "ok", `callback: ${cq.data}`);
      return;
    }

    const content = extractContent(update);
    if (!content) return;

    // Media group handling
    if (content.mediaGroupId) {
      console.log(`[update] media group: ${content.mediaGroupId}`);
      await handleMediaGroupUpdate(env, content, update);
      return;
    }

    if (content.chatType === "private") {
      await handlePrivateMessage(env, content, update);
      return;
    }

    if (content.chatType === "channel" || content.chatType === "supergroup" || content.chatType === "group") {
      const settings = await getSettings(SETTINGS, content.fromId || env.ADMIN_ID);
      if (!settings.channel_editing_enabled) {
        await logUpdate(SETTINGS, update, "ignored", "channel editing OFF");
        return;
      }
      const botId = await getBotId(env);
      if (botId && content.fromId === botId) {
        await logUpdate(SETTINGS, update, "ignored", "self-post");
        return;
      }
      await runChannelEditPipeline(env, content, update);
      return;
    }
  } catch (e) {
    console.error("[update] error:", e.message, e.stack);
    await logError(SETTINGS, e, "handleUpdate");
    await logUpdate(SETTINGS, update, "error", e.message);
  }
}

// ============================================================
// PRIVATE MESSAGE HANDLER
// ============================================================
async function handlePrivateMessage(env, content, update) {
  const SETTINGS = env.SETTINGS;

  if (!env.ADMIN_ID) {
    await sendMessage(env.BOT_TOKEN, content.chatId,
      `⚠️ <b>Configuration Error</b>\n\n<code>ADMIN_ID</code> is not set.\n\nYour Telegram ID: <code>${content.fromId}</code>`);
    await logUpdate(SETTINGS, update, "error", "ADMIN_ID not set");
    return;
  }

  if (!isAuthorized(env, content.fromId)) {
    await sendMessage(env.BOT_TOKEN, content.chatId,
      `⛔ <b>Unauthorized</b>\n\nYour ID: <code>${content.fromId}</code>\nConfigured ADMIN_ID: <code>${env.ADMIN_ID}</code>`);
    await logUpdate(SETTINGS, update, "unauthorized", `from=${content.fromId} expected=${env.ADMIN_ID}`);
    return;
  }

  const text = content.text || "";

  // Typing indicator immediately
  if (content.chatId) {
    await sendChatAction(env.BOT_TOKEN, content.chatId, "typing").catch(() => {});
  }

  if (/^\/start\b/i.test(text)) {
    await handleStart(env, SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } });
    await logUpdate(SETTINGS, update, "ok", "/start");
    return;
  }

  if (/^\/footer\b/i.test(text)) {
    const args = text.replace(/^\/footer\s*/i, "");
    await handleFooterCommand(env, SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } }, args);
    await logUpdate(SETTINGS, update, "ok", "/footer");
    return;
  }

  if (/^\/help\b/i.test(text)) {
    await sendMessage(env.BOT_TOKEN, content.chatId,
      `<b>AI Admin — Help</b>\n\nSend me any post and I will process and publish it.\n\nCommands:\n/start — Admin panel\n/footer &lt;text&gt; — Change footer\n/checkperms — Check bot permissions in channel\n/help — This message`);
    await logUpdate(SETTINGS, update, "ok", "/help");
    return;
  }

  // v0.5.8: /checkperms — check if bot has permission to schedule messages
  if (/^\/checkperms\b/i.test(text)) {
    const targetChannel = env.TARGET_CHANNEL;
    if (!targetChannel) {
      await sendMessage(env.BOT_TOKEN, content.chatId,
        `❌ <code>TARGET_CHANNEL</code> is not configured.`);
      await logUpdate(SETTINGS, update, "ok", "/checkperms: no channel");
      return;
    }

    await sendChatAction(env.BOT_TOKEN, content.chatId, "typing").catch(() => {});
    const botId = await getBotId(env);
    const permCheck = await checkSchedulingPermissions(env.BOT_TOKEN, targetChannel, botId);

    let message;
    if (permCheck.ok) {
      message = [
        `✅ <b>Permissions OK</b>`,
        ``,
        `📍 <b>Channel:</b> <code>${targetChannel}</code>`,
        `👤 <b>Bot status:</b> <code>${permCheck.status}</code>`,
        `📮 <b>Can post messages:</b> <code>${permCheck.canPostMessages ? "YES ✅" : "NO ❌"}</code>`,
        ``,
        `<b>Scheduling should work correctly.</b>`,
        ``,
        `<i>Scheduled posts will appear in the channel's "Scheduled Messages" view (clock icon).</i>`,
      ].join("\n");
    } else {
      const perms = permCheck.rawPermissions
        ? Object.entries(permCheck.rawPermissions).map(([k, v]) => `  ${k}: ${v ? "✅" : "❌"}`).join("\n")
        : "(no details)";
      message = [
        `❌ <b>Permission Issue</b>`,
        ``,
        `📍 <b>Channel:</b> <code>${targetChannel}</code>`,
        `👤 <b>Bot status:</b> <code>${permCheck.status || "unknown"}</code>`,
        ``,
        `<b>Error:</b>`,
        `<code>${permCheck.error}</code>`,
        ``,
        `<b>Current permissions:</b>`,
        `<code>${perms}</code>`,
        ``,
        `<b>How to fix:</b>`,
        `1. Open the channel in Telegram`,
        `2. Go to <b>Channel Settings → Administrators</b>`,
        `3. Find the bot and tap it`,
        `4. Enable <b>"Post Messages"</b> permission`,
        `5. Run /checkperms again to verify`,
      ].join("\n");
    }

    await sendMessage(env.BOT_TOKEN, content.chatId, message, { disable_web_page_preview: true });
    await logUpdate(SETTINGS, update, "ok", `/checkperms: ${permCheck.ok ? "OK" : "FAIL"}`);
    return;
  }

  // Content pipeline
  await runPipeline(env, content, content.chatId, update);
}

// ============================================================
// MEDIA GROUP HANDLER (per-item keys + leader election)
// ============================================================
const MEDIA_GROUP_WAIT_MS = 2500;

async function handleMediaGroupUpdate(env, content, update) {
  const SETTINGS = env.SETTINGS;
  const mgId = content.mediaGroupId;

  const myItem = {
    fileId: content.mediaFileId,
    type: content.mediaType === "video" ? "video" : "photo",
    caption: content.text || "",
    chatId: content.chatId,
    fromId: content.fromId,
    chatType: content.chatType,
    messageId: content.messageId,
    replyToMessage: content.replyToMessage,
  };

  await saveMediaGroupItem(SETTINGS, mgId, content.messageId, myItem);
  console.log(`[media-group] saved item ${content.messageId} for ${mgId}`);

  await new Promise((r) => setTimeout(r, MEDIA_GROUP_WAIT_MS));

  const fullGroup = await listMediaGroupItems(SETTINGS, mgId);
  console.log(`[media-group] ${mgId} has ${fullGroup.length} items`);

  if (fullGroup.length === 0) return;

  // Leader election: smallest messageId processes
  const leader = fullGroup[0];
  if (leader.messageId !== content.messageId) {
    console.log(`[media-group] deferring to leader ${leader.messageId}`);
    return;
  }

  console.log(`[media-group] LEADER processing ${fullGroup.length} items`);
  try {
    await runMediaGroupPipeline(env, fullGroup, update);
  } catch (e) {
    console.error(`[media-group] error: ${e.message}`);
    await logError(SETTINGS, e, `media group ${mgId}`);
  }

  await deleteMediaGroup(SETTINGS, mgId);
}

// ============================================================
// MEDIA GROUP PIPELINE
// ============================================================
async function runMediaGroupPipeline(env, items, update) {
  const SETTINGS = env.SETTINGS;
  const adminId = items[0].fromId || env.ADMIN_ID;
  const startTime = Date.now();

  // Combine captions from all items.
  // Only add "[Photo N]:" numbering when MULTIPLE items have captions.
  // If only one item has a caption (even in a multi-photo album), use it directly
  // without numbering — this avoids the bug where "[Photo 1:]" appeared on single-caption albums.
  const itemsWithCaptions = items.filter((it) => it.caption && it.caption.trim());
  const useNumbering = itemsWithCaptions.length > 1;

  const combinedText = items
    .map((it, i) => {
      if (!it.caption || !it.caption.trim()) return "";
      return useNumbering ? `[Photo ${i + 1}]: ${it.caption}` : it.caption;
    })
    .filter(Boolean)
    .join("\n\n");

  console.log(`[mg-pipeline] ${items.length} items, ${combinedText.length} chars`);

  let settings;
  try {
    settings = await getSettings(SETTINGS, adminId);
  } catch (e) {
    console.error("[mg-pipeline] getSettings failed:", e.message);
    return;
  }

  const feedbackChatId = items[0].chatType === "private" ? items[0].chatId : null;

  let processingMsgId = null;
  if (feedbackChatId) {
    const procRes = await sendMessage(env.BOT_TOKEN, feedbackChatId,
      `⏳ <b>Processing album</b> (${items.length} photos)`,
      { disable_web_page_preview: true }).catch(() => ({ ok: false }));
    if (procRes.ok) processingMsgId = procRes.result?.message_id;
    await sendChatAction(env.BOT_TOKEN, feedbackChatId, "typing").catch(() => {});
  }

  const effectiveLang = settings.language_mode === "auto" ? "auto" : settings.language_mode;
  const cleanedText = cleanContent(combinedText);

  let finalText = cleanedText;
  let wasRewritten = false;
  let aiProvider = "none";
  let aiError = null;

  const effectiveRewriteMode = settings.rewrite_mode || "normal";
  // v0.5.0: Media group caption limit is 1024 — force summary if text is too long
  const MG_CAPTION_LIMIT = 800; // leave room for footer + HTML tags
  let shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;
  
  // Force summary for media groups if text exceeds caption limit
  if (cleanedText.length > MG_CAPTION_LIMIT) {
    shouldRewrite = true;
    console.log(`[mg-pipeline] AUTO SUMMARY FORCED (input ${cleanedText.length} > ${MG_CAPTION_LIMIT} [MEDIA])`);
  }

  if (shouldRewrite) {
    try {
      const mode = cleanedText.length > MG_CAPTION_LIMIT ? "summary" : effectiveRewriteMode;
      const res = await aiRewrite(env, settings, cleanedText, mode, effectiveLang, settings.personality_mode || "friendly", settings.edit_intensity ?? 60, settings.emoji_level ?? 20);
      if (res.ok && res.text) {
        finalText = res.text;
        wasRewritten = true;
        aiProvider = res.provider;
        console.log(`[mg-pipeline] AI OK (${res.provider})`);
      } else {
        aiError = res.error;
        console.warn(`[mg-pipeline] AI failed: ${res.error}`);
      }
    } catch (e) {
      aiError = e.message;
      console.error(`[mg-pipeline] AI exception: ${e.message}`);
    }
  }

  const { text: formattedBody, parseMode } = formatPost(finalText, {
    footer: null, engineName: "html", intensity: settings.edit_intensity ?? 60, emojiLevel: settings.emoji_level ?? 20,
  });

  // v0.5.0: Safe truncation for media groups (caption limit = 1024, we use 900 for safety)
  const MG_LIMIT = 900;
  const footerHtml = settings.footer_text ? `\n\n<blockquote>${settings.footer_text}</blockquote>` : "";
  const maxBodyLen = MG_LIMIT - footerHtml.length - 50;
  let safeBody = formattedBody;
  if (formattedBody.length > maxBodyLen) {
    let cutPoint = maxBodyLen - 30;
    const lastGT = formattedBody.lastIndexOf(">", cutPoint);
    const lastLT = formattedBody.lastIndexOf("<", cutPoint);
    if (lastLT > lastGT) cutPoint = lastLT - 1;
    const lastNL = formattedBody.lastIndexOf("\n", cutPoint);
    if (lastNL > cutPoint - 200) cutPoint = lastNL;
    safeBody = formattedBody.slice(0, cutPoint);
    // Close unclosed tags
    for (const tag of ["blockquote", "a", "b", "i", "code", "pre"]) {
      const open = tag === "a" ? (safeBody.match(/<a\s/g) || []).length : (safeBody.match(new RegExp(`<${tag}>`, "g")) || []).length;
      const close = (safeBody.match(new RegExp(`</${tag}>`, "g")) || []).length;
      if (open > close) safeBody += `</${tag}>`.repeat(open - close);
    }
    safeBody += "\n\n<i>…(truncated)</i>";
  }
  const formattedText = safeBody + footerHtml;

  const mediaItems = items.map((it, i) => ({
    type: it.type, fileId: it.fileId,
    caption: i === 0 ? formattedText : undefined,
  }));

  const targetChannel = env.TARGET_CHANNEL;
  let publishOk = false;
  let wasScheduled = false;
  let scheduledTime = null;
  let scheduleError = null;

  if (feedbackChatId) {
    await sendMediaGroup(env.BOT_TOKEN, feedbackChatId, mediaItems, { parse_mode: parseMode });
  }

  if (targetChannel) {
    if (settings.scheduling_enabled) {
      try {
        // v0.5.8: Check bot permissions FIRST
        const botId = await getBotId(env);
        const permCheck = await checkSchedulingPermissions(env.BOT_TOKEN, targetChannel, botId);
        if (!permCheck.ok) {
          console.error(`[mg-pipeline] Scheduling blocked — permissions: ${permCheck.error}`);
          scheduleError = permCheck.error;
          publishOk = false;
        } else {
          let effectiveInterval = settings.schedule_interval_minutes ?? 30;
          if (settings.schedule_posts_per_day > 0) {
            effectiveInterval = Math.floor(1440 / settings.schedule_posts_per_day);
            if (effectiveInterval < 5) effectiveInterval = 5;
          }

          const lastScheduled = await getLastScheduledTime(SETTINGS, targetChannel);
          const baseTime = Date.now() + (settings.schedule_delay_hours * 3600 * 1000);
          const minNext = lastScheduled ? lastScheduled + (effectiveInterval * 60 * 1000) : 0;
          scheduledTime = Math.max(baseTime, minNext);

          // v0.5.8: Telegram requires schedule_date between 60s and 7 days from now
          const now = Date.now();
          const MIN_SCHEDULE_MS = 90 * 1000;
          const MAX_SCHEDULE_MS = 7 * 24 * 3600 * 1000;

          if (scheduledTime - now < MIN_SCHEDULE_MS) {
            scheduledTime = now + MIN_SCHEDULE_MS;
          }
          if (scheduledTime - now > MAX_SCHEDULE_MS) {
            scheduledTime = now + MAX_SCHEDULE_MS;
          }

          const scheduleDateUnix = Math.floor(scheduledTime / 1000);
          console.log(`[mg-pipeline] Native scheduling: scheduled=${new Date(scheduledTime).toISOString()}, ts=${scheduleDateUnix}`);

          await setLastScheduledTime(SETTINGS, targetChannel, scheduledTime);

          const schedRes = await sendMediaGroup(env.BOT_TOKEN, targetChannel, mediaItems, {
            parse_mode: parseMode,
            schedule_date: scheduleDateUnix,
          });

          // v0.5.8: VERIFY that Telegram actually scheduled the message
          const verification = verifyScheduled(schedRes, scheduleDateUnix);
          publishOk = schedRes.ok && verification.scheduled;

          if (!publishOk) {
            scheduleError = verification.description || schedRes.description || "unknown scheduling failure";
            console.error(`[mg-pipeline] Scheduling FAILED: ${scheduleError}`);
            console.error(`[mg-pipeline] Telegram response:`, JSON.stringify(schedRes).slice(0, 500));
          } else {
            wasScheduled = true;
            console.log(`[mg-pipeline] Scheduling VERIFIED — album will appear at ${new Date(scheduledTime).toISOString()}`);
          }
        }

        // v0.5.8: Show result message to user
        if (feedbackChatId && processingMsgId) {
          if (wasScheduled) {
            await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
              [
                `📅 <b>Album Scheduled!</b>`,
                `📅 <b>Scheduled for:</b> ${new Date(scheduledTime).toLocaleString('en-US', { timeZone: 'UTC', hour12: false })} UTC`,
                `📸 <b>Items:</b> ${items.length}`,
                ``,
                `<b>📋 To review/edit/delete:</b>`,
                `1. Open the channel <code>${targetChannel}</code>`,
                `2. Tap the channel name at the top`,
                `3. Select <b>"Scheduled Messages"</b> (clock icon 🕐)`,
                ``,
                `<i>The album will auto-publish at the scheduled time.</i>`,
              ].join("\n"),
              { disable_web_page_preview: true }).catch(() => {});
          } else {
            await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
              [
                `⚠️ <b>Scheduling FAILED</b>`,
                `❌ <b>Error:</b> <code>${(scheduleError || "").slice(0, 250)}</code>`,
                ``,
                `<b>How to fix:</b>`,
                `• Run <code>/checkperms</code> to verify bot permissions`,
                `• Bot needs <b>"Post Messages"</b> permission in the channel`,
                `• Schedule must be between 90s and 7 days from now`,
                ``,
                `<i>Your album was NOT published. Fix the issue and resend.</i>`,
              ].join("\n"),
              { disable_web_page_preview: true }).catch(() => {});
          }
        }
      } catch (e) {
        console.error(`[mg-pipeline] Scheduling exception: ${e.message}`);
        scheduleError = e.message;
        publishOk = false;
        if (feedbackChatId && processingMsgId) {
          await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
            `⚠️ <b>Scheduling exception</b>\n❌ <code>${e.message.slice(0, 200)}</code>`,
            { disable_web_page_preview: true }).catch(() => {});
        }
      }
    } else {
      const pubRes = await sendMediaGroup(env.BOT_TOKEN, targetChannel, mediaItems, { parse_mode: parseMode });
      publishOk = pubRes.ok;
      console.log(`[mg-pipeline] publish: ${publishOk ? "OK" : pubRes.description}`);
    }
  } else {
    publishOk = true;
  }

  if (publishOk) {
    await bumpStats(SETTINGS, adminId, "processed");
    await bumpGlobalStats(SETTINGS, "processed");
    if (wasRewritten) {
      await bumpStats(SETTINGS, adminId, "rewritten");
      await bumpGlobalStats(SETTINGS, "rewritten");
    }
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
  }

  if (feedbackChatId && processingMsgId) {
    // v0.5.6: Don't overwrite the "Album Scheduled!" message if scheduling succeeded.
    // Only show the "published" message if scheduling was NOT used (or failed and we fell back).
    const totalMs = Date.now() - startTime;
    const statusLine = aiError
      ? `⚠️ AI failed — format-only fallback`
      : `✅ AI: ${wasRewritten ? `yes (${aiProvider})` : "no"}`;

    // Only show this generic "published" message if scheduling was OFF
    // (when scheduling is ON, the more specific "Scheduled!" or "Scheduling FAILED" message
    // was already shown above and we shouldn't overwrite it).
    if (!settings.scheduling_enabled) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        `✅ <b>Album published</b> (${items.length} photos) → <code>${targetChannel || "(none)"}</code>\n${statusLine} · ${totalMs}ms`,
        { disable_web_page_preview: true }).catch(() => {});
    }
  }

  if (update) await logUpdate(SETTINGS, update, publishOk ? "ok" : "error", `media-group: ${items.length} items, AI: ${wasRewritten ? "yes" : "no"}`);
}

// ============================================================
// CONTENT PIPELINE (with 55s timeout + AbortController)
// ============================================================
const PIPELINE_TIMEOUT_MS = 90_000; // 90s — generous; Cloudflare Workers can run up to 5min on paid, ~30s-2min on free with ctx.waitUntil

async function runPipeline(env, content, feedbackChatId = null, update = null) {
  const SETTINGS = env.SETTINGS;
  const adminId = content.fromId || env.ADMIN_ID;
  const startTime = Date.now();
  let processingMsgId = null;
  let pipelineError = null;
  let pipelineResult = null;

  const trace = [];
  const traceStep = (step, ok, detail = "") => {
    const entry = { step, ok: !!ok, detail: detail.slice(0, 200), ms: Date.now() - startTime };
    trace.push(entry);
    console.log(`[trace] ${step}: ${ok ? "✓" : "✗"}${detail ? " " + detail.slice(0, 80) : ""} (${entry.ms}ms)`);
  };

  console.log(`[pipeline] start — from=${adminId}`);

  let settings;
  try {
    settings = await getSettings(SETTINGS, adminId);
    traceStep("getSettings", true, `provider=${settings.ai_provider} rw=${settings.rewrite_mode}`);
  } catch (e) {
    console.error("[pipeline] getSettings failed:", e.message);
    traceStep("getSettings", false, e.message);
    await logError(SETTINGS, e, "getSettings");
    if (feedbackChatId) {
      await sendMessage(env.BOT_TOKEN, feedbackChatId, `❌ <b>KV Error:</b> <code>${e.message}</code>`);
    }
    if (update) await logUpdate(SETTINGS, update, "error", `getSettings: ${e.message}`);
    return;
  }

  const rawText = content.text || "";
  if (!rawText && !content.mediaFileId) {
    if (update) await logUpdate(SETTINGS, update, "ignored", "empty");
    return;
  }

  // Processing message
  if (feedbackChatId) {
    const procRes = await sendMessage(env.BOT_TOKEN, feedbackChatId,
      [
        `⏳ <b>Processing your post</b>`,
        ``,
        `<blockquote>🔄 Analyzing...</blockquote>`,
        `<blockquote>🧹 Cleaning...</blockquote>`,
        `<blockquote>✍️ AI rewrite...</blockquote>`,
        `<blockquote>📝 Publishing...</blockquote>`,
      ].join("\n"),
      { disable_web_page_preview: true }
    ).catch(() => ({ ok: false }));
    if (procRes.ok) processingMsgId = procRes.result?.message_id;
    await sendChatAction(env.BOT_TOKEN, feedbackChatId, "typing").catch(() => {});
  }

  // Inner pipeline with timeout
  const abortCtrl = new AbortController();
  const innerPromise = runPipelineInner(env, content, settings, rawText, feedbackChatId, processingMsgId, trace, traceStep, startTime);
  const timeoutPromise = new Promise((_, reject) => {
    const t = setTimeout(() => {
      abortCtrl.abort();
      reject(new Error(`PIPELINE_TIMEOUT after ${PIPELINE_TIMEOUT_MS}ms`));
    }, PIPELINE_TIMEOUT_MS);
    innerPromise.finally(() => clearTimeout(t));
  });

  try {
    pipelineResult = await Promise.race([innerPromise, timeoutPromise]);
  } catch (e) {
    pipelineError = e;
    console.error(`[pipeline] ${e.message}`);
    traceStep("aborted", false, e.message);
    await logError(SETTINGS, e, "pipeline timeout");

    if (feedbackChatId && processingMsgId) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        [
          `⏱️ <b>Pipeline timed out</b>`,
          ``,
          `<blockquote>Took longer than ${PIPELINE_TIMEOUT_MS / 1000}s.</blockquote>`,
          ``,
          `<i>Try a faster model or set rewrite to "none".</i>`,
        ].join("\n"),
        { disable_web_page_preview: true }).catch(() => {});
    }
  }

  const traceSummary = trace.map(t => `${t.step}:${t.ok ? "✓" : "✗"}`).join(" → ");
  console.log(`[pipeline] ${traceSummary}`);
  if (update) {
    const status = pipelineError ? "error" : (pipelineResult?.ok ? "ok" : "error");
    const detail = pipelineError ? `aborted: ${pipelineError.message}` : pipelineResult?.detail || traceSummary;
    await logUpdate(SETTINGS, update, status, detail);
  }
}

// ============================================================
// INNER PIPELINE
// ============================================================
async function runPipelineInner(env, content, settings, rawText, feedbackChatId, processingMsgId, trace, traceStep, startTime) {
  const SETTINGS = env.SETTINGS;
  const adminId = content.fromId || env.ADMIN_ID;

  // When settings.language_mode is "auto", pass "auto" to AI (NOT detected lang).
  // The prompt interprets "auto" as "keep input language exactly".
  // Passing "fa" or "en" would make some models translate, which is wrong.
  const detectedLang = detectLanguage(rawText);
  const effectiveLang = settings.language_mode === "auto" ? "auto" : settings.language_mode;
  console.log(`[pipeline] lang=${effectiveLang} (settings=${settings.language_mode}, detected=${detectedLang})`);

  // Reply context
  let replyContext = "";
  if (content.replyToMessage) {
    const orig = content.replyToMessage;
    const origText = orig.text || orig.caption || "";
    if (origText) {
      replyContext = `[Original message being replied to]\n${origText}\n\n[Reply message]\n`;
      traceStep("reply_context", true, `${origText.length} chars`);
    }
  }

  // Classify (rule-based only)
  let decision;
  try {
    const cls = await classify(env, settings, rawText);
    decision = cls.decision;
    traceStep("classify", true, `type=${decision.content_type} mode=${decision.rewrite_mode}`);
  } catch (e) {
    traceStep("classify", false, e.message);
    decision = { content_type: "other", rewrite_mode: "light", needs_rewrite: true, language_mode: effectiveLang };
  }

  // Clean
  const cleanedText = cleanContent(rawText);
  const textForAI = replyContext + cleanedText;
  traceStep("clean", true, `${rawText.length}→${cleanedText.length} chars`);

  // AI rewrite
  let finalText = cleanedText;
  let wasRewritten = false;
  let aiProvider = "none";
  let aiError = null;

  // v0.4.7: SEPARATION OF CONCERNS — intensity controls ONLY UI, NOT AI rewrite
  // rewrite_mode controls AI. intensity is completely independent.
  const effectiveRewriteMode = decision.rewrite_mode || settings.rewrite_mode || "normal";
  const intensity = settings.edit_intensity ?? 60;
  const emojiLevel = settings.emoji_level ?? 20;

  // v0.5.8.1: Better long-post handling
  // Telegram limits: text messages = 4096 chars, captions = 1024 chars
  // We summarize when text exceeds a threshold to prevent truncation
  const hasMedia = !!content.mediaFileId;
  const TELEGRAM_TEXT_LIMIT = 4000;
  const TELEGRAM_CAPTION_LIMIT = 900;
  const effectiveLimit = hasMedia ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;

  // v0.5.8.1: Lower threshold to trigger summary EARLIER (80% of limit)
  const SUMMARY_TRIGGER = hasMedia ? 700 : 3000;
  let finalMode = effectiveRewriteMode;
  if (cleanedText.length > SUMMARY_TRIGGER) {
    finalMode = "summary";
    console.log(`[pipeline] AUTO SUMMARY FORCED (input ${cleanedText.length} > ${SUMMARY_TRIGGER}${hasMedia ? " [MEDIA]" : ""}, limit=${effectiveLimit})`);
  }
  const shouldRewrite = finalMode !== "none" && cleanedText.length > 0;
  console.log(`[pipeline] rewrite: mode=${finalMode} (settings: ${effectiveRewriteMode}) intensity=${intensity}% should=${shouldRewrite} (input ${cleanedText.length} chars, trigger=${SUMMARY_TRIGGER})`);

  if (shouldRewrite && decision.needs_rewrite !== false) {
    try {
      if (finalMode === "summary") {
        // v0.5.8.1: Pass target character limit to AI so output fits within Telegram's limit
        // Leave room for footer (50 chars) + HTML tags overhead (100 chars)
        const targetCharLimit = effectiveLimit - 150;
        const res = await aiSummarize(env, settings, textForAI, effectiveLang, targetCharLimit);
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          aiProvider = res.provider;
          traceStep("ai_summarize", true, `provider=${res.provider} ${res.text.length}chars (target=${targetCharLimit})`);
        } else {
          aiError = res.error;
          traceStep("ai_summarize", false, res.error || "unknown");
        }
      } else {
        const res = await aiRewrite(env, settings, textForAI, finalMode, effectiveLang, settings.personality_mode || "friendly", settings.edit_intensity ?? 60, settings.emoji_level ?? 20);
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          aiProvider = res.provider;
          traceStep("ai_rewrite", true, `provider=${res.provider} mode=${finalMode}`);
        } else {
          aiError = res.error;
          traceStep("ai_rewrite", false, res.error || "unknown");
        }
      }
    } catch (e) {
      aiError = e.message;
      traceStep("ai_exception", false, e.message);
    }
  } else {
    traceStep("ai_skip", true, `mode=${finalMode}`);
  }

  // Format WITHOUT footer first, then truncate, then add footer.
  // This ensures the footer is NEVER lost even when the text is truncated.
  // (intensity and emojiLevel already declared above)

  // Step 1: Format the body text (no footer yet)
  const { text: formattedBody, parseMode } = formatPost(finalText, {
    footer: null, // No footer yet — we add it after truncation
    engineName: "html",
    intensity,
    emojiLevel,
  });
  traceStep("format_body", true, `${formattedBody.length} chars`);

  // Step 2: Calculate available space for body (leave room for footer)
  // (effectiveLimit, hasMedia already declared above)

  // Footer format: \n\n<blockquote>FOOTER</blockquote>
  const footerHtml = settings.footer_text
    ? `\n\n<blockquote>${settings.footer_text}</blockquote>`
    : "";
  const footerLen = footerHtml.length;
  const maxBodyLen = effectiveLimit - footerLen - 50; // 50 chars safety margin

  // Step 3: Truncate body if needed (BEFORE adding footer)
  // v0.5.8.1: Better truncation — try to cut at paragraph or sentence boundary
  let safeBody = formattedBody;
  if (formattedBody.length > maxBodyLen) {
    console.warn(`[pipeline] body too long (${formattedBody.length} > ${maxBodyLen}), truncating at paragraph boundary`);
    let cutPoint = maxBodyLen - 30;
    // Try to find a paragraph break (double newline)
    const lastPara = formattedBody.lastIndexOf("\n\n", cutPoint);
    if (lastPara > cutPoint - 500) cutPoint = lastPara;
    else {
      // Try sentence boundary (English + Persian)
      const lastSentence = Math.max(
        formattedBody.lastIndexOf(". ", cutPoint),
        formattedBody.lastIndexOf("! ", cutPoint),
        formattedBody.lastIndexOf("? ", cutPoint),
        formattedBody.lastIndexOf("۔ ", cutPoint), // Persian full stop
      );
      if (lastSentence > cutPoint - 300) cutPoint = lastSentence + 1;
    }
    // Avoid cutting inside an HTML tag
    const lastGT = formattedBody.lastIndexOf(">", cutPoint);
    const lastLT = formattedBody.lastIndexOf("<", cutPoint);
    if (lastLT > lastGT) cutPoint = lastLT - 1;
    if (cutPoint < 100) cutPoint = maxBodyLen - 30; // fallback
    safeBody = formattedBody.slice(0, cutPoint);
    // Close unclosed HTML tags
    for (const tag of ["blockquote", "a", "b", "i", "code", "pre"]) {
      const open = tag === "a" ? (safeBody.match(/<a\s/g) || []).length : (safeBody.match(new RegExp(`<${tag}>`, "g")) || []).length;
      const close = (safeBody.match(new RegExp(`</${tag}>`, "g")) || []).length;
      if (open > close) safeBody += `</${tag}>`.repeat(open - close);
    }
    safeBody += "\n\n<i>…</i>";
    traceStep("truncate_body", true, `${formattedBody.length}→${safeBody.length} chars`);
  }

  // Step 4: Append footer (guaranteed to fit now)
  const safeFormattedText = safeBody + footerHtml;
  traceStep("format_final", true, `${safeFormattedText.length} chars (body=${safeBody.length} + footer=${footerLen})`);

  // Publish
  const targetChannel = env.TARGET_CHANNEL;
  if (!targetChannel) {
    traceStep("publish", false, "TARGET_CHANNEL not set");
    if (feedbackChatId) await sendMessage(env.BOT_TOKEN, feedbackChatId, "❌ <code>TARGET_CHANNEL</code> not configured.");
    return { ok: false, detail: "TARGET_CHANNEL not set" };
  }

  // Send to user
  if (feedbackChatId) {
    const userRes = await publishToChannel(env.BOT_TOKEN, feedbackChatId, {
      text: safeFormattedText, mediaType: content.mediaType, mediaFileId: content.mediaFileId,
      extra: { parse_mode: parseMode, disable_web_page_preview: false },
    });
    traceStep("send_to_user", userRes.ok, userRes.ok ? "ok" : userRes.description);
    if (!userRes.ok) {
      console.warn(`[pipeline] send to user failed: ${userRes.description}`);
    }
  }

  // v0.5.8.1: HYBRID SCHEDULING
  // Primary: native Telegram schedule_date (posts appear in scheduled view for review)
  // Fallback: if native fails (Telegram silently sends immediately), KV cron queue sends at scheduled time
  let publishRes;
  let scheduledTime = null;
  let wasScheduled = false;
  let scheduleError = null;
  let usedFallback = false;

  if (settings.scheduling_enabled) {
    try {
      // Step 1: Check bot permissions FIRST
      const botId = await getBotId(env);
      const permCheck = await checkSchedulingPermissions(env.BOT_TOKEN, targetChannel, botId);
      if (!permCheck.ok) {
        console.error(`[pipeline] Scheduling blocked — permissions: ${permCheck.error}`);
        scheduleError = permCheck.error;
        publishRes = { ok: false, scheduled: false, scheduleError };
      } else {
        // Step 2: Calculate scheduled time
        let effectiveInterval = settings.schedule_interval_minutes ?? 30;
        if (settings.schedule_posts_per_day > 0) {
          effectiveInterval = Math.floor(1440 / settings.schedule_posts_per_day);
          if (effectiveInterval < 5) effectiveInterval = 5;
        }

        const lastScheduled = await getLastScheduledTime(SETTINGS, targetChannel);
        const baseTime = Date.now() + (settings.schedule_delay_hours * 3600 * 1000);
        const minNext = lastScheduled ? lastScheduled + (effectiveInterval * 60 * 1000) : 0;
        scheduledTime = Math.max(baseTime, minNext);

        // Telegram: schedule_date must be 60s to 7 days from now
        const now = Date.now();
        const MIN_SCHEDULE_MS = 90 * 1000;
        const MAX_SCHEDULE_MS = 7 * 24 * 3600 * 1000;
        if (scheduledTime - now < MIN_SCHEDULE_MS) {
          console.log(`[pipeline] Scheduled time too soon, bumping to 90s`);
          scheduledTime = now + MIN_SCHEDULE_MS;
        }
        if (scheduledTime - now > MAX_SCHEDULE_MS) {
          console.log(`[pipeline] Scheduled time too far, capping to 7 days`);
          scheduledTime = now + MAX_SCHEDULE_MS;
        }

        const scheduleDateUnix = Math.floor(scheduledTime / 1000);
        console.log(`[pipeline] Native scheduling: ${new Date(scheduledTime).toISOString()}`);
        await setLastScheduledTime(SETTINGS, targetChannel, scheduledTime);

        // Step 3: Try native Telegram scheduling
        publishRes = await publishToChannel(env.BOT_TOKEN, targetChannel, {
          text: safeFormattedText, mediaType: content.mediaType, mediaFileId: content.mediaFileId,
          extra: { parse_mode: parseMode, disable_web_page_preview: false, schedule_date: scheduleDateUnix },
        });

        // Step 4: Verify Telegram actually scheduled it
        const verification = verifyScheduled(publishRes, scheduleDateUnix);
        if (publishRes.ok && verification.scheduled) {
          wasScheduled = true;
          console.log(`[pipeline] ✓ Native scheduling VERIFIED`);
        } else {
          // v0.5.8.1: Native scheduling failed — FALL BACK to KV cron queue
          // (instead of just showing error, we queue the message for cron to send at scheduled time)
          const nativeError = verification.description || publishRes.description || "unknown";
          console.warn(`[pipeline] Native scheduling failed (${nativeError}), falling back to KV cron queue`);
          usedFallback = true;

          const schedId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          await enqueueScheduled(SETTINGS, {
            id: schedId,
            scheduledTime,
            chatId: targetChannel,
            text: safeFormattedText,
            mediaType: content.mediaType,
            mediaFileId: content.mediaFileId,
            parseMode,
            adminId,
            notifyChatId: feedbackChatId,
            createdAt: Date.now(),
          });
          publishRes = { ok: true, scheduled: true };
          wasScheduled = true;
          traceStep("enqueue_fallback", true, `id=${schedId}`);
        }
      }
    } catch (e) {
      console.error(`[pipeline] Scheduling exception: ${e.message}`);
      scheduleError = e.message;
      publishRes = { ok: false, scheduled: false, scheduleError };
    }
  } else {
    publishRes = await publishToChannel(env.BOT_TOKEN, targetChannel, {
      text: safeFormattedText, mediaType: content.mediaType, mediaFileId: content.mediaFileId,
      extra: { parse_mode: parseMode, disable_web_page_preview: false },
    });
  }
  traceStep("publish_to_channel", publishRes.ok, publishRes.ok ? (wasScheduled ? "scheduled" : "ok") : (publishRes.scheduleError || publishRes.description));

  if (publishRes.ok) {
    await bumpStats(SETTINGS, adminId, "processed");
    await bumpGlobalStats(SETTINGS, "processed");
    if (wasRewritten) {
      await bumpStats(SETTINGS, adminId, "rewritten");
      await bumpGlobalStats(SETTINGS, "rewritten");
    }

    const totalMs = Date.now() - startTime;
    const statusLine = aiError
      ? `⚠️ AI failed — format-only fallback\n   <i>Error:</i> <code>${(aiError || "").slice(0, 200)}</code>`
      : `✅ AI: ${wasRewritten ? `yes (${aiProvider})` : "no (format only)"}`;

    if (feedbackChatId && processingMsgId) {
      // v0.5.8.1: Show scheduling result with fallback info
      let schedMsg;
      let headerLine;
      if (wasScheduled) {
        if (usedFallback) {
          // v0.5.8.1: Native scheduling failed, fell back to KV cron queue
          headerLine = `📅 <b>Scheduled!</b> (cron fallback)`;
          schedMsg = [
            `\n📅 <b>Will be sent at:</b> ${new Date(scheduledTime).toLocaleString('en-US', { timeZone: 'UTC', hour12: false })} UTC`,
            `⏰ <i>Cron will send within 1 minute of this time</i>`,
            ``,
            `<i>⚠️ Native Telegram scheduling failed (bot may lack permissions).</i>`,
            `<i>Run <code>/checkperms</code> to enable native scheduling for review.</i>`,
          ].join("\n");
        } else {
          // Native scheduling succeeded — posts appear in scheduled view
          headerLine = `📅 <b>Scheduled!</b>`;
          schedMsg = [
            `\n📅 <b>Scheduled for:</b> ${new Date(scheduledTime).toLocaleString('en-US', { timeZone: 'UTC', hour12: false })} UTC`,
            ``,
            `<b>📋 To review/edit/delete:</b>`,
            `1. Open the channel <code>${targetChannel}</code>`,
            `2. Tap the channel name at the top`,
            `3. Select <b>"Scheduled Messages"</b> (clock icon 🕐)`,
            ``,
            `<i>The post will auto-publish at the scheduled time.</i>`,
          ].join("\n");
        }
      } else if (settings.scheduling_enabled && publishRes.scheduleError) {
        // Scheduling was requested but FAILED completely (no fallback either)
        headerLine = `⚠️ <b>Scheduling FAILED</b>`;
        schedMsg = [
          `\n❌ <b>Error:</b> <code>${(publishRes.scheduleError || "").slice(0, 250)}</code>`,
          ``,
          `<b>How to fix:</b>`,
          `• Run <code>/checkperms</code> to verify bot permissions`,
          `• Bot needs <b>"Post Messages"</b> permission in the channel`,
          `• Schedule must be between 90s and 7 days from now`,
          ``,
          `<i>Your post was NOT published. Fix the issue and resend.</i>`,
        ].join("\n");
      } else {
        headerLine = `✅ <b>Done</b>`;
        schedMsg = `\n✅ <b>Published to:</b> <code>${targetChannel}</code>`;
      }
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        [
          headerLine,
          schedMsg,
          ``,
          `<blockquote><b>Type:</b> ${decision.content_type} / ${effectiveRewriteMode}`,
          `${statusLine}`,
          `<b>Time:</b> ${totalMs}ms</blockquote>`,
        ].join("\n"),
        { disable_web_page_preview: true }).catch(() => {});
    }
    return { ok: true, detail: `published: ${decision.content_type}/${effectiveRewriteMode}` };
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
    console.error("[pipeline] publish failed:", publishRes.description || publishRes.scheduleError);

    // v0.5.8: If scheduling failed (not general publish failure), show helpful message
    const errorMsg = publishRes.scheduleError || publishRes.description || "unknown error";
    if (feedbackChatId && processingMsgId) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        [
          `❌ <b>Failed</b>`,
          ``,
          `<b>Error:</b> <code>${(errorMsg || "").slice(0, 250)}</code>`,
          ``,
          settings.scheduling_enabled
            ? `<i>Run <code>/checkperms</code> to verify bot has "Post Messages" permission.</i>`
            : `<i>Check bot configuration and try again.</i>`,
        ].join("\n"),
        { disable_web_page_preview: true }).catch(() => {});
    }
    return { ok: false, detail: `publish: ${errorMsg}` };
  }
}

// ============================================================
// CHANNEL EDIT PIPELINE
// ============================================================
async function runChannelEditPipeline(env, content, update) {
  const SETTINGS = env.SETTINGS;
  const adminId = env.ADMIN_ID;
  const startTime = Date.now();

  console.log(`[channel-edit] msg=${content.messageId}`);

  let settings;
  try {
    settings = await getSettings(SETTINGS, adminId);
  } catch (e) {
    console.error("[channel-edit] getSettings failed:", e.message);
    return;
  }

  const rawText = content.text || "";
  if (!rawText && !content.mediaFileId) return;

  const effectiveLang = settings.language_mode === "auto" ? "auto" : settings.language_mode;

  let decision;
  try {
    const cls = await classify(env, settings, rawText);
    decision = cls.decision;
  } catch {
    decision = { content_type: "other", rewrite_mode: "light", needs_rewrite: true, language_mode: effectiveLang };
  }

  const cleanedText = cleanContent(rawText);

  let finalText = cleanedText;
  let wasRewritten = false;
  const effectiveRewriteMode = decision.rewrite_mode || settings.rewrite_mode || "light";
  const shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;

  if (shouldRewrite && decision.needs_rewrite !== false) {
    try {
      const res = await aiRewrite(env, settings, cleanedText, effectiveRewriteMode, effectiveLang, settings.personality_mode || "friendly", settings.edit_intensity ?? 60, settings.emoji_level ?? 20);
      if (res.ok && res.text) {
        finalText = res.text;
        wasRewritten = true;
      }
    } catch (e) {
      console.error("[channel-edit] AI error:", e.message);
    }
  }

  const { text: formattedText, parseMode } = formatPost(finalText, {
    footer: settings.footer_text, engineName: "html", intensity: settings.edit_intensity ?? 60,
  });

  let editRes;
  if (content.mediaType) {
    editRes = await editMessageCaption(env.BOT_TOKEN, content.chatId, content.messageId, formattedText, { parse_mode: parseMode });
  } else {
    editRes = await editMessageText(env.BOT_TOKEN, content.chatId, content.messageId, formattedText, { parse_mode: parseMode });
  }

  if (editRes.ok) {
    await bumpStats(SETTINGS, adminId, "processed");
    await bumpGlobalStats(SETTINGS, "processed");
    if (wasRewritten) {
      await bumpStats(SETTINGS, adminId, "rewritten");
      await bumpGlobalStats(SETTINGS, "rewritten");
    }
    console.log(`[channel-edit] OK in ${Date.now() - startTime}ms`);
    await sendMessage(env.BOT_TOKEN, adminId,
      `✏️ <b>Edited channel post</b> #${content.messageId}\nType: ${decision.content_type}/${effectiveRewriteMode} · AI: ${wasRewritten ? "yes" : "no"}`,
      { disable_web_page_preview: true }).catch(() => {});
    if (update) await logUpdate(SETTINGS, update, "ok", `channel-edit: ${decision.content_type}/${effectiveRewriteMode}`);
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
    console.error("[channel-edit] failed:", editRes.description);
    await sendMessage(env.BOT_TOKEN, adminId,
      `❌ <b>Channel edit failed:</b> <code>${editRes.description || "unknown"}</code>`,
      { disable_web_page_preview: true }).catch(() => {});
    if (update) await logUpdate(SETTINGS, update, "error", `channel-edit: ${editRes.description}`);
  }
}

// ============================================================
// BOT ID CACHE
// ============================================================
let _cachedBotId = null;
async function getBotId(env) {
  if (_cachedBotId) return _cachedBotId;
  try {
    const me = await getMe(env.BOT_TOKEN);
    if (me.ok) {
      _cachedBotId = me.result.id;
      return _cachedBotId;
    }
  } catch (e) {
    console.warn("[getBotId] failed:", e.message);
  }
  return null;
}

// ============================================================
// UTIL
// ============================================================
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
