/**
 * src/index.js
 * AI Admin — Cloudflare Worker entry point.
 *
 * Endpoints:
 *   GET  /                  → health check
 *   GET  /debug             → HTML debug dashboard (comprehensive diagnostics)
 *   GET  /debug/api/status  → JSON: full status (env, KV, bot, webhook, recent logs)
 *   POST /debug/api/test/*  → run diagnostic tests (message, kv, ai)
 *   POST /debug/api/clear   → clear debug logs
 *   GET  /webhook/info      → bot info + webhook status (legacy debug)
 *   POST /webhook           → Telegram webhook (messages + callback queries)
 *
 * Pipeline (per incoming message):
 *   RECEIVE → EXTRACT → CLASSIFY → CLEAN → [REWRITE/SUMMARIZE] → FORMAT → PUBLISH
 *
 * Failure handling:
 *   If AI fails at any stage → fallback to FORMAT_ONLY mode (clean + format + publish).
 *   We NEVER drop a post.
 */

import {
  extractContent,
  publishToChannel,
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
  getMediaGroup,
  saveMediaGroup,
  deleteMediaGroup,
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

const VERSION = "0.1.1";

// ============================================================
// MAIN EXPORT — Cloudflare Worker fetch handler
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ----- GET / : health check -----
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        name: "AI Admin",
        version: VERSION,
        time: new Date().toISOString(),
        debug: "/debug",
      });
    }

    // ----- /debug/* : debug dashboard + API -----
    if (url.pathname === "/debug" || url.pathname.startsWith("/debug/")) {
      return handleDebugRoute(request, url, env);
    }

    // ----- GET /webhook/info : legacy debug -----
    if (request.method === "GET" && url.pathname === "/webhook/info") {
      const me = await getMe(env.BOT_TOKEN);
      return json({ ok: me.ok, bot: me.result });
    }

    // ----- POST /webhook : Telegram updates -----
    if (request.method === "POST" && url.pathname === "/webhook") {
      const SETTINGS = env.SETTINGS;
      const secret = request.headers.get("x-telegram-bot-api-secret-token");
      const hasSecretCheck = !!env.WEBHOOK_SECRET;
      const secretMatches = !hasSecretCheck || secret === env.WEBHOOK_SECRET;

      // Try to read body as JSON (we'll need it for both logging and processing)
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

      // Extract info from the update for the raw log (BEFORE we make any decision)
      const updateInfo = extractUpdateInfoForLog(update);

      // ===== SECRET TOKEN VERIFICATION =====
      if (hasSecretCheck && !secretMatches) {
        console.warn(
          `[webhook] 403 — secret mismatch.\n` +
            `  Expected: ${env.WEBHOOK_SECRET.slice(0, 3)}…${env.WEBHOOK_SECRET.slice(-3)}\n` +
            `  Got:      ${secret ? `"${secret.slice(0, 3)}…${secret.slice(-3)}"` : "(missing)"}\n` +
            `  Fix: npm run fix:webhook -- https://your-worker.workers.dev`
        );
        // LOG the rejected request so the dashboard shows it
        ctx.waitUntil(
          logRawRequest(SETTINGS, {
            method: request.method,
            path: url.pathname,
            hasSecret: !!secret,
            secretMatch: false,
            bodySize,
            updateType: updateInfo.updateType,
            fromId: updateInfo.fromId,
            chatId: updateInfo.chatId,
            textPreview: updateInfo.textPreview,
            status: "rejected_403",
            detail: `Expected ${env.WEBHOOK_SECRET.slice(0, 3)}…${env.WEBHOOK_SECRET.slice(-3)}, got ${secret ? secret.slice(0, 3) + "…" + secret.slice(-3) : "(missing)"}`,
          })
        );
        return new Response("Forbidden — secret mismatch", { status: 403 });
      }

      // ===== INVALID JSON =====
      if (!update) {
        console.warn("[webhook] 400 — invalid JSON:", bodyParseError);
        ctx.waitUntil(
          logRawRequest(SETTINGS, {
            method: request.method,
            path: url.pathname,
            hasSecret: !!secret,
            secretMatch: secretMatches,
            bodySize,
            updateType: "invalid_json",
            fromId: null,
            chatId: null,
            textPreview: bodyParseError,
            status: "rejected_400",
            detail: "Could not parse request body as JSON",
          })
        );
        return new Response("Bad Request", { status: 400 });
      }

      // ===== SUCCESS — log raw request, then process in background =====
      console.log(
        `[webhook] 200 — type=${updateInfo.updateType} from=${updateInfo.fromId} chat=${updateInfo.chatId} preview="${updateInfo.textPreview.slice(0, 30)}"`
      );

      // Use ctx.waitUntil so we can return 200 immediately (Telegram needs 200 within 5s)
      ctx.waitUntil(
        (async () => {
          // 1. Log the raw request (always, even on success — for the dashboard)
          await logRawRequest(SETTINGS, {
            method: request.method,
            path: url.pathname,
            hasSecret: !!secret,
            secretMatch: secretMatches,
            bodySize,
            updateType: updateInfo.updateType,
            fromId: updateInfo.fromId,
            chatId: updateInfo.chatId,
            textPreview: updateInfo.textPreview,
            status: "ok",
            detail: "processed",
          });
          // 2. Process the update
          await handleUpdate(update, env);
        })()
      );
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ============================================================
// DEBUG ROUTE HANDLER
// ============================================================
function handleDebugRoute(request, url, env) {
  const SETTINGS = env.SETTINGS;

  // Auth check (optional DEBUG_TOKEN)
  const auth = checkDebugAuth(request, env);
  if (!auth.ok) {
    return new Response("Forbidden — set ?token=XXX", { status: 403 });
  }

  // GET /debug → HTML page
  if (request.method === "GET" && url.pathname === "/debug") {
    return new Response(debugHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // GET /debug/api/ping — ultra-fast liveness check (no KV, no API calls)
  if (request.method === "GET" && url.pathname === "/debug/api/ping") {
    return json({
      ok: true,
      time: new Date().toISOString(),
      has_bot_token: !!env.BOT_TOKEN,
      has_admin_id: !!env.ADMIN_ID,
      has_kv: !!SETTINGS,
      has_webhook_secret: !!env.WEBHOOK_SECRET,
    });
  }

  // GET /debug/api/status
  if (request.method === "GET" && url.pathname === "/debug/api/status") {
    return getStatus(env, SETTINGS).then(
      (data) => json(data),
      (e) => {
        console.error("[debug] getStatus failed:", e.message);
        return json({ ok: false, error: e.message, stack: e.stack?.split("\n").slice(0, 5).join("\n") }, 500);
      }
    );
  }

  // POST /debug/api/test/message
  if (request.method === "POST" && url.pathname === "/debug/api/test/message") {
    return sendTestMessage(env).then(
      (data) => json(data),
      (e) => json({ ok: false, error: e.message }, 500)
    );
  }

  // POST /debug/api/test/kv
  if (request.method === "POST" && url.pathname === "/debug/api/test/kv") {
    return testKV(SETTINGS).then(
      (data) => json(data),
      (e) => json({ ok: false, error: e.message }, 500)
    );
  }

  // POST /debug/api/test/ai
  if (request.method === "POST" && url.pathname === "/debug/api/test/ai") {
    return testAI(env).then(
      (data) => json(data),
      (e) => json({ ok: false, error: e.message }, 500)
    );
  }

  // POST /debug/api/clear
  if (request.method === "POST" && url.pathname === "/debug/api/clear") {
    return clearDebugLogs(SETTINGS).then(
      () => json({ ok: true, msg: "Debug logs cleared" }),
      (e) => json({ ok: false, error: e.message }, 500)
    );
  }

  return new Response("Not Found", { status: 404 });
}

// ============================================================
// UPDATE HANDLER — dispatches based on update type
// ============================================================
/**
 * Extract a small summary of the update for the raw request log.
 * Used BEFORE we decide whether to accept or reject the request.
 * Returns safe defaults if the update is null/unparseable.
 */
function extractUpdateInfoForLog(update) {
  if (!update) return { updateType: "invalid", fromId: null, chatId: null, textPreview: "" };
  if (update.callback_query) {
    return {
      updateType: "callback_query",
      fromId: update.callback_query.from?.id,
      chatId: update.callback_query.message?.chat?.id,
      textPreview: update.callback_query.data || "",
    };
  }
  if (update.message) {
    return {
      updateType: "message",
      fromId: update.message.from?.id,
      chatId: update.message.chat?.id,
      textPreview: update.message.text || update.message.caption || "",
    };
  }
  if (update.channel_post) {
    return {
      updateType: "channel_post",
      fromId: update.channel_post.from?.id || update.channel_post.sender_chat?.id,
      chatId: update.channel_post.chat?.id,
      textPreview: update.channel_post.text || update.channel_post.caption || "",
    };
  }
  return { updateType: "other", fromId: null, chatId: null, textPreview: "" };
}

// ============================================================
// UPDATE HANDLER — dispatches based on update type
// ============================================================
async function handleUpdate(update, env) {
  const SETTINGS = env.SETTINGS;
  const startTime = Date.now();

  // Log every update for the debug dashboard
  console.log(`[update] type=${update.callback_query ? "callback" : update.message ? "message" : update.channel_post ? "channel_post" : "other"} from=${update.callback_query?.from?.id || update.message?.from?.id || update.channel_post?.from?.id || "?"}`);

  try {
    // 1. Callback query (admin panel button click)
    if (update.callback_query) {
      const cq = update.callback_query;
      if (!isAuthorized(env, cq.from.id)) {
        console.warn(`[update] callback unauthorized: from=${cq.from.id} (expected ADMIN_ID=${env.ADMIN_ID || "unset"})`);
        await answerCallbackQuery(env.BOT_TOKEN, cq.id, "⛔ Unauthorized");
        await logUpdate(SETTINGS, update, "unauthorized", `from=${cq.from.id} does not match ADMIN_ID=${env.ADMIN_ID || "unset"}`);
        return;
      }
      await handleCallbackQuery(env, SETTINGS, cq);
      await logUpdate(SETTINGS, update, "ok", `callback: ${cq.data}`);
      console.log(`[update] callback processed in ${Date.now() - startTime}ms`);
      return;
    }

    // 2. Message or channel post
    const content = extractContent(update);
    if (!content) {
      console.log("[update] no content extracted, skipping");
      return;
    }

    // 2.5. MEDIA GROUP HANDLING
    // If this message is part of a media group (album), buffer it and let the
    // first-arriving invocation process the whole group together.
    if (content.mediaGroupId) {
      console.log(`[update] media group detected: ${content.mediaGroupId} (item type=${content.mediaType})`);
      const handled = await handleMediaGroupUpdate(env, content, update);
      if (handled) return; // either buffered, or fully processed as a group
    }

    // 3. If it's a private message, treat as admin interaction
    if (content.chatType === "private") {
      await handlePrivateMessage(env, content, update);
      return;
    }

    // 4. If it's a channel/group post, check if channel editing is enabled
    if (content.chatType === "channel" || content.chatType === "supergroup" || content.chatType === "group") {
      const settings = await getSettings(SETTINGS, content.fromId || env.ADMIN_ID);

      // Default OFF: if channel_editing_enabled is false, do NOT touch channel posts
      if (!settings.channel_editing_enabled) {
        console.log(`[update] channel post ignored (channel_editing_enabled=false) from ${content.chatType}:${content.chatId}`);
        await logUpdate(SETTINGS, update, "ignored", "channel editing is OFF");
        return;
      }

      // Loop prevention: skip posts sent by the bot itself (e.g., when the bot
      // publishes a post to the channel, we don't want to re-process it)
      const botId = await getBotId(env);
      if (botId && content.fromId === botId) {
        console.log("[update] skipping channel post from bot itself (loop prevention)");
        await logUpdate(SETTINGS, update, "ignored", "self-post (loop prevention)");
        return;
      }

      // Channel editing is ON → edit the original post in place
      await runChannelEditPipeline(env, content, update);
      return;
    }

    console.log(`[update] unhandled chat type: ${content.chatType}`);
  } catch (e) {
    console.error("[update] unhandled error:", e.message, e.stack);
    await logError(SETTINGS, e, `handleUpdate for update type ${update.callback_query ? "callback" : "message"}`);
    await logUpdate(SETTINGS, update, "error", e.message);
  }
}

// ============================================================
// PRIVATE MESSAGE HANDLER (admin commands + posts to bot)
// ============================================================
async function handlePrivateMessage(env, content, update) {
  const SETTINGS = env.SETTINGS;

  // ---- DEBUG-FRIENDLY AUTHORIZATION ----
  // If ADMIN_ID is not configured at all, tell the user (critical misconfig).
  if (!env.ADMIN_ID) {
    console.error("[auth] ADMIN_ID is not set in env — all messages will be rejected");
    await sendMessage(
      env.BOT_TOKEN,
      content.chatId,
      [
        "⚠️ <b>Configuration Error</b>",
        "",
        "<code>ADMIN_ID</code> is not set.",
        "",
        "Fix: Cloudflare Dashboard → Workers &amp; Pages → ai-admin → Settings → Variables",
        "Add a plain-text variable <code>ADMIN_ID</code> with your Telegram user ID.",
        "",
        "Your Telegram ID: <code>" + content.fromId + "</code>",
      ].join("\n")
    );
    await logUpdate(SETTINGS, update, "error", "ADMIN_ID not set");
    return;
  }

  // Authorization check — but now we tell the user their ID so they can fix it.
  if (!isAuthorized(env, content.fromId)) {
    console.warn(`[auth] unauthorized: from=${content.fromId} expected=${env.ADMIN_ID}`);
    await sendMessage(
      env.BOT_TOKEN,
      content.chatId,
      [
        "⛔ <b>Unauthorized</b>",
        "",
        "Your Telegram ID: <code>" + content.fromId + "</code>",
        "Configured ADMIN_ID: <code>" + env.ADMIN_ID + "</code>",
        "",
        "These don't match. To fix:",
        "1. If this is your account, update <code>ADMIN_ID</code> in the Cloudflare dashboard to <code>" + content.fromId + "</code>",
        "2. If this is not your account, ignore this message — the bot is working correctly.",
      ].join("\n")
    );
    await logUpdate(SETTINGS, update, "unauthorized", `from=${content.fromId} expected=${env.ADMIN_ID}`);
    return;
  }

  const text = content.text || "";

  // Send typing indicator IMMEDIATELY so the user sees the bot is alive
  // (this is the #1 UX signal that the bot received the message)
  if (content.chatId) {
    await sendChatAction(env.BOT_TOKEN, content.chatId, "typing").catch(() => {});
  }

  // /start → admin panel
  if (/^\/start\b/i.test(text)) {
    console.log("[cmd] /start");
    await handleStart(env, SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } });
    await logUpdate(SETTINGS, update, "ok", "/start");
    return;
  }

  // /footer <text>
  if (/^\/footer\b/i.test(text)) {
    console.log("[cmd] /footer");
    const args = text.replace(/^\/footer\s*/i, "");
    await handleFooterCommand(env, SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } }, args);
    await logUpdate(SETTINGS, update, "ok", "/footer");
    return;
  }

  // /help
  if (/^\/help\b/i.test(text)) {
    console.log("[cmd] /help");
    await sendMessage(
      env.BOT_TOKEN,
      content.chatId,
      [
        `<b>AI Admin — Help</b>`,
        ``,
        `Send me any post (text, photo, video, document) and I will:`,
        `• Clean spam and attribution tags`,
        `• Preserve technical links and resources`,
        `• Optionally rewrite using AI`,
        `• Publish to <code>${env.TARGET_CHANNEL || "(not set)"}</code>`,
        ``,
        `<b>Commands:</b>`,
        `/start — Open admin panel`,
        `/footer &lt;text&gt; — Change footer text`,
        `/help — This message`,
        ``,
        `<b>Debug:</b>`,
        `Open <code>${new URL("", "").origin || "https://your-worker.workers.dev"}/debug</code> for diagnostics`,
      ].join("\n")
    );
    await logUpdate(SETTINGS, update, "ok", "/help");
    return;
  }

  // Otherwise: treat as content to process and publish
  // Pass content.chatId as feedbackChatId so the user gets the final post + status
  console.log("[cmd] content for pipeline");
  await runPipeline(env, content, content.chatId, update);
}

