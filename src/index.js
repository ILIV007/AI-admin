/**
 * src/index.js
 * AI Admin — Cloudflare Worker entry point — v0.5.9
 *
 * v0.5.9 (TASK 7 refactor): This file is now SLIM (< 300 lines).
 *   - Pipeline functions moved to src/pipeline.js
 *   - Only contains: fetch (routing), handleUpdate (dispatcher),
 *     handlePrivateMessage (command router)
 *   - v0.5.9 TASK 1: Removed scheduled() cron handler (native-only scheduling)
 *   - v0.5.9 TASK 2: Added /debug_schedule command
 *   - v0.5.9 TASK 4: logUpdate/logError/logRawRequest now receive env for
 *     conditional DEBUG_MODE writes; stats flushed via ctx.waitUntil
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
  sendChatAction,
} from "./telegram.js";
import {
  getSettings,
  flushAllStats,
} from "./kv.js";
import { isAuthorized, handleStart, handleMenu, handleFooterCommand, handleCallbackQuery } from "./admin.js";
import { cleanContent } from "./cleaner.js";
import { formatPost } from "./formatter.js";
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
import {
  handleMediaGroupUpdate,
  runPipeline,
  runChannelEditPipeline,
  getBotId,
} from "./pipeline.js";

const VERSION = "0.6.3";

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
        }, env));
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
        }, env));
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
        }, env);
        await handleUpdate(update, env);
        // v0.5.9 TASK 4: Flush batched stats after each request
        await flushAllStats(SETTINGS);
      })());
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },

  // v0.5.9 TASK 1: NO scheduled() cron handler — removed per user request.
  // Only native Telegram schedule_date is used.
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
// UPDATE HANDLER (dispatcher)
// ============================================================
async function handleUpdate(update, env) {
  const SETTINGS = env.SETTINGS;

  try {
    if (update.callback_query) {
      const cq = update.callback_query;
      if (!isAuthorized(env, cq.from.id)) {
        await answerCallbackQuery(env.BOT_TOKEN, cq.id, "⛔ Unauthorized");
        await logUpdate(SETTINGS, update, "unauthorized", `from=${cq.from.id}`, env);
        return;
      }
      await handleCallbackQuery(env, SETTINGS, cq);
      await logUpdate(SETTINGS, update, "ok", `callback: ${cq.data}`, env);
      return;
    }

    const content = extractContent(update);
    if (!content) return;

    // v0.6.2: Check authorization BEFORE routing media groups
    // Non-admin users get a format-only response (no AI, no publish)
    const isAdmin = env.ADMIN_ID && isAuthorized(env, content.fromId);

    // Media group handling
    if (content.mediaGroupId) {
      if (isAdmin) {
        console.log(`[update] media group: ${content.mediaGroupId}`);
        await handleMediaGroupUpdate(env, content, update);
      } else {
        // v0.6.2: Non-admin users get per-item format-only response
        // (no buffering, no AI, no channel publish)
        await handleNonAdminFormat(env, content, update);
      }
      return;
    }

    if (content.chatType === "private") {
      await handlePrivateMessage(env, content, update);
      return;
    }

    if (content.chatType === "channel" || content.chatType === "supergroup" || content.chatType === "group") {
      const settings = await getSettings(SETTINGS, content.fromId || env.ADMIN_ID);
      if (!settings.channel_editing_enabled) {
        await logUpdate(SETTINGS, update, "ignored", "channel editing OFF", env);
        return;
      }
      const botId = await getBotId(env);
      if (botId && content.fromId === botId) {
        await logUpdate(SETTINGS, update, "ignored", "self-post", env);
        return;
      }
      await runChannelEditPipeline(env, content, update);
      return;
    }
  } catch (e) {
    console.error("[update] error:", e.message, e.stack);
    await logError(SETTINGS, e, "handleUpdate", env);
    await logUpdate(SETTINGS, update, "error", e.message, env);
  }
}

// ============================================================
// PRIVATE MESSAGE HANDLER (command router)
// v0.6.2: Split /start (intro for ALL users) from /menu (admin panel)
// ============================================================
async function handlePrivateMessage(env, content, update) {
  const SETTINGS = env.SETTINGS;

  if (!env.ADMIN_ID) {
    await sendMessage(env.BOT_TOKEN, content.chatId,
      `⚠️ <b>Configuration Error</b>\n\n<code>ADMIN_ID</code> is not set.\n\nYour Telegram ID: <code>${content.fromId}</code>`,
      { parse_mode: "HTML" });
    await logUpdate(SETTINGS, update, "error", "ADMIN_ID not set", env);
    return;
  }

  const text = content.text || "";

  // v0.6.2: /start is available to ALL users (shows bot intro)
  if (/^\/start\b/i.test(text)) {
    await handleStart(env, SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } });
    await logUpdate(SETTINGS, update, "ok", "/start", env);
    return;
  }

  // v0.6.2: Non-admin users — only /start is recognized.
  // All other messages (commands or text/media) get format-only response.
  if (!isAuthorized(env, content.fromId)) {
    // Typing indicator
    if (content.chatId) {
      await sendChatAction(env.BOT_TOKEN, content.chatId, "typing").catch(() => {});
    }
    await handleNonAdminFormat(env, content, update);
    return;
  }

  // ===== ADMIN FLOW (authorized) =====
  // Typing indicator immediately
  if (content.chatId) {
    await sendChatAction(env.BOT_TOKEN, content.chatId, "typing").catch(() => {});
  }

  // v0.6.2: /menu shows the admin settings panel (replaces old /start behavior)
  if (/^\/menu\b/i.test(text)) {
    await handleMenu(env, SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } });
    await logUpdate(SETTINGS, update, "ok", "/menu", env);
    return;
  }

  if (/^\/footer\b/i.test(text)) {
    const args = text.replace(/^\/footer\s*/i, "");
    await handleFooterCommand(env, SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } }, args);
    await logUpdate(SETTINGS, update, "ok", "/footer", env);
    return;
  }

  if (/^\/help\b/i.test(text)) {
    await sendMessage(env.BOT_TOKEN, content.chatId,
      `<b>AI Admin — Help</b>\n\nSend me any post and I will process and publish it.\n\nCommands:\n/start — Bot introduction (all users)\n/menu — Admin settings panel\n/footer &lt;text&gt; — Change footer\n/checkperms — Check bot permissions in channel\n/debug_schedule — Test scheduling with a dummy message\n/help — This message`,
      { parse_mode: "HTML" });
    await logUpdate(SETTINGS, update, "ok", "/help", env);
    return;
  }

  // v0.5.8: /checkperms — check if bot has permission to schedule messages
  if (/^\/checkperms\b/i.test(text)) {
    await handleCheckPerms(env, content, update);
    return;
  }

  // v0.5.9 TASK 2: /debug_schedule — test scheduling with detailed logging
  if (/^\/debug_schedule\b/i.test(text)) {
    await handleDebugSchedule(env, content, update);
    return;
  }

  // Content pipeline
  await runPipeline(env, content, content.chatId, update);
}

