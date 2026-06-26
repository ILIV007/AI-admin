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
      `<b>AI Admin — Help</b>\n\nSend me any post and I will process and publish it.\n\nCommands:\n/start — Admin panel\n/footer &lt;text&gt; — Change footer\n/help — This message`);
    await logUpdate(SETTINGS, update, "ok", "/help");
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
  const shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;

  if (shouldRewrite) {
    try {
      const res = await aiRewrite(env, settings, cleanedText, effectiveRewriteMode, effectiveLang, settings.personality_mode || "friendly", settings.edit_intensity ?? 50, settings.emoji_level ?? 2);
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

  const { text: formattedText, parseMode } = formatPost(finalText, {
    footer: settings.footer_text, engineName: "html", intensity: settings.edit_intensity ?? 60,
  });

  const mediaItems = items.map((it, i) => ({
    type: it.type, fileId: it.fileId,
    caption: i === 0 ? formattedText : undefined,
  }));

  const targetChannel = env.TARGET_CHANNEL;
  let publishOk = false;

  if (feedbackChatId) {
    await sendMediaGroup(env.BOT_TOKEN, feedbackChatId, mediaItems, { parse_mode: parseMode });
  }

  if (targetChannel) {
    const pubRes = await sendMediaGroup(env.BOT_TOKEN, targetChannel, mediaItems, { parse_mode: parseMode });
    publishOk = pubRes.ok;
    console.log(`[mg-pipeline] publish: ${publishOk ? "OK" : pubRes.description}`);
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
    const totalMs = Date.now() - startTime;
    const statusLine = aiError
      ? `⚠️ AI failed — format-only fallback`
      : `✅ AI: ${wasRewritten ? `yes (${aiProvider})` : "no"}`;
    await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
      `✅ <b>Album published</b> (${items.length} photos) → <code>${targetChannel || "(none)"}</code>\n${statusLine} · ${totalMs}ms`,
      { disable_web_page_preview: true }).catch(() => {});
  }

  if (update) await logUpdate(SETTINGS, update, publishOk ? "ok" : "error", `media-group: ${items.length} items, AI: ${wasRewritten ? "yes" : "no"}`);
}

// ============================================================
// CONTENT PIPELINE (with 55s timeout + AbortController)
// ============================================================
const PIPELINE_TIMEOUT_MS = 55_000;

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

  const effectiveRewriteMode = decision.rewrite_mode || settings.rewrite_mode || "light";
  const intensity = settings.edit_intensity ?? 60;

  // If intensity is 0, skip AI rewrite entirely (format only)
  // If intensity is 0 AND text is long, still summarize to fit Telegram limits
  const hasMedia = !!content.mediaFileId;
  const LONG_TEXT_THRESHOLD = hasMedia ? 800 : 1200;
  let finalMode;
  if (intensity === 0) {
    // Format only — but still summarize if text is too long for Telegram
    finalMode = cleanedText.length > LONG_TEXT_THRESHOLD ? "summary" : "none";
  } else {
    // Normal: use rewrite_mode, but force summary if text is long
    finalMode = cleanedText.length > LONG_TEXT_THRESHOLD ? "summary" : effectiveRewriteMode;
  }
  const shouldRewrite = finalMode !== "none" && cleanedText.length > 0;
  console.log(`[pipeline] rewrite: mode=${finalMode} intensity=${intensity}% should=${shouldRewrite} (input ${cleanedText.length} chars${cleanedText.length > LONG_TEXT_THRESHOLD ? " → AUTO SUMMARY FORCED" : ""}${hasMedia ? " [MEDIA]" : ""})`);

  if (shouldRewrite && decision.needs_rewrite !== false) {
    try {
      if (finalMode === "summary") {
        const res = await aiSummarize(env, settings, textForAI, effectiveLang);
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          aiProvider = res.provider;
          traceStep("ai_summarize", true, `provider=${res.provider}`);
        } else {
          aiError = res.error;
          traceStep("ai_summarize", false, res.error || "unknown");
        }
      } else {
        const res = await aiRewrite(env, settings, textForAI, finalMode, effectiveLang, settings.personality_mode || "friendly", settings.edit_intensity ?? 50, settings.emoji_level ?? 2);
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

  // Format
  const { text: formattedText, parseMode } = formatPost(finalText, {
    footer: settings.footer_text, engineName: "html", intensity: settings.edit_intensity ?? 60,
  });

  // SAFETY: truncate to avoid Telegram limits.
  // IMPORTANT: Telegram has DIFFERENT limits for text vs captions:
  //   - Text message: 4096 chars
  //   - Media caption: 1024 chars
  // If the post has media, we MUST stay under 1024 or publishing will fail.
  const TELEGRAM_TEXT_LIMIT = 4000;
  const TELEGRAM_CAPTION_LIMIT = 1000; // leave room for footer + tags
  const effectiveLimit = hasMedia ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;

  let safeFormattedText = formattedText;
  if (formattedText.length > effectiveLimit) {
    console.warn(`[pipeline] formatted text too long (${formattedText.length} > ${effectiveLimit}${hasMedia ? " [CAPTION]" : ""}), truncating`);
    safeFormattedText = formattedText.slice(0, effectiveLimit - 50) + "\n\n<i>…(truncated)</i>";
    traceStep("truncate", true, `${formattedText.length}→${safeFormattedText.length} chars${hasMedia ? " [CAPTION]" : ""}`);
  }
  traceStep("format", true, `${safeFormattedText.length} chars${hasMedia ? " [CAPTION]" : ""}`);

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

  // Publish to channel
  const publishRes = await publishToChannel(env.BOT_TOKEN, targetChannel, {
    text: safeFormattedText, mediaType: content.mediaType, mediaFileId: content.mediaFileId,
    extra: { parse_mode: parseMode, disable_web_page_preview: false },
  });
  traceStep("publish_to_channel", publishRes.ok, publishRes.ok ? "ok" : publishRes.description);

  if (publishRes.ok) {
    await bumpStats(SETTINGS, adminId, "processed");
    await bumpGlobalStats(SETTINGS, "processed");
    if (wasRewritten) {
      await bumpStats(SETTINGS, adminId, "rewritten");
      await bumpGlobalStats(SETTINGS, "rewritten");
    }

    const totalMs = Date.now() - startTime;
    const statusLine = aiError
      ? `⚠️ AI failed — format-only fallback`
      : `✅ AI: ${wasRewritten ? `yes (${aiProvider})` : "no (format only)"}`;

    if (feedbackChatId && processingMsgId) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        [
          `✅ <b>Done</b> — published to <code>${targetChannel}</code>`,
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
    console.error("[pipeline] publish failed:", publishRes.description);

    if (feedbackChatId && processingMsgId) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        `❌ <b>Publish failed:</b> <code>${publishRes.description || "unknown"}</code>`,
        { disable_web_page_preview: true }).catch(() => {});
    }
    return { ok: false, detail: `publish: ${publishRes.description}` };
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
      const res = await aiRewrite(env, settings, cleanedText, effectiveRewriteMode, effectiveLang, settings.personality_mode || "friendly", settings.edit_intensity ?? 50, settings.emoji_level ?? 2);
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