// ============================================================
// MEDIA GROUP HANDLER
// ============================================================
// Buffers media group items in KV. The first-arriving invocation waits ~1.5s
// for the rest of the group to arrive, then processes them all together using
// sendMediaGroup (preserves album layout in Telegram).
//
// Returns true if the update was handled (either buffered or fully processed).
// Returns false if media group handling should fall through to normal pipeline.
// ============================================================
const MEDIA_GROUP_WAIT_MS = 1500;

async function handleMediaGroupUpdate(env, content, update) {
  const SETTINGS = env.SETTINGS;
  const mgId = content.mediaGroupId;

  // Read existing items in this group
  const existing = await getMediaGroup(SETTINGS, mgId);
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

  if (existing.length === 0) {
    // FIRST item in the group — store it, wait, then process the whole group
    console.log(`[media-group] first item for ${mgId}, waiting ${MEDIA_GROUP_WAIT_MS}ms for more...`);
    await saveMediaGroup(SETTINGS, mgId, [myItem]);

    // Wait for other items to arrive
    await new Promise((r) => setTimeout(r, MEDIA_GROUP_WAIT_MS));

    // Read the full group (may have grown during the wait)
    const fullGroup = await getMediaGroup(SETTINGS, mgId);
    console.log(`[media-group] processing group ${mgId} with ${fullGroup.length} items`);

    if (fullGroup.length === 0) {
      // Race condition: another invocation already processed and deleted it
      console.log(`[media-group] group ${mgId} already processed, skipping`);
      return true;
    }

    // Process the group as a unit
    try {
      await runMediaGroupPipeline(env, fullGroup, update);
    } catch (e) {
      console.error(`[media-group] pipeline error: ${e.message}`);
      await logError(SETTINGS, e, `media group ${mgId}`);
    }

    // Cleanup
    await deleteMediaGroup(SETTINGS, mgId);
    return true;
  } else {
    // SUBSEQUENT item — just add to the buffer; the first waiter will process it
    console.log(`[media-group] adding item to existing group ${mgId} (now ${existing.length + 1} items)`);
    existing.push(myItem);
    await saveMediaGroup(SETTINGS, mgId, existing);
    return true; // Don't process this item individually
  }
}