// ============================================================
// v0.6.2: NON-ADMIN FORMAT-ONLY RESPONSE
// ============================================================
// For non-admin users: clean → format → send back to user's PV.
// NO AI rewrite, NO channel publish, NO scheduling.
// Works for both text-only and media-attached messages.
// ============================================================
async function handleNonAdminFormat(env, content, update) {
  const SETTINGS = env.SETTINGS;
  const rawText = content.text || "";

  // Skip empty messages (no text AND no media)
  if (!rawText && !content.mediaFileId) {
    await sendMessage(env.BOT_TOKEN, content.chatId,
      `<i>برای پردازش، متنی را ارسال کنید.</i>`,
      { parse_mode: "HTML" }).catch(() => {});
    return;
  }

  // Clean + format with default settings (intensity: 60, emojiLevel: 20)
  const cleanedText = cleanContent(rawText);
  const { text: formattedText, parseMode } = formatPost(cleanedText || "", {
    footer: null,
    engineName: "html",
    intensity: 60,
    emojiLevel: 20,
  });

  // Send back to user (with media if attached)
  if (content.mediaFileId) {
    await publishToChannel(env.BOT_TOKEN, content.chatId, {
      text: formattedText || "",
      mediaType: content.mediaType,
      mediaFileId: content.mediaFileId,
      extra: { parse_mode: parseMode, disable_web_page_preview: true },
    }).catch(() => ({ ok: false }));
  } else if (formattedText && formattedText.trim()) {
    await sendMessage(env.BOT_TOKEN, content.chatId, formattedText, {
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }).catch(() => {});
  } else {
    await sendMessage(env.BOT_TOKEN, content.chatId,
      `<i>پست شما خالی است یا قابل پردازش نیست.</i>`,
      { parse_mode: "HTML" }).catch(() => {});
  }

  await logUpdate(SETTINGS, update, "ok", "format-only (non-admin)", env);
}

