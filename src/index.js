/**
 * src/index.js
 * AI Admin — Cloudflare Worker entry point — v0.5.14
 *
 * v0.5.14: Re-added scheduled() cron handler for SILENT scheduling fallback.
 *   - When native Telegram schedule_date fails, posts are queued in KV
 *   - Cron trigger (every 1 minute) sends due messages
 *   - User sees "📅 Scheduled!" regardless of method used
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
  sendMediaGroup,
} from "./telegram.js";
import {
  getSettings,
  flushAllStats,
  listDueScheduled,
  deleteScheduledItem,
} from "./kv.js";
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
import {
  handleMediaGroupUpdate,
  runPipeline,
  runChannelEditPipeline,
  getBotId,
} from "./pipeline.js";
import { aiRewrite } from "./ai.js";
import { formatPost } from "./formatter.js";
import { cleanContent, protectPrompts, restorePrompts } from "./cleaner.js";

const VERSION = "0.5.17";

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

  // v0.5.14: CRON HANDLER — Silent scheduling fallback
  // Runs every 1 minute. Sends messages queued in KV when native scheduling failed.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processScheduledQueue(env));
  },
};

// ============================================================
// v0.5.14: SCHEDULED QUEUE PROCESSOR (Silent Cron Fallback)
// ============================================================
// Called by cron trigger every minute. Lists due messages from KV
// and sends them via regular Telegram API (no schedule_date — we're
// sending them NOW because it's their scheduled time).
// ============================================================
async function processScheduledQueue(env) {
  const SETTINGS = env.SETTINGS;
  if (!SETTINGS) return;

  console.log(`[cron] v0.5.14 checking for due scheduled messages at ${new Date().toISOString()}`);
  const due = await listDueScheduled(SETTINGS);
  if (due.length === 0) return;
  console.log(`[cron] Found ${due.length} due messages`);

  for (const item of due) {
    try {
      console.log(`[cron] Sending scheduled message ${item.id} to ${item.chatId} (was scheduled for ${new Date(item.scheduledTime).toISOString()})`);

      let res;
      if (item.mediaGroupItems && item.mediaGroupItems.length > 0) {
        res = await sendMediaGroup(env.BOT_TOKEN, item.chatId, item.mediaGroupItems, {
          parse_mode: item.parseMode,
        });
      } else {
        res = await publishToChannel(env.BOT_TOKEN, item.chatId, {
          text: item.text,
          mediaType: item.mediaType,
          mediaFileId: item.mediaFileId,
          extra: { parse_mode: item.parseMode },
        });
      }

      if (res.ok) {
        console.log(`[cron] ✓ Sent message ${item.id}`);
        await deleteScheduledItem(SETTINGS, item._kvKey);
      } else {
        console.error(`[cron] ✗ Failed: ${res.description}`);
        const permanentErrors = ["chat not found", "bot was blocked", "CHAT_ADMIN_REQUIRED"];
        const isPermanent = permanentErrors.some((e) => (res.description || "").toLowerCase().includes(e.toLowerCase()));
        if (isPermanent) {
          await deleteScheduledItem(SETTINGS, item._kvKey);
        }
      }
    } catch (e) {
      console.error(`[cron] Exception: ${e.message}`);
    }
  }
}

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

  // v0.5.16: New debug API endpoints for testing from dashboard
  if (request.method === "POST" && url.pathname === "/debug/api/test/cron") {
    return (async () => {
      try {
        console.log(`[debug API] Manually triggering cron queue`);
        await processScheduledQueue(env);
        return json({ ok: true, message: "Cron queue processed. Check logs for details." });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    })();
  }

  if (request.method === "POST" && url.pathname === "/debug/api/test/ai_rewrite") {
    return (async () => {
      try {
        const body = await request.json().catch(() => ({}));
        const testText = body.text || "This is a test post about Cloudflare Workers. It should be rewritten nicely.";
        const settings = await getSettings(SETTINGS, env.ADMIN_ID);
        console.log(`[debug API] Testing AI rewrite with: "${testText.slice(0, 60)}..."`);
        const result = await aiRewrite(env, settings, testText, "light", "auto", "friendly", 60, 20);
        return json({
          ok: result.ok,
          input: testText,
          output: result.text || null,
          provider: result.provider || null,
          model: result.model || null,
          error: result.error || null,
        });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    })();
  }

  if (request.method === "POST" && url.pathname === "/debug/api/test/format") {
    return (async () => {
      try {
        const body = await request.json().catch(() => ({}));
        const testText = body.text || `This is a test post about AI tools.

Prompt:
Keep the face 100% identical to the reference. Photorealistic mirror selfie. Cinematic lighting. 8k. Ultra detailed. --ar 16:9 --v 6.0

This is another paragraph that is long enough to be quoted. It has multiple sentences.`;
        console.log(`[debug API] Testing formatter`);
        const { text: formatted, parseMode } = formatPost(testText, {
          engineName: "html",
          intensity: 60,
          emojiLevel: 20,
        });
        return json({
          ok: true,
          input: testText,
          output: formatted,
          parseMode,
          inputLength: testText.length,
          outputLength: formatted.length,
        });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    })();
  }

  if (request.method === "POST" && url.pathname === "/debug/api/test/clean") {
    return (async () => {
      try {
        const body = await request.json().catch(() => ({}));
        const testText = body.text || `This is a normal post.

Keep the face 100% identical to the reference. Photorealistic mirror selfie. Cinematic lighting. 8k. Ultra detailed. --ar 3:2 --v 6.0. ` + "A".repeat(200);
        console.log(`[debug API] Testing prompt protection`);
        const { text: protectedText, prompts } = protectPrompts(testText);
        const restored = restorePrompts(protectedText, prompts);
        return json({
          ok: true,
          input: testText,
          protectedText,
          promptsDetected: prompts.length,
          prompts: prompts.map((p) => ({ length: p.length, preview: p.slice(0, 100) })),
          restoreMatchesOriginal: restored === testText,
        });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    })();
  }

  if (request.method === "POST" && url.pathname === "/debug/api/test/scheduling") {
    return (async () => {
      try {
        const targetChannel = env.TARGET_CHANNEL;
        if (!targetChannel) return json({ ok: false, error: "TARGET_CHANNEL not set" });

        const botId = await getBotId(env);
        const permCheck = await checkSchedulingPermissions(env.BOT_TOKEN, targetChannel, botId);

        // Try native scheduling with a test message
        const scheduledTime = Date.now() + 90 * 1000;
        const scheduleDateUnix = Math.floor(scheduledTime / 1000);

        const { resolveChatId } = await import("./telegram.js");
        const resolvedChannel = await resolveChatId(env.BOT_TOKEN, targetChannel);

        const sendRes = await publishToChannel(env.BOT_TOKEN, resolvedChannel, {
          text: `🧪 Debug API scheduling test for ${new Date(scheduledTime).toISOString()}`,
          extra: { schedule_date: scheduleDateUnix },
        });

        const verification = verifyScheduled(sendRes, scheduleDateUnix);

        return json({
          ok: true,
          permissions: permCheck,
          resolvedChannel,
          scheduleDateUnix,
          telegramResponse: sendRes,
          verification,
          nativeScheduled: verification.scheduled,
        });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    })();
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

  if (!isAuthorized(env, content.fromId)) {
    await sendMessage(env.BOT_TOKEN, content.chatId,
      `⛔ <b>Unauthorized</b>\n\nYour ID: <code>${content.fromId}</code>\nConfigured ADMIN_ID: <code>${env.ADMIN_ID}</code>`,
      { parse_mode: "HTML" });
    await logUpdate(SETTINGS, update, "unauthorized", `from=${content.fromId} expected=${env.ADMIN_ID}`, env);
    return;
  }

  const text = content.text || "";

  // Typing indicator immediately
  if (content.chatId) {
    await sendChatAction(env.BOT_TOKEN, content.chatId, "typing").catch(() => {});
  }

  if (/^\/start\b/i.test(text)) {
    await handleStart(env, SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } });
    await logUpdate(SETTINGS, update, "ok", "/start", env);
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
      `<b>AI Admin — Help</b>\n\nSend me any post and I will process and publish it.\n\n<b>Commands:</b>\n/start — Admin panel\n/footer &lt;text&gt; — Change footer\n/checkperms — Check bot permissions\n/debug_schedule — Test scheduling (5 tests)\n/test_cron — Manually trigger cron queue\n/test_ai — Test AI rewrite\n/test_format — Test formatter\n/test_clean — Test prompt protection\n/help — This message`,
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

  // v0.5.15: /test_cron — manually trigger cron queue processing
  if (/^\/test_cron\b/i.test(text)) {
    console.log(`[test_cron] Manually triggering processScheduledQueue`);
    await sendMessage(env.BOT_TOKEN, content.chatId, `⏳ <b>Running cron test...</b>`, { parse_mode: "HTML" });
    try {
      await processScheduledQueue(env);
      await sendMessage(env.BOT_TOKEN, content.chatId,
        `✅ <b>Cron test completed.</b>\nCheck Cloudflare logs for details.`, { parse_mode: "HTML" });
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, content.chatId,
        `❌ <b>Cron test failed:</b> <code>${e.message}</code>`, { parse_mode: "HTML" });
    }
    await logUpdate(SETTINGS, update, "ok", "/test_cron", env);
    return;
  }

  // v0.5.15: /test_ai — manually test AI
  if (/^\/test_ai\b/i.test(text)) {
    console.log(`[test_ai] Manually testing AI`);
    await sendMessage(env.BOT_TOKEN, content.chatId, `⏳ <b>Testing AI...</b>`, { parse_mode: "HTML" });
    try {
      const settings = await getSettings(SETTINGS, content.fromId);
      const testText = "This is a test post about Cloudflare Workers. It should be rewritten nicely.";
      const result = await aiRewrite(env, settings, testText, "light", "auto", "friendly", 60, 20);

      if (result.ok) {
        await sendMessage(env.BOT_TOKEN, content.chatId,
          [
            `✅ <b>AI test successful</b>`,
            ``,
            `<b>Provider:</b> <code>${result.provider}</code>`,
            `<b>Model:</b> <code>${result.model}</code>`,
            ``,
            `<b>Input:</b> <i>${testText}</i>`,
            `<b>Output:</b> <i>${result.text.slice(0, 300)}</i>`,
          ].join("\n"),
          { parse_mode: "HTML" });
      } else {
        await sendMessage(env.BOT_TOKEN, content.chatId,
          `❌ <b>AI test failed</b>\nError: <code>${result.error}</code>`, { parse_mode: "HTML" });
      }
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, content.chatId,
        `❌ <b>AI test exception:</b> <code>${e.message}</code>`, { parse_mode: "HTML" });
    }
    await logUpdate(SETTINGS, update, "ok", "/test_ai", env);
    return;
  }

  // v0.5.15: /test_format — test the formatter
  if (/^\/test_format\b/i.test(text)) {
    console.log(`[test_format] Testing formatter`);
    await sendMessage(env.BOT_TOKEN, content.chatId, `⏳ <b>Testing formatter...</b>`, { parse_mode: "HTML" });
    try {
      const testText = `This is a test post about AI tools.

Prompt:
Keep the face 100% identical to the reference. Photorealistic mirror selfie of a young woman indoors. Cinematic lighting. 8k. Ultra detailed. Octane render. --ar 16:9 --v 6.0

This is another paragraph that is long enough to be quoted. It has multiple sentences. It should be collapsible in Telegram. This makes the post look much cleaner and more professional.`;

      const { text: formatted, parseMode } = formatPost(testText, {
        engineName: "html",
        intensity: 60,
        emojiLevel: 20,
      });

      await sendMessage(env.BOT_TOKEN, content.chatId,
        [
          `✅ <b>Format test</b>`,
          ``,
          `<b>Parse mode:</b> ${parseMode}`,
          `<b>Length:</b> ${formatted.length} chars`,
          `<b>Result:</b>`,
          formatted,
        ].join("\n"),
        { parse_mode: parseMode });
    } catch (e) {
      await sendMessage(env.BOT_TOKEN, content.chatId,
        `❌ <b>Format test failed:</b> <code>${e.message}</code>`, { parse_mode: "HTML" });
    }
    await logUpdate(SETTINGS, update, "ok", "/test_format", env);
    return;
  }

  // v0.5.15: /test_clean — test prompt protection
  if (/^\/test_clean\b/i.test(text)) {
    console.log(`[test_clean] Testing prompt protection`);
    const testText = `This is a normal post about AI.

Keep the face 100% identical to the reference. Photorealistic mirror selfie. Cinematic lighting. 8k. Ultra detailed. Octane render. --ar 3:2 --v 6.0. ` + "A".repeat(200);

    const { text: protected_, prompts } = protectPrompts(testText);
    const restored = restorePrompts(protected_, prompts);

    await sendMessage(env.BOT_TOKEN, content.chatId,
      [
        `🧪 <b>Prompt Protection Test</b>`,
        ``,
        `<b>Original length:</b> ${testText.length} chars`,
        `<b>Protected text length:</b> ${protected_.length} chars`,
        `<b>Prompts detected:</b> ${prompts.length}`,
        `<b>Restore matches original:</b> ${restored === testText ? "✅ YES" : "❌ NO"}`,
        ``,
        `<b>Protected text preview:</b>`,
        `<code>${protected_.slice(0, 200)}...</code>`,
      ].join("\n"),
      { parse_mode: "HTML" });
    await logUpdate(SETTINGS, update, "ok", "/test_clean", env);
    return;
  }

  // Content pipeline
  await runPipeline(env, content, content.chatId, update);
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

    await new Promise((r) => setTimeout(r, 2000));

    // Test E: Schedule in PRIVATE CHAT (always works — no admin permission needed)
    // v0.5.13: If this works but channel scheduling fails, it confirms Telegram-side issue
    log(`  Test E (Private Chat): Scheduling in bot's private chat (always works)...`);
    const scheduledTimeE = Date.now() + 90 * 1000;
    const scheduleDateUnixE = Math.floor(scheduledTimeE / 1000);
    const sendResE = await sendMessage(BOT_TOKEN, chatId, // chatId = admin's private chat
      `🧪 <b>Test E (Private Chat)</b>\nScheduled for ${new Date(scheduledTimeE).toISOString()}`,
      { parse_mode: "HTML", schedule_date: scheduleDateUnixE }
    );
    log(`  Test E response: ${JSON.stringify(sendResE).slice(0, 300)}`);
    log(`  Test E: ok=${sendResE.ok}, result.date=${sendResE.result?.date}`);

    // Step 5: Verify ALL tests
    log(`Step 5: Verifying all 5 tests...`);
    const verA = verifyScheduled(sendResA, scheduleDateUnixA);
    const verB = verifyScheduled(sendResB, scheduleDateUnixB);
    const verC = verifyScheduled(sendResC, scheduleDateUnixC);
    const verD = verifyScheduled(rawData, scheduleDateUnixD);
    const verE = verifyScheduled(sendResE, scheduleDateUnixE);
    log(`  Test A: scheduled=${verA.scheduled}, reason=${verA.reason}, diffSeconds=${verA.diffSeconds || 0}`);
    log(`  Test B: scheduled=${verB.scheduled}, reason=${verB.reason}, diffSeconds=${verB.diffSeconds || 0}`);
    log(`  Test C: scheduled=${verC.scheduled}, reason=${verC.reason}, diffSeconds=${verC.diffSeconds || 0}`);
    log(`  Test D: scheduled=${verD.scheduled}, reason=${verD.reason}, diffSeconds=${verD.diffSeconds || 0}`);
    log(`  Test E: scheduled=${verE.scheduled}, reason=${verE.reason}, diffSeconds=${verE.diffSeconds || 0}`);

    // Step 6: Conclusion based on which test succeeded
    // v0.5.13: Added Test E (private chat) to distinguish Telegram-side issues
    let conclusion;
    if (verE.scheduled && !verD.scheduled) {
      // v0.5.13: Private chat works but channel doesn't — 100% Telegram-side issue
      conclusion = `⚠️ Private chat scheduling (Test E) WORKS but channel scheduling (Test D) FAILS. This is a Telegram-side issue — NOT a code bug. The bot needs to be: (1) removed from the channel, (2) re-added as admin with 'Post Messages' permission ON, (3) 'Add New Admins' permission should be OFF.`;
    } else if (!verE.scheduled) {
      // Even private chat scheduling failed — Telegram API issue
      conclusion = `❌ Even private chat scheduling (Test E) FAILED. This is a Telegram API issue. Try: (1) check bot token is valid, (2) recreate the bot via @BotFather, (3) check Telegram status.`;
    } else if (verD.scheduled) {
      // Channel scheduling works!
      if (verA.scheduled && verB.scheduled && verC.scheduled) {
        conclusion = `✅ ALL 5 tests SUCCEEDED! Scheduling works correctly in all modes (channel + private chat).`;
      } else if (!verA.scheduled) {
        conclusion = `⚠️ Channel scheduling works (Test D) but Test A (HTML) failed. parse_mode=HTML is conflicting with schedule_date in the wrapper.`;
      } else if (!verB.scheduled || !verC.scheduled) {
        conclusion = `⚠️ Channel scheduling works (Test D) but wrapper tests failed. Something in the wrapper is conflicting.`;
      } else {
        conclusion = `✅ Scheduling works! All channel tests + private chat succeeded.`;
      }
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

    const anySuccess = verA.scheduled || verB.scheduled || verC.scheduled || verD.scheduled || verE.scheduled;
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