// ============================================================
// MEDIA GROUP PIPELINE — processes a buffered album
// ============================================================
async function runMediaGroupPipeline(env, items, update) {
  const SETTINGS = env.SETTINGS;
  const adminId = items[0].fromId || env.ADMIN_ID;
  const startTime = Date.now();

  // Combine all captions into one text for processing
  // (Telegram only allows caption on the first item of a media group)
  const combinedText = items
    .map((it, i) => (it.caption ? (items.length > 1 ? `[Photo ${i + 1}]: ${it.caption}` : it.caption) : ""))
    .filter(Boolean)
    .join("\n\n");

  console.log(`[mg-pipeline] start — ${items.length} items, combined text: ${combinedText.length} chars`);

  let settings;
  try {
    settings = await getSettings(SETTINGS, adminId);
  } catch (e) {
    console.error("[mg-pipeline] KV getSettings failed:", e.message);
    return;
  }

  // Use the FIRST item's chatId for feedback (all items have the same chatId)
  const feedbackChatId = items[0].chatType === "private" ? items[0].chatId : null;

  // Send processing message
  let processingMsgId = null;
  if (feedbackChatId) {
    const procRes = await sendMessage(env.BOT_TOKEN, feedbackChatId,
      `⏳ <b>Processing album</b> (${items.length} photos)\n\n<i>Cleaning → AI rewrite → publishing...</i>`,
      { disable_web_page_preview: true }
    ).catch(() => ({ ok: false }));
    if (procRes.ok) processingMsgId = procRes.result?.message_id;
    await sendChatAction(env.BOT_TOKEN, feedbackChatId, "typing").catch(() => {});
  }

  // Process the combined text (clean → AI rewrite → format)
  const effectiveLang = settings.language_mode === "auto" ? detectLanguage(combinedText) : settings.language_mode;
  const cleanedText = cleanContent(combinedText);

  let finalText = cleanedText;
  let wasRewritten = false;
  let aiProvider = "none";
  let aiError = null;

  const decision = { content_type: "album", rewrite_mode: settings.rewrite_mode || "normal", needs_rewrite: true };
  const effectiveRewriteMode = decision.rewrite_mode || "light";
  const shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;

  if (shouldRewrite) {
    try {
      const res = await aiRewrite(env, settings, cleanedText, effectiveRewriteMode, effectiveLang, settings.personality_mode || "friendly");
      if (res.ok && res.text) {
        finalText = res.text;
        wasRewritten = true;
        aiProvider = res.provider;
        console.log(`[mg-pipeline] AI rewrite OK (${res.provider})`);
      } else {
        aiError = res.error;
        console.warn(`[mg-pipeline] AI rewrite failed: ${res.error}`);
      }
    } catch (e) {
      aiError = e.message;
      console.error(`[mg-pipeline] AI exception: ${e.message}`);
    }
  }

  // Format with footer
  const { text: formattedText, parseMode } = formatPost(finalText, {
    footer: settings.footer_text,
    engineName: "html",
  });

  // Build media items for sendMediaGroup
  // Only the first item gets the caption (Telegram API requirement)
  const mediaItems = items.map((it, i) => ({
    type: it.type,
    fileId: it.fileId,
    caption: i === 0 ? formattedText : undefined,
  }));

  // Send to user (feedback) and channel
  const targetChannel = env.TARGET_CHANNEL;
  let publishOk = false;
  let publishErr = null;

  if (feedbackChatId) {
    const userRes = await sendMediaGroup(env.BOT_TOKEN, feedbackChatId, mediaItems, {
      parse_mode: parseMode,
    });
    if (!userRes.ok) {
      console.warn(`[mg-pipeline] send to user failed: ${userRes.description}`);
    }
  }

  if (targetChannel) {
    const pubRes = await sendMediaGroup(env.BOT_TOKEN, targetChannel, mediaItems, {
      parse_mode: parseMode,
    });
    publishOk = pubRes.ok;
    publishErr = pubRes.description;
    console.log(`[mg-pipeline] publish to channel: ${publishOk ? "OK" : publishErr}`);
  } else {
    publishOk = true; // No channel configured; treat as ok
  }

  // Stats
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
    await logError(SETTINGS, new Error(`Media group publish failed: ${publishErr}`), `target=${targetChannel}`);
  }

  // Edit processing message → final status
  if (feedbackChatId && processingMsgId) {
    const totalMs = Date.now() - startTime;
    const statusLine = aiError
      ? `⚠️ AI failed — used format-only fallback`
      : `✅ AI: ${wasRewritten ? `yes (${aiProvider})` : "no (format only)"}`;
    await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
      `✅ <b>Album published</b> (${items.length} photos) → <code>${targetChannel || "(no channel)"}</code>\n${statusLine} · ${totalMs}ms`,
      { disable_web_page_preview: true }
    ).catch(() => {});
  }

  if (update) await logUpdate(SETTINGS, update, publishOk ? "ok" : "error", `media-group: ${items.length} items, AI: ${wasRewritten ? "yes" : "no"}`);
}

