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
} from "./telegram.js";
import { getSettings, bumpStats, bumpGlobalStats } from "./kv.js";
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
      // Optional: verify Telegram's secret token header
      if (env.WEBHOOK_SECRET) {
        const secret = request.headers.get("x-telegram-bot-api-secret-token");
        if (secret !== env.WEBHOOK_SECRET) {
          console.warn("[webhook] 403 — secret token mismatch");
          return new Response("Forbidden", { status: 403 });
        }
      }

      let update;
      try {
        update = await request.json();
      } catch {
        return new Response("Bad Request", { status: 400 });
      }

      // Handle in the background so we can return 200 quickly
      // (Telegram requires 200 within 5s or it retries)
      ctx.waitUntil(handleUpdate(update, env));
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

  // GET /debug/api/status
  if (request.method === "GET" && url.pathname === "/debug/api/status") {
    return getStatus(env, SETTINGS).then(
      (data) => json(data),
      (e) => json({ ok: false, error: e.message }, 500)
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

    // 3. If it's a private message, treat as admin interaction
    if (content.chatType === "private") {
      await handlePrivateMessage(env, content, update);
      return;
    }

    // 4. If it's a channel/group post, process as content pipeline
    if (content.chatType === "channel" || content.chatType === "supergroup" || content.chatType === "group") {
      await runPipeline(env, content, update);
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
  console.log("[cmd] content for pipeline");
  await runPipeline(env, content, null, update);
}

// ============================================================
// CONTENT PIPELINE — the heart of the system
// ============================================================
async function runPipeline(env, content, feedbackChatId = null, update = null) {
  const SETTINGS = env.SETTINGS;
  const adminId = content.fromId || env.ADMIN_ID;
  const startTime = Date.now();

  console.log(`[pipeline] start — from=${adminId} hasText=${!!content.text} hasMedia=${!!content.mediaFileId}`);

  let settings;
  try {
    settings = await getSettings(SETTINGS, adminId);
  } catch (e) {
    console.error("[pipeline] KV getSettings failed:", e.message);
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

  // Determine effective language mode
  const effectiveLang = settings.language_mode === "auto" ? detectLanguage(rawText) : settings.language_mode;
  console.log(`[pipeline] lang=${effectiveLang} (settings=${settings.language_mode})`);

  // ---------- STEP 1: CLASSIFY ----------
  let decision;
  try {
    const cls = await classify(env, settings, rawText);
    decision = cls.decision;
    console.log(`[pipeline] classify: type=${decision.content_type} mode=${decision.rewrite_mode} needs=${decision.needs_rewrite} src=${cls.source}`);
  } catch (e) {
    console.warn("[pipeline] classify failed:", e.message);
    await logError(SETTINGS, e, "classify");
    decision = { content_type: "other", rewrite_mode: "light", needs_rewrite: true, language_mode: effectiveLang };
  }

  // ---------- STEP 2: CLEAN ----------
  const cleanedText = cleanContent(rawText);
  console.log(`[pipeline] clean: ${rawText.length}→${cleanedText.length} chars`);

  // ---------- STEP 3: REWRITE / SUMMARIZE (or skip) ----------
  let finalText = cleanedText;
  let wasRewritten = false;

  const effectiveRewriteMode = decision.rewrite_mode || settings.rewrite_mode || "light";
  const shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;
  console.log(`[pipeline] rewrite: mode=${effectiveRewriteMode} should=${shouldRewrite}`);

  if (shouldRewrite && decision.needs_rewrite !== false) {
    try {
      if (effectiveRewriteMode === "summary") {
        const res = await aiSummarize(env, settings, cleanedText, effectiveLang);
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          console.log(`[pipeline] summarize OK (${res.provider})`);
        } else {
          console.warn(`[pipeline] summarize failed: ${res.error}`);
        }
      } else {
        const res = await aiRewrite(
          env,
          settings,
          cleanedText,
          effectiveRewriteMode,
          effectiveLang,
          settings.personality_mode || "friendly"
        );
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          console.log(`[pipeline] rewrite OK (${res.provider})`);
        } else {
          console.warn(`[pipeline] rewrite failed: ${res.error}`);
        }
      }
    } catch (e) {
      console.error("[pipeline] AI step error:", e.message);
      await logError(SETTINGS, e, "AI rewrite/summarize");
    }
  }

  // ---------- STEP 4: FORMAT ----------
  const { text: formattedText, parseMode } = formatPost(finalText, {
    footer: settings.footer_text,
    engineName: "html",
  });
  console.log(`[pipeline] format: ${formattedText.length} chars`);

  // ---------- STEP 5: PUBLISH ----------
  const targetChannel = env.TARGET_CHANNEL;
  if (!targetChannel) {
    console.error("[pipeline] TARGET_CHANNEL not set");
    if (feedbackChatId) {
      await sendMessage(env.BOT_TOKEN, feedbackChatId, "❌ <code>TARGET_CHANNEL</code> not configured.");
    }
    if (update) await logUpdate(SETTINGS, update, "error", "TARGET_CHANNEL not set");
    return;
  }

  const publishRes = await publishToChannel(env.BOT_TOKEN, targetChannel, {
    text: formattedText,
    mediaType: content.mediaType,
    mediaFileId: content.mediaFileId,
    extra: { parse_mode: parseMode, disable_web_page_preview: false },
  });

  // ---------- STEP 6: STATS + FEEDBACK ----------
  if (publishRes.ok) {
    await bumpStats(SETTINGS, adminId, "processed");
    await bumpGlobalStats(SETTINGS, "processed");
    if (wasRewritten) {
      await bumpStats(SETTINGS, adminId, "rewritten");
      await bumpGlobalStats(SETTINGS, "rewritten");
    }
    console.log(`[pipeline] published OK in ${Date.now() - startTime}ms`);

    if (feedbackChatId) {
      const preview = finalText.length > 200 ? finalText.slice(0, 200) + "…" : finalText;
      await sendMessage(
        env.BOT_TOKEN,
        feedbackChatId,
        [
          `✅ <b>Published</b> to <code>${targetChannel}</code>`,
          ``,
          `<b>Decision:</b> <code>${decision.content_type} / ${effectiveRewriteMode}</code>`,
          `<b>AI used:</b> <code>${wasRewritten ? "yes" : "no (format only)"}</code>`,
          `<b>Preview:</b>`,
          preview,
        ].join("\n"),
        { disable_web_page_preview: true }
      );
    }
    if (update) await logUpdate(SETTINGS, update, "ok", `published: ${decision.content_type}/${effectiveRewriteMode}`);
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
    console.error("[pipeline] publish failed:", publishRes.description);
    await logError(SETTINGS, new Error(`Publish failed: ${publishRes.description}`), `target=${targetChannel}`);

    if (feedbackChatId) {
      await sendMessage(
        env.BOT_TOKEN,
        feedbackChatId,
        `❌ <b>Publish failed:</b> <code>${publishRes.description || "unknown error"}</code>\n\nMake sure the bot is an admin in <code>${targetChannel}</code> with permission to post messages.`
      );
    }
    if (update) await logUpdate(SETTINGS, update, "error", `publish: ${publishRes.description}`);
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