// ============================================================
// /checkperms — Check bot permissions in channel
// ============================================================
async function handleCheckPerms(env, content, update) {
  const SETTINGS = env.SETTINGS;
  const targetChannel = env.TARGET_CHANNEL;
  if (!targetChannel) {
    await sendMessage(env.BOT_TOKEN, content.chatId, `❌ <code>TARGET_CHANNEL</code> is not configured.`, { parse_mode: "HTML" });
    await logUpdate(SETTINGS, update, "ok", "/checkperms: no channel", env);
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

  await sendMessage(env.BOT_TOKEN, content.chatId, message, { parse_mode: "HTML", disable_web_page_preview: true });
  await logUpdate(SETTINGS, update, "ok", `/checkperms: ${permCheck.ok ? "OK" : "FAIL"}`, env);
}

// ============================================================
// v0.5.9 TASK 2: /debug_schedule — Test scheduling with full logging
// ============================================================
// Sends a dummy scheduled message to the channel and reports EVERY step
// to the admin: permission check → schedule_date calculation → API call →
// verification. This helps diagnose why scheduling fails silently.
// ============================================================
async function handleDebugSchedule(env, content, update) {
  const SETTINGS = env.SETTINGS;
  const targetChannel = env.TARGET_CHANNEL;
  const BOT_TOKEN = env.BOT_TOKEN;
  const chatId = content.chatId;

  if (!targetChannel) {
    await sendMessage(BOT_TOKEN, chatId, `❌ <code>TARGET_CHANNEL</code> is not configured.`, { parse_mode: "HTML" });
    return;
  }

  const logs = [];
  const log = (msg) => {
    console.log(`[debug_schedule] ${msg}`);
    logs.push(msg);
  };

  try {
    log(`🧪 Starting scheduling debug test...`);
    log(`📍 Target channel: ${targetChannel}`);

    // Step 1: Get bot ID
    log(`Step 1: Getting bot ID...`);
    const botId = await getBotId(env);
    log(`  Bot ID: ${botId}`);

    // Step 2: Check permissions
    log(`Step 2: Checking permissions...`);
    const permCheck = await checkSchedulingPermissions(BOT_TOKEN, targetChannel, botId);
    log(`  ok=${permCheck.ok}, status=${permCheck.status || "N/A"}, canPostMessages=${permCheck.canPostMessages}`);
    if (!permCheck.ok) {
      log(`  ERROR: ${permCheck.error}`);
      if (permCheck.rawPermissions) {
        log(`  Raw perms: ${JSON.stringify(permCheck.rawPermissions)}`);
      }
    }

    // Step 3: Show current time (for reference)
    log(`Step 3: Current time: ${Math.floor(Date.now()/1000)} (${new Date().toISOString()})`);
    log(`  (Each test will schedule 90s in the future)`);

    // v0.5.10 TASK 1: Resolve @username to numeric chat_id (CRITICAL!)
    // v0.5.12 TASK 4: Invalidate cache first to ensure fresh resolution
    log(`Step 3.5: Resolving channel ${targetChannel} to numeric chat_id...`);
    const { resolveChatId, invalidateChatIdCache } = await import("./telegram.js");
    invalidateChatIdCache(targetChannel); // v0.5.12: fresh resolution
    const resolvedChannel = await resolveChatId(BOT_TOKEN, targetChannel);
    log(`  Resolved → ${resolvedChannel} (type: ${typeof resolvedChannel})`);
    if (String(resolvedChannel).startsWith("@")) {
      log(`  ⚠️ WARNING: Resolution failed — still a @username. Scheduling will likely fail.`);
    }

    // Step 4: Send FOUR test messages to isolate the issue
    // v0.5.12: Test A = HTML, B = plain text, C = minimal, D = raw API bypass
    log(`Step 4: Sending FOUR test messages...`);

    // Test A: WITH parse_mode HTML (via wrapper)
    log(`  Test A (HTML wrapper): Sending with parse_mode=HTML...`);
    const scheduledTimeA = Date.now() + 90 * 1000;
    const scheduleDateUnixA = Math.floor(scheduledTimeA / 1000);
    const sendResA = await publishToChannel(BOT_TOKEN, resolvedChannel, {
      text: `🧪 <b>Test A (HTML)</b>\nScheduled for ${new Date(scheduledTimeA).toISOString()}`,
      extra: { parse_mode: "HTML", schedule_date: scheduleDateUnixA },
    });
    log(`  Test A response: ${JSON.stringify(sendResA).slice(0, 300)}`);
    log(`  Test A: ok=${sendResA.ok}, result.date=${sendResA.result?.date}`);

    await new Promise((r) => setTimeout(r, 2000));

    // Test B: WITHOUT parse_mode (via wrapper, plain text)
    log(`  Test B (Plain wrapper): Sending WITHOUT parse_mode...`);
    const scheduledTimeB = Date.now() + 90 * 1000;
    const scheduleDateUnixB = Math.floor(scheduledTimeB / 1000);
    const sendResB = await publishToChannel(BOT_TOKEN, resolvedChannel, {
      text: `🧪 Test B (Plain Text)\nScheduled for ${new Date(scheduledTimeB).toISOString()}`,
      extra: { schedule_date: scheduleDateUnixB },
    });
    log(`  Test B response: ${JSON.stringify(sendResB).slice(0, 300)}`);
    log(`  Test B: ok=${sendResB.ok}, result.date=${sendResB.result?.date}`);

    await new Promise((r) => setTimeout(r, 2000));

    // Test C: Minimal payload (only chat_id, text, schedule_date — nothing else)
    log(`  Test C (Minimal wrapper): Sending with bare minimum...`);
    const scheduledTimeC = Date.now() + 90 * 1000;
    const scheduleDateUnixC = Math.floor(scheduledTimeC / 1000);
    const sendResC = await publishToChannel(BOT_TOKEN, resolvedChannel, {
      text: `🧪 Test C (Minimal)\nScheduled for ${new Date(scheduledTimeC).toISOString()}`,
      extra: { schedule_date: scheduleDateUnixC },
    });
    log(`  Test C response: ${JSON.stringify(sendResC).slice(0, 300)}`);
    log(`  Test C: ok=${sendResC.ok}, result.date=${sendResC.result?.date}`);

    await new Promise((r) => setTimeout(r, 2000));

    // Test D: RAW API call — bypass ALL wrappers, direct fetch to Telegram
    // This is the most minimal test possible. If this fails, it's 100% Telegram-side.
    log(`  Test D (Raw API): Direct fetch, bypassing all wrappers...`);
    const scheduledTimeD = Date.now() + 90 * 1000;
    const scheduleDateUnixD = Math.floor(scheduledTimeD / 1000);
    const rawPayload = {
      chat_id: resolvedChannel,
      text: `🧪 Test D (Raw API)\nScheduled for ${new Date(scheduledTimeD).toISOString()}`,
      schedule_date: scheduleDateUnixD,
    };
    log(`  Test D raw payload: ${JSON.stringify(rawPayload)}`);
    const rawRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rawPayload),
    });
    const rawData = await rawRes.json();
    log(`  Test D response: ${JSON.stringify(rawData).slice(0, 300)}`);
    log(`  Test D: ok=${rawData.ok}, result.date=${rawData.result?.date}`);

    // Step 5: Verify ALL tests
    log(`Step 5: Verifying all 4 tests...`);
    const verA = verifyScheduled(sendResA, scheduleDateUnixA);
    const verB = verifyScheduled(sendResB, scheduleDateUnixB);
    const verC = verifyScheduled(sendResC, scheduleDateUnixC);
    const verD = verifyScheduled(rawData, scheduleDateUnixD);
    log(`  Test A: scheduled=${verA.scheduled}, reason=${verA.reason}, diffSeconds=${verA.diffSeconds || 0}`);
    log(`  Test B: scheduled=${verB.scheduled}, reason=${verB.reason}, diffSeconds=${verB.diffSeconds || 0}`);
    log(`  Test C: scheduled=${verC.scheduled}, reason=${verC.reason}, diffSeconds=${verC.diffSeconds || 0}`);
    log(`  Test D: scheduled=${verD.scheduled}, reason=${verD.reason}, diffSeconds=${verD.diffSeconds || 0}`);

    // Step 6: Conclusion based on which test succeeded
    let conclusion;
    if (verD.scheduled) {
      // Raw API works — scheduling IS possible
      if (verA.scheduled && verB.scheduled && verC.scheduled) {
        conclusion = `✅ ALL 4 tests SUCCEEDED! Scheduling works correctly in all modes.`;
      } else if (!verA.scheduled) {
        conclusion = `⚠️ Raw API works but Test A (HTML) failed. parse_mode=HTML is conflicting with schedule_date in the wrapper.`;
      } else if (!verB.scheduled || !verC.scheduled) {
        conclusion = `⚠️ Raw API works but wrapper tests failed. Something in the wrapper is conflicting.`;
      } else {
        conclusion = `✅ Raw API + some wrapper tests succeeded. Scheduling works.`;
      }
    } else if (!verD.scheduled) {
      // Raw API ALSO failed — this is a Telegram-side issue
      conclusion = `❌ ALL tests FAILED (including Raw API Test D). This is NOT a code bug — it's a Telegram-side issue. The bot may need to be: (1) removed and re-added as admin, (2) given 'Post Messages' permission explicitly, or (3) the channel may need to be a supergroup instead of a broadcast channel. Also check: is the bot's admin permission 'Add New Admins' OFF and 'Post Messages' ON?`;
    } else {
      conclusion = `❌ Scheduling FAILED — see logs above.`;
    }
    log(conclusion);

    // Send all logs to admin
    const logText = logs.map((l, i) => `${i + 1}. ${l}`).join("\n");
    await sendMessage(BOT_TOKEN, chatId,
      [
        `🧪 <b>Scheduling Debug Results (v0.5.12)</b>`,
        ``,
        `<blockquote>${logText}</blockquote>`,
        ``,
        `<b>Conclusion:</b> ${conclusion}`,
      ].join("\n"),
      { parse_mode: "HTML", disable_web_page_preview: true });

    const anySuccess = verA.scheduled || verB.scheduled || verC.scheduled || verD.scheduled;
    await logUpdate(SETTINGS, update, "ok", `/debug_schedule: ${anySuccess ? "OK" : "FAIL"}`, env);
  } catch (e) {
    console.error("[debug_schedule] exception:", e.message);
    await sendMessage(BOT_TOKEN, chatId,
      `❌ <b>Debug schedule failed:</b> <code>${e.message}</code>`,
      { parse_mode: "HTML", disable_web_page_preview: true });
    await logUpdate(SETTINGS, update, "error", `/debug_schedule exception: ${e.message}`, env);
  }
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