// ============================================================
// CONTENT PIPELINE — the heart of the system
// ============================================================
// Wrapped with a 25s hard timeout to prevent Cloudflare from killing the worker
// mid-flight (free tier wall time limit = 30s). If the pipeline doesn't finish
// in 25s, we abort and publish with format-only fallback.
const PIPELINE_TIMEOUT_MS = 25_000;

async function runPipeline(env, content, feedbackChatId = null, update = null) {
  const SETTINGS = env.SETTINGS;
  const adminId = content.fromId || env.ADMIN_ID;
  const startTime = Date.now();
  let processingMsgId = null;
  let pipelineError = null;
  let pipelineResult = null;

  // Pipeline trace log — captures each step's result for debugging
  const trace = [];
  const traceStep = (step, ok, detail = "") => {
    const entry = { step, ok: !!ok, detail: detail.slice(0, 200), ms: Date.now() - startTime };
    trace.push(entry);
    console.log(`[pipeline trace] ${step}: ${ok ? "OK" : "FAIL"}${detail ? " — " + detail.slice(0, 100) : ""} (${entry.ms}ms)`);
    return entry;
  };

  console.log(`[pipeline] start — from=${adminId} hasText=${!!content.text} hasMedia=${!!content.mediaFileId}`);

  // Send IMMEDIATE "processing" message — this happens BEFORE the timeout-protected inner pipeline
  // so the user always sees feedback, even if the inner pipeline times out.
  let settings;
  try {
    settings = await getSettings(SETTINGS, adminId);
    traceStep("getSettings", true, `provider=${settings.ai_provider} rw=${settings.rewrite_mode}`);
  } catch (e) {
    console.error("[pipeline] KV getSettings failed:", e.message);
    traceStep("getSettings", false, e.message);
    await logError(SETTINGS, e, "getSettings");
    if (feedbackChatId) {
      await sendMessage(env.BOT_TOKEN, feedbackChatId,
        `❌ <b>KV Error:</b> Cannot read settings.\n\n<code>${e.message}</code>\n\nCheck that KV namespace <code>SETTINGS</code> is bound in the dashboard.`);
    }
    if (update) await logUpdate(SETTINGS, update, "error", `KV getSettings: ${e.message}`);
    return;
  }

  const rawText = content.text || "";
  if (!rawText && !content.mediaFileId) {
    console.log("[pipeline] nothing to publish (no text, no media)");
    if (update) await logUpdate(SETTINGS, update, "ignored", "empty content");
    return;
  }

  // Send the processing message (kept OUTSIDE the timeout wrapper so it always sends)
  if (feedbackChatId) {
    const procRes = await sendMessage(env.BOT_TOKEN, feedbackChatId,
      [
        `⏳ <b>Processing your post</b>`,
        ``,
        `<blockquote>🔄 Analyzing content type...</blockquote>`,
        `<blockquote>🧹 Cleaning spam &amp; attribution...</blockquote>`,
        `<blockquote>✍️ AI rewrite (if needed)...</blockquote>`,
        `<blockquote>📝 Formatting &amp; publishing...</blockquote>`,
        ``,
        `<i>Usually takes 5-15 seconds.</i>`,
      ].join("\n"),
      { disable_web_page_preview: true }
    ).catch((e) => ({ ok: false, error: e.message }));
    if (procRes.ok) processingMsgId = procRes.result?.message_id;
    await sendChatAction(env.BOT_TOKEN, feedbackChatId, "typing").catch(() => {});
  }

  // Run the inner pipeline with a hard timeout
  const innerPromise = runPipelineInner(env, content, settings, rawText, feedbackChatId, processingMsgId, trace, traceStep, startTime);
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`PIPELINE_TIMEOUT after ${PIPELINE_TIMEOUT_MS}ms`)), PIPELINE_TIMEOUT_MS)
  );

  try {
    pipelineResult = await Promise.race([innerPromise, timeoutPromise]);
  } catch (e) {
    pipelineError = e;
    console.error(`[pipeline] ${e.message}`);
    traceStep("pipeline_aborted", false, e.message);
    await logError(SETTINGS, e, "pipeline timeout/abort");

    // Edit the processing message to show timeout error
    if (feedbackChatId && processingMsgId) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        [
          `⏱️ <b>Pipeline timed out</b>`,
          ``,
          `<blockquote>The pipeline took longer than ${PIPELINE_TIMEOUT_MS / 1000}s and was aborted.</blockquote>`,
          ``,
          `<i>This usually means the AI provider is slow. Try:</i>`,
          `• Switch to OpenRouter in the admin panel`,
          `• Set rewrite mode to "none" (format only)`,
        ].join("\n"),
        { disable_web_page_preview: true }
      ).catch(() => {});
    }
  }

  // Finally: always log the update + trace summary
  const traceSummary = trace.map(t => `${t.step}:${t.ok ? "✓" : "✗"}`).join(" → ");
  console.log(`[pipeline trace summary] ${traceSummary}`);
  if (update) {
    const status = pipelineError ? "error" : (pipelineResult?.ok ? "ok" : "error");
    const detail = pipelineError
      ? `aborted: ${pipelineError.message}`
      : pipelineResult?.detail || traceSummary;
    await logUpdate(SETTINGS, update, status, detail);
  }
}

