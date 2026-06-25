/**
 * src/index.js
 * ILIVIR3 AI Admin — Cloudflare Worker entry point.
 *
 * Endpoints:
 *   GET  /            → health check
 *   GET  /webhook/info→ bot info + webhook status (debug)
 *   POST /webhook     → Telegram webhook (messages + callback queries)
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
        name: "ILIVIR3 AI Admin",
        version: "1.0.0",
        time: new Date().toISOString(),
      });
    }

    // ----- GET /webhook/info : debug -----
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
// UPDATE HANDLER — dispatches based on update type
// ============================================================
async function handleUpdate(update, env) {
  try {
    // 1. Callback query (admin panel button click)
    if (update.callback_query) {
      if (!isAuthorized(env, update.callback_query.from.id)) {
        await answerCallbackQuery(env.BOT_TOKEN, update.callback_query.id, "⛔ Unauthorized");
        return;
      }
      await handleCallbackQuery(env, env.SETTINGS, update.callback_query);
      return;
    }

    // 2. Message or channel post
    const content = extractContent(update);
    if (!content) return;

    // 3. If it's a private message, treat as admin interaction
    if (content.chatType === "private") {
      await handlePrivateMessage(env, content);
      return;
    }

    // 4. If it's a channel/group post, process as content pipeline
    if (content.chatType === "channel" || content.chatType === "supergroup" || content.chatType === "group") {
      await runPipeline(env, content);
      return;
    }
  } catch (e) {
    console.error("[handleUpdate] unhandled error:", e.message, e.stack);
  }
}

// ============================================================
// PRIVATE MESSAGE HANDLER (admin commands + posts to bot)
// ============================================================
async function handlePrivateMessage(env, content) {
  // Authorization check
  if (!isAuthorized(env, content.fromId)) {
    // Silent ignore — don't tell attackers the bot exists
    return;
  }

  const text = content.text || "";

  // /start → admin panel
  if (/^\/start\b/i.test(text)) {
    await handleStart(env, env.SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } });
    return;
  }

  // /footer <text>
  if (/^\/footer\b/i.test(text)) {
    const args = text.replace(/^\/footer\s*/i, "");
    await handleFooterCommand(env, env.SETTINGS, { chat: { id: content.chatId }, from: { id: content.fromId } }, args);
    return;
  }

  // /help
  if (/^\/help\b/i.test(text)) {
    await sendMessage(
      env.BOT_TOKEN,
      content.chatId,
      [
        `<b>ILIVIR3 AI Admin — Help</b>`,
        ``,
        `Send me any post (text, photo, video, document) and I will:`,
        `• Clean spam and attribution tags`,
        `• Preserve technical links and resources`,
        `• Optionally rewrite using AI`,
        `• Publish to <code>${env.TARGET_CHANNEL}</code>`,
        ``,
        `<b>Commands:</b>`,
        `/start — Open admin panel`,
        `/footer &lt;text&gt; — Change footer text`,
        `/help — This message`,
      ].join("\n")
    );
    return;
  }

  // Otherwise: treat as content to process and publish
  await runPipeline(env, content, content.chatId);
}

// ============================================================
// CONTENT PIPELINE — the heart of the system
// ============================================================
async function runPipeline(env, content, feedbackChatId = null) {
  const SETTINGS = env.SETTINGS;
  const adminId = content.fromId || env.ADMIN_ID;
  const settings = await getSettings(SETTINGS, adminId);

  const rawText = content.text || "";
  if (!rawText && !content.mediaFileId) {
    // Nothing to publish
    return;
  }

  // Determine effective language mode
  const effectiveLang = settings.language_mode === "auto" ? detectLanguage(rawText) : settings.language_mode;

  // ---------- STEP 1: CLASSIFY (on RAW text — per PROMPT 2 & 4 spec order) ----------
  // The classifier MUST see the raw text (with spam/attribution signals intact)
  // so it can detect spam vs. clean content correctly.
  let decision;
  try {
    const cls = await classify(env, settings, rawText);
    decision = cls.decision;
  } catch (e) {
    console.warn("[pipeline] classify failed, defaulting to light:", e.message);
    decision = { content_type: "other", rewrite_mode: "light", needs_rewrite: true, language_mode: effectiveLang };
  }

  // ---------- STEP 2: CLEAN (always applied, regardless of decision) ----------
  const cleanedText = cleanContent(rawText);

  // ---------- STEP 3: REWRITE / SUMMARIZE (or skip) ----------
  let finalText = cleanedText;
  let wasRewritten = false;

  // Per PROMPT 4 "CRITICAL DECISION RULE": the AI's per-content-type decision
  // takes PRECEDENCE over the admin's default `rewrite_mode` setting.
  // The admin's setting is only used as a fallback when the AI didn't decide.
  // (e.g. link list → none, tutorial → light, github → light, news → normal, long → summary)
  const effectiveRewriteMode = decision.rewrite_mode || settings.rewrite_mode || "light";
  const shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;

  if (shouldRewrite && decision.needs_rewrite !== false) {
    try {
      if (effectiveRewriteMode === "summary") {
        const res = await aiSummarize(env, settings, cleanedText, effectiveLang);
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
        } else {
          console.warn(`[pipeline] summarize failed (${res.error}); using cleaned text`);
        }
      } else {
        // "light" or "normal"
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
        } else {
          console.warn(`[pipeline] rewrite failed (${res.error}); using cleaned text`);
        }
      }
    } catch (e) {
      console.error("[pipeline] AI step error:", e.message);
      // FAIL SAFE: keep cleanedText as finalText (FORMAT_ONLY behavior)
    }
  }

  // ---------- STEP 4: FORMAT ----------
  const { text: formattedText, parseMode } = formatPost(finalText, {
    footer: settings.footer_text,
    engineName: "html",
  });

  // ---------- STEP 5: PUBLISH ----------
  const targetChannel = env.TARGET_CHANNEL;
  if (!targetChannel) {
    console.error("[pipeline] TARGET_CHANNEL not set");
    if (feedbackChatId) {
      await sendMessage(env.BOT_TOKEN, feedbackChatId, "❌ <code>TARGET_CHANNEL</code> not configured.");
    }
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
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
    console.error("[pipeline] publish failed:", publishRes.description);

    if (feedbackChatId) {
      await sendMessage(
        env.BOT_TOKEN,
        feedbackChatId,
        `❌ <b>Publish failed:</b> <code>${publishRes.description || "unknown error"}</code>\n\nMake sure the bot is an admin in <code>${targetChannel}</code>.`
      );
    }
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