// ============================================================
// INNER PIPELINE — the actual processing (wrapped by timeout above)
// ============================================================
async function runPipelineInner(env, content, settings, rawText, feedbackChatId, processingMsgId, trace, traceStep, startTime) {
  const SETTINGS = env.SETTINGS;
  const adminId = content.fromId || env.ADMIN_ID;

  // Determine effective language mode
  const effectiveLang = settings.language_mode === "auto" ? detectLanguage(rawText) : settings.language_mode;
  console.log(`[pipeline] lang=${effectiveLang} (settings=${settings.language_mode})`);

  // ---------- STEP 0: REPLY CONTEXT ----------
  // If the message is a reply to another message, include the original message
  // as context for the AI. This preserves reply chains.
  let replyContext = "";
  if (content.replyToMessage) {
    const orig = content.replyToMessage;
    const origText = orig.text || orig.caption || "";
    if (origText) {
      replyContext = `[Original message being replied to]\n${origText}\n\n[Reply message]\n`;
      console.log(`[pipeline] reply context: ${origText.length} chars from msg ${orig.message_id}`);
      traceStep("reply_context", true, `${origText.length} chars`);
    }
  }

  // ---------- STEP 1: CLASSIFY (rule-based only — fast, no AI) ----------
  let decision;
  let classifySource = "rules";
  try {
    const cls = await classify(env, settings, rawText);
    decision = cls.decision;
    classifySource = cls.source;
    traceStep("classify", true, `type=${decision.content_type} mode=${decision.rewrite_mode} src=${cls.source}`);
  } catch (e) {
    console.warn("[pipeline] classify failed:", e.message);
    traceStep("classify", false, e.message);
    await logError(SETTINGS, e, "classify");
    decision = { content_type: "other", rewrite_mode: "light", needs_rewrite: true, language_mode: effectiveLang };
  }

  // ---------- STEP 2: CLEAN ----------
  const cleanedText = cleanContent(rawText);
  // Include reply context in the text that goes to AI (so AI can understand the conversation)
  const textForAI = replyContext + cleanedText;
  traceStep("clean", true, `${rawText.length}→${cleanedText.length} chars${replyContext ? ` (+${replyContext.length} reply ctx)` : ""}`);

  // ---------- STEP 3: REWRITE / SUMMARIZE (or skip) ----------
  let finalText = cleanedText;
  let wasRewritten = false;
  let aiProvider = "none";
  let aiError = null;

  const effectiveRewriteMode = decision.rewrite_mode || settings.rewrite_mode || "light";
  const shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;
  console.log(`[pipeline] rewrite: mode=${effectiveRewriteMode} should=${shouldRewrite}`);

  if (shouldRewrite && decision.needs_rewrite !== false) {
    try {
      if (effectiveRewriteMode === "summary") {
        const res = await aiSummarize(env, settings, textForAI, effectiveLang);
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          aiProvider = res.provider;
          traceStep("ai_summarize", true, `provider=${res.provider} len=${res.text.length}`);
        } else {
          aiError = res.error;
          traceStep("ai_summarize", false, res.error || "unknown");
          await logError(SETTINGS, new Error(`AI summarize failed: ${res.error}`), "aiSummarize");
        }
      } else {
        const res = await aiRewrite(
          env,
          settings,
          textForAI,
          effectiveRewriteMode,
          effectiveLang,
          settings.personality_mode || "friendly"
        );
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          aiProvider = res.provider;
          traceStep("ai_rewrite", true, `provider=${res.provider} mode=${effectiveRewriteMode} len=${res.text.length}`);
        } else {
          aiError = res.error;
          traceStep("ai_rewrite", false, res.error || "unknown");
          await logError(SETTINGS, new Error(`AI rewrite failed: ${res.error}`), "aiRewrite");
        }
      }
    } catch (e) {
      console.error("[pipeline] AI step error:", e.message);
      aiError = e.message;
      traceStep("ai_exception", false, e.message);
      await logError(SETTINGS, e, "AI rewrite/summarize");
    }
  } else {
    traceStep("ai_skip", true, `mode=${effectiveRewriteMode} should=${shouldRewrite}`);
  }

  // ---------- STEP 4: FORMAT ----------
  const { text: formattedText, parseMode } = formatPost(finalText, {
    footer: settings.footer_text,
    engineName: "html",
  });
  traceStep("format", true, `${formattedText.length} chars, parseMode=${parseMode}`);

  // ---------- STEP 5: PUBLISH ----------
  const targetChannel = env.TARGET_CHANNEL;
  if (!targetChannel) {
    console.error("[pipeline] TARGET_CHANNEL not set");
    traceStep("publish", false, "TARGET_CHANNEL not set");
    if (feedbackChatId) {
      await sendMessage(env.BOT_TOKEN, feedbackChatId, "❌ <code>TARGET_CHANNEL</code> not configured.");
    }
    return { ok: false, detail: "TARGET_CHANNEL not set" };
  }

  // 5a: Send the FINAL post to the user (so they see exactly what was published)
  //     This uses the same media file_id, so media is preserved.
  let userSendOk = null;
  if (feedbackChatId) {
    console.log(`[pipeline] sending final post to user ${feedbackChatId}`);
    userSendOk = await publishToChannel(env.BOT_TOKEN, feedbackChatId, {
      text: formattedText,
      mediaType: content.mediaType,
      mediaFileId: content.mediaFileId,
      extra: { parse_mode: parseMode, disable_web_page_preview: false },
    });
    traceStep("send_to_user", userSendOk.ok, userSendOk.ok ? "ok" : userSendOk.description || "failed");
    if (!userSendOk.ok) {
      console.warn(`[pipeline] send to user failed: ${userSendOk.description}`);
      // If user send fails (e.g. HTML parse error), try sending a plain-text version
      // so at least they see SOMETHING and we can diagnose
      console.warn("[pipeline] retrying user send with plain text...");
      const plainRes = await sendMessage(env.BOT_TOKEN, feedbackChatId,
        `⚠️ <b>Formatted post failed to render (HTML parse error)</b>\n\n<b>Raw text (unformatted):</b>\n\n${escapeHtmlForTg(finalText)}`,
        { disable_web_page_preview: true }
      ).catch(e => ({ ok: false, description: e.message }));
      traceStep("send_to_user_retry", plainRes.ok, plainRes.ok ? "ok" : plainRes.description || "failed");
    }
  }

  // 5b: Publish to the target channel
  const publishRes = await publishToChannel(env.BOT_TOKEN, targetChannel, {
    text: formattedText,
    mediaType: content.mediaType,
    mediaFileId: content.mediaFileId,
    extra: { parse_mode: parseMode, disable_web_page_preview: false },
  });
  traceStep("publish_to_channel", publishRes.ok, publishRes.ok ? "ok" : publishRes.description || "failed");

  // ---------- STEP 6: STATS + FEEDBACK ----------
  if (publishRes.ok) {
    await bumpStats(SETTINGS, adminId, "processed");
    await bumpGlobalStats(SETTINGS, "processed");
    if (wasRewritten) {
      await bumpStats(SETTINGS, adminId, "rewritten");
      await bumpGlobalStats(SETTINGS, "rewritten");
    }
    console.log(`[pipeline] published OK in ${Date.now() - startTime}ms`);

    // Edit the processing message → final status (cleaner UX than sending a new message)
    const totalMs = Date.now() - startTime;
    const statusLine = aiError
      ? `⚠️ AI failed (${aiError.slice(0, 50)}) — used format-only fallback`
      : `✅ AI: ${wasRewritten ? `yes (${aiProvider})` : "no (format only)"}`;

    if (feedbackChatId && processingMsgId) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        [
          `✅ <b>Done</b> — published to <code>${targetChannel}</code>`,
          ``,
          `<blockquote><b>Type:</b> ${decision.content_type} / ${effectiveRewriteMode}`,
          `${statusLine}`,
          `<b>Total time:</b> ${totalMs}ms</blockquote>`,
        ].join("\n"),
        { disable_web_page_preview: true }
      ).catch(() => {}); // ignore edit failures (e.g. message too old)
    } else if (feedbackChatId) {
      // Fallback: send a new status message
      await sendMessage(env.BOT_TOKEN, feedbackChatId,
        `✅ <b>Published</b> to <code>${targetChannel}</code>\n${statusLine} · ${totalMs}ms`,
        { disable_web_page_preview: true }
      );
    }
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
    console.error("[pipeline] publish failed:", publishRes.description);
    await logError(SETTINGS, new Error(`Publish failed: ${publishRes.description}`), `target=${targetChannel}`);

    // Edit processing message → error status
    if (feedbackChatId && processingMsgId) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        [
          `❌ <b>Publish failed</b>`,
          ``,
          `<blockquote><b>Error:</b> ${escapeHtmlForTg(publishRes.description || "unknown")}`,
          `<b>Channel:</b> ${targetChannel}</blockquote>`,
          ``,
          `Make sure the bot is an admin in <code>${targetChannel}</code> with permission to post messages.`,
        ].join("\n"),
        { disable_web_page_preview: true }
      ).catch(() => {});
    } else if (feedbackChatId) {
      await sendMessage(env.BOT_TOKEN, feedbackChatId,
        `❌ <b>Publish failed:</b> <code>${publishRes.description || "unknown error"}</code>\n\nMake sure the bot is an admin in <code>${targetChannel}</code> with permission to post messages.`
      );
    }
  }

  // Return result so the outer wrapper knows the outcome
  return {
    ok: publishRes.ok,
    detail: `published: ${decision.content_type}/${effectiveRewriteMode}`,
  };
}

/** Minimal HTML escaper for displaying error text inside Telegram HTML messages */
function escapeHtmlForTg(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ============================================================
// CHANNEL EDIT PIPELINE — edits the original channel post in place
// ============================================================
async function runChannelEditPipeline(env, content, update) {
  const SETTINGS = env.SETTINGS;
  const adminId = env.ADMIN_ID;
  const startTime = Date.now();

  console.log(`[channel-edit] start — chat=${content.chatId} msg=${content.messageId} hasMedia=${!!content.mediaFileId}`);

  let settings;
  try {
    settings = await getSettings(SETTINGS, adminId);
  } catch (e) {
    console.error("[channel-edit] KV getSettings failed:", e.message);
    await logError(SETTINGS, e, "getSettings");
    return;
  }

  const rawText = content.text || "";
  if (!rawText && !content.mediaFileId) {
    console.log("[channel-edit] nothing to edit (no text, no media)");
    return;
  }

  const effectiveLang = settings.language_mode === "auto" ? detectLanguage(rawText) : settings.language_mode;

  // CLASSIFY
  let decision;
  try {
    const cls = await classify(env, settings, rawText);
    decision = cls.decision;
    console.log(`[channel-edit] classify: type=${decision.content_type} mode=${decision.rewrite_mode} src=${cls.source}`);
  } catch (e) {
    console.warn("[channel-edit] classify failed:", e.message);
    decision = { content_type: "other", rewrite_mode: "light", needs_rewrite: true, language_mode: effectiveLang };
  }

  // CLEAN
  const cleanedText = cleanContent(rawText);

  // REWRITE
  let finalText = cleanedText;
  let wasRewritten = false;
  const effectiveRewriteMode = decision.rewrite_mode || settings.rewrite_mode || "light";
  const shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;

  if (shouldRewrite && decision.needs_rewrite !== false) {
    try {
      if (effectiveRewriteMode === "summary") {
        const res = await aiSummarize(env, settings, cleanedText, effectiveLang);
        if (res.ok && res.text) { finalText = res.text; wasRewritten = true; }
      } else {
        const res = await aiRewrite(env, settings, cleanedText, effectiveRewriteMode, effectiveLang, settings.personality_mode || "friendly");
        if (res.ok && res.text) { finalText = res.text; wasRewritten = true; }
      }
    } catch (e) {
      console.error("[channel-edit] AI error:", e.message);
    }
  }

  // FORMAT
  const { text: formattedText, parseMode } = formatPost(finalText, {
    footer: settings.footer_text,
    engineName: "html",
  });

  // EDIT THE ORIGINAL POST IN PLACE
  let editRes;
  if (content.mediaType) {
    // Post has media → use editMessageCaption (only the caption changes)
    editRes = await editMessageCaption(env.BOT_TOKEN, content.chatId, content.messageId, formattedText, {
      parse_mode: parseMode,
    });
  } else {
    // Text-only post → use editMessageText
    editRes = await editMessageText(env.BOT_TOKEN, content.chatId, content.messageId, formattedText, {
      parse_mode: parseMode,
    });
  }

  if (editRes.ok) {
    await bumpStats(SETTINGS, adminId, "processed");
    await bumpGlobalStats(SETTINGS, "processed");
    if (wasRewritten) {
      await bumpStats(SETTINGS, adminId, "rewritten");
      await bumpGlobalStats(SETTINGS, "rewritten");
    }
    console.log(`[channel-edit] edited OK in ${Date.now() - startTime}ms`);

    // Brief notification to admin
    await sendMessage(
      env.BOT_TOKEN, adminId,
      `✏️ <b>Edited channel post</b> #${content.messageId} in <code>${content.chatId}</code>\n` +
      `<b>Type:</b> <code>${decision.content_type} / ${effectiveRewriteMode}</code> · <b>AI:</b> <code>${wasRewritten ? "yes" : "no"}</code>`,
      { disable_web_page_preview: true }
    );
    if (update) await logUpdate(SETTINGS, update, "ok", `channel-edit: ${decision.content_type}/${effectiveRewriteMode}`);
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
    console.error("[channel-edit] edit failed:", editRes.description);
    await logError(SETTINGS, new Error(`Channel edit failed: ${editRes.description}`), `chat=${content.chatId} msg=${content.messageId}`);

    // Notify admin of failure
    await sendMessage(
      env.BOT_TOKEN, adminId,
      `❌ <b>Channel edit failed:</b> <code>${editRes.description || "unknown"}</code>\n` +
      `Post #${content.messageId} in <code>${content.chatId}</code>`,
      { disable_web_page_preview: true }
    );
    if (update) await logUpdate(SETTINGS, update, "error", `channel-edit: ${editRes.description}`);
  }
}

// ============================================================
// BOT ID CACHE — used for loop prevention in channel editing
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
