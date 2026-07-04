/**
 * src/pipeline.js
 * Content processing pipelines — v0.5.9 (TASK 7 refactor)
 *
 * Moved from src/index.js to keep index.js focused on routing/dispatch.
 *
 * Contains:
 *   - runPipeline (with timeout + AbortController)
 *   - runPipelineInner (the actual processing logic)
 *   - runMediaGroupPipeline (album processing)
 *   - runChannelEditPipeline (edit existing channel posts)
 *   - handleMediaGroupUpdate (buffer + leader election)
 *
 * v0.5.9 changes:
 *   - TASK 1: Removed ALL cron-based scheduling fallback. Native only.
 *   - TASK 5: Media group wait increased to 4000ms + safety re-check.
 *   - TASK 6: Uses closeOpenTags() / truncateHtml() from html-utils.js.
 *   - TASK 2: Detailed scheduling logs.
 */

import {
  publishToChannel,
  verifyScheduled,
  checkSchedulingPermissions,
  resolveChatId,
  sendMessage,
  editMessageText,
  editMessageCaption,
  sendChatAction,
  sendMediaGroup,
  getMe,
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
} from "./kv.js";
import { classify } from "./classifier.js";
import { cleanContent, detectLanguage, protectPrompts, restorePrompts } from "./cleaner.js";
import { formatPost } from "./formatter.js";
import { aiRewrite, aiSummarize } from "./ai.js";
import { closeOpenTags, truncateHtml } from "./html-utils.js";
import { logUpdate, logError } from "./debug.js";

// ============================================================
// BOT ID CACHE (module-level, shared across requests in same isolate)
// ============================================================
let _cachedBotId = null;
export async function getBotId(env) {
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
// MEDIA GROUP HANDLER (per-item keys + leader election)
// v0.5.9 TASK 5: Increased wait time + safety re-check
// ============================================================
// Problem: Cloudflare KV is *eventually consistent*. If Telegram sends
// album photos 100ms apart, and we wait 2500ms then list, a photo that
// arrived at 2600ms would be missed. Solution: wait 4000ms, then after
// listing, if we got >1 items, wait an ADDITIONAL 2000ms and re-list
// to catch any stragglers.
// ============================================================
const MEDIA_GROUP_WAIT_MS = 4000; // v0.5.9: was 2500, now 4000
const MEDIA_GROUP_SAFETY_WAIT_MS = 2000; // v0.5.9: extra wait if >1 item found

export async function handleMediaGroupUpdate(env, content, update) {
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

  // v0.5.9: Initial wait
  await new Promise((r) => setTimeout(r, MEDIA_GROUP_WAIT_MS));

  let fullGroup = await listMediaGroupItems(SETTINGS, mgId);
  console.log(`[media-group] ${mgId} has ${fullGroup.length} items after ${MEDIA_GROUP_WAIT_MS}ms`);

  // v0.5.9 TASK 5: Safety re-check — if we found >1 items, wait a bit more
  // in case more photos are still arriving (KV eventual consistency)
  if (fullGroup.length > 1) {
    await new Promise((r) => setTimeout(r, MEDIA_GROUP_SAFETY_WAIT_MS));
    const recheck = await listMediaGroupItems(SETTINGS, mgId);
    if (recheck.length > fullGroup.length) {
      console.log(`[media-group] safety re-check found ${recheck.length - fullGroup.length} more items (now ${recheck.length})`);
      fullGroup = recheck;
    }
  }

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
    await logError(SETTINGS, e, `media group ${mgId}`, env);
  }

  await deleteMediaGroup(SETTINGS, mgId);
}

// ============================================================
// MEDIA GROUP PIPELINE
// ============================================================
export async function runMediaGroupPipeline(env, items, update) {
  const SETTINGS = env.SETTINGS;
  const adminId = items[0].fromId || env.ADMIN_ID;
  const startTime = Date.now();

  // Combine captions — only number when MULTIPLE items have captions
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
      { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => ({ ok: false }));
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
  // v0.5.21: No auto-summary for media groups either. Only use rewrite_mode setting.
  // If caption is too long, truncateHtml will handle it (not AI summary).
  let shouldRewrite = effectiveRewriteMode !== "none" && cleanedText.length > 0;

  if (shouldRewrite) {
    try {
      const mode = effectiveRewriteMode; // v0.5.21: Never force "summary" — use user's setting
      if (mode === "summary") {
        const targetCharLimit = 800; // MG caption limit
        const res = await aiSummarize(env, settings, cleanedText, effectiveLang, targetCharLimit);
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          aiProvider = res.provider;
        } else {
          aiError = res.error;
        }
      } else {
        const res = await aiRewrite(env, settings, cleanedText, mode, effectiveLang, settings.personality_mode || "friendly", settings.edit_intensity ?? 60, settings.emoji_level ?? 20);
        if (res.ok && res.text) {
          finalText = res.text;
          wasRewritten = true;
          aiProvider = res.provider;
        } else {
          aiError = res.error;
        }
      }
    } catch (e) {
      aiError = e.message;
      console.error(`[mg-pipeline] AI exception: ${e.message}`);
    }
  }

  const { text: formattedBody, parseMode } = formatPost(finalText, {
    footer: null, engineName: "html", intensity: settings.edit_intensity ?? 60, emojiLevel: settings.emoji_level ?? 20,
  });

  // v0.5.9 TASK 6: Use safe truncateHtml for media group captions
  // v0.5.17: Same fix as runPipelineInner — skip footer if maxBodyLen too small
  const MG_LIMIT = 900;
  const footerHtml = settings.footer_text ? `\n\n<blockquote>${settings.footer_text}</blockquote>` : "";
  let maxBodyLen = MG_LIMIT - footerHtml.length - 30;
  let effectiveFooterHtml = footerHtml;
  if (maxBodyLen < 200) {
    console.warn(`[mg-pipeline] v0.5.17 ⚠️ maxBodyLen too small (${maxBodyLen})! Skipping footer.`);
    effectiveFooterHtml = "";
    maxBodyLen = MG_LIMIT - 30;
  }
  let safeBody = formattedBody;
  if (formattedBody.length > maxBodyLen) {
    console.warn(`[mg-pipeline] body too long (${formattedBody.length} > ${maxBodyLen}), safe truncating`);
    safeBody = truncateHtml(formattedBody, maxBodyLen, "\n\n<i>…</i>");
  }
  const formattedText = safeBody + effectiveFooterHtml;

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
        // v0.5.9 TASK 2: Detailed logging
        const botId = await getBotId(env);
        console.log(`[mg-sched] Step 1: Checking permissions for ${targetChannel}...`);
        const permCheck = await checkSchedulingPermissions(env.BOT_TOKEN, targetChannel, botId);
        if (!permCheck.ok) {
          console.error(`[mg-sched] ✗ Permissions failed: ${permCheck.error}`);
          scheduleError = permCheck.error;
          publishOk = false;
        } else {
          console.log(`[mg-sched] ✓ Permissions OK, calculating schedule time...`);
          let effectiveInterval = settings.schedule_interval_minutes ?? 30;
          if (settings.schedule_posts_per_day > 0) {
            effectiveInterval = Math.floor(1440 / settings.schedule_posts_per_day);
            if (effectiveInterval < 5) effectiveInterval = 5;
          }

          const lastScheduled = await getLastScheduledTime(SETTINGS, targetChannel);
          const baseTime = Date.now() + (settings.schedule_delay_hours * 3600 * 1000);
          const minNext = lastScheduled ? lastScheduled + (effectiveInterval * 60 * 1000) : 0;
          scheduledTime = Math.max(baseTime, minNext);

          const now = Date.now();
          const MIN_SCHEDULE_MS = 90 * 1000;
          const MAX_SCHEDULE_MS = 7 * 24 * 3600 * 1000;
          if (scheduledTime - now < MIN_SCHEDULE_MS) scheduledTime = now + MIN_SCHEDULE_MS;
          if (scheduledTime - now > MAX_SCHEDULE_MS) scheduledTime = now + MAX_SCHEDULE_MS;

          const scheduleDateUnix = Math.floor(scheduledTime / 1000);
          // v0.5.9 TASK 2: Log all scheduling parameters
          console.log(`[mg-sched] Step 2: schedule_date=${scheduleDateUnix} (${new Date(scheduledTime).toISOString()}), now=${Math.floor(now/1000)}, diff=${Math.floor((scheduledTime-now)/1000)}s`);

          await setLastScheduledTime(SETTINGS, targetChannel, scheduledTime);

          // v0.5.10 TASK 1: Resolve @username to numeric chat_id (CRITICAL for scheduling)
          // Telegram silently ignores schedule_date when chat_id is a @username
          console.log(`[mg-sched] Step 2.5: Resolving channel ${targetChannel} to numeric ID...`);
          const resolvedChannel = await resolveChatId(env.BOT_TOKEN, targetChannel);
          console.log(`[mg-sched] Step 2.5: Resolved → ${resolvedChannel}`);

          // v0.5.10 TASK 1: Do NOT send disable_web_page_preview with schedule_date
          // (causes Telegram to silently ignore schedule_date and send immediately)
          console.log(`[mg-sched] Step 3: Calling sendMediaGroup with schedule_date (NO disable_web_page_preview)...`);
          const schedRes = await sendMediaGroup(env.BOT_TOKEN, resolvedChannel, mediaItems, {
            parse_mode: parseMode,
            schedule_date: scheduleDateUnix,
          });

          // v0.5.9 TASK 2: Log the FULL Telegram response
          console.log(`[mg-sched] Step 4: Telegram response:`, JSON.stringify(schedRes).slice(0, 600));

          const verification = verifyScheduled(schedRes, scheduleDateUnix);
          console.log(`[mg-sched] Verification: scheduled=${verification.scheduled}, reason=${verification.reason}, diffSeconds=${verification.diffSeconds || 0}`);

          // v0.5.14: SILENT CRON FALLBACK for media groups
          if (schedRes.ok && verification.scheduled) {
            publishOk = true;
            wasScheduled = true;
            console.log(`[mg-sched] ✓ Native scheduling VERIFIED`);
          } else {
            // v0.5.15: Respect cron_fallback_enabled setting
            const cronEnabled = settings.cron_fallback_enabled !== false;
            if (!cronEnabled) {
              console.warn(`[mg-sched] ⚠️ Native failed and cron fallback is OFF. Showing error.`);
              scheduleError = verification.description || "Scheduling failed (cron disabled)";
              publishOk = false;
            } else {
              // Native failed — silently enqueue to KV cron queue
              console.warn(`[mg-sched] ⚠️ Native scheduling failed (${verification.reason}). Using SILENT cron fallback.`);
              const schedId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
              await enqueueScheduled(SETTINGS, {
                id: schedId,
                scheduledTime,
                chatId: resolvedChannel, // Use numeric chatId
                mediaGroupItems: mediaItems,
                parseMode,
                adminId,
                notifyChatId: feedbackChatId,
                createdAt: Date.now(),
              });
              publishOk = true;
              wasScheduled = true;
              console.log(`[mg-sched] ✓ Enqueued for cron fallback`);
            }
          }
        }

        // Show result message to user (always "Scheduled!" — silent fallback)
        if (feedbackChatId && processingMsgId) {
          await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
            [
              `📅 <b>Album Scheduled!</b>`,
              `📅 <b>Scheduled for:</b> ${new Date(scheduledTime).toLocaleString('en-US', { timeZone: 'UTC', hour12: false })} UTC`,
              `📸 <b>Items:</b> ${items.length}`,
              ``,
              `<i>The album will auto-publish at the scheduled time.</i>`,
            ].join("\n"),
            { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
        }
      } catch (e) {
        console.error(`[mg-sched] Exception: ${e.message}`);
        scheduleError = e.message;
        publishOk = false;
        if (feedbackChatId && processingMsgId) {
          await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
            `⚠️ <b>Scheduling exception</b>\n❌ <code>${e.message.slice(0, 200)}</code>`,
            { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
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

  if (feedbackChatId && processingMsgId && !settings.scheduling_enabled) {
    const totalMs = Date.now() - startTime;
    const statusLine = aiError
      ? `⚠️ AI failed — format-only fallback`
      : `✅ AI: ${wasRewritten ? `yes (${aiProvider})` : "no"}`;
    await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
      `✅ <b>Album published</b> (${items.length} photos) → <code>${targetChannel || "(none)"}</code>\n${statusLine} · ${totalMs}ms`,
      { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
  }

  if (update) await logUpdate(SETTINGS, update, publishOk ? "ok" : "error", `media-group: ${items.length} items, AI: ${wasRewritten ? "yes" : "no"}`, env);
}

// ============================================================
// CONTENT PIPELINE (with timeout + AbortController)
// ============================================================
const PIPELINE_TIMEOUT_MS = 90_000;

export async function runPipeline(env, content, feedbackChatId = null, update = null) {
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
    await logError(SETTINGS, e, "getSettings", env);
    if (feedbackChatId) {
      await sendMessage(env.BOT_TOKEN, feedbackChatId, `❌ <b>KV Error:</b> <code>${e.message}</code>`, { parse_mode: "HTML" });
    }
    if (update) await logUpdate(SETTINGS, update, "error", `getSettings: ${e.message}`, env);
    return;
  }

  const rawText = content.text || "";
  if (!rawText && !content.mediaFileId) {
    if (update) await logUpdate(SETTINGS, update, "ignored", "empty", env);
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
      { parse_mode: "HTML", disable_web_page_preview: true }
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
    await logError(SETTINGS, e, "pipeline timeout", env);

    if (feedbackChatId && processingMsgId) {
      await editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId,
        [
          `⏱️ <b>Pipeline timed out</b>`,
          ``,
          `<blockquote>Took longer than ${PIPELINE_TIMEOUT_MS / 1000}s.</blockquote>`,
          ``,
          `<i>Try a faster model or set rewrite to "none".</i>`,
        ].join("\n"),
        { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    }
  }

  const traceSummary = trace.map(t => `${t.step}:${t.ok ? "✓" : "✗"}`).join(" → ");
  console.log(`[pipeline] ${traceSummary}`);
  if (update) {
    const status = pipelineError ? "error" : (pipelineResult?.ok ? "ok" : "error");
    const detail = pipelineError ? `aborted: ${pipelineError.message}` : pipelineResult?.detail || traceSummary;
    await logUpdate(SETTINGS, update, status, detail, env);
  }
}

// ============================================================
// INNER PIPELINE
// ============================================================
export async function runPipelineInner(env, content, settings, rawText, feedbackChatId, processingMsgId, trace, traceStep, startTime) {
  const SETTINGS = env.SETTINGS;
  const adminId = content.fromId || env.ADMIN_ID;

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

  // v0.5.14: Protect AI image generation prompts from being destroyed by AI
  // Detects long blocks with prompt keywords (photorealistic, --ar, etc.)
  // and replaces them with placeholders before AI rewrite
  const { text: protectedText, prompts: protectedPrompts } = protectPrompts(cleanedText);
  if (protectedPrompts.length > 0) {
    console.log(`[pipeline] v0.5.14 protected ${protectedPrompts.length} AI prompt block(s) from AI rewrite`);
  }

  // v0.5.16: CRITICAL FIX — If protectedText is mostly placeholders (>80%),
  // the AI has nothing to work with and will return empty/garbage output.
  // In this case, SKIP AI rewrite entirely and use the original cleanedText.
  // v0.5.17: Changed threshold — only skip if non-placeholder text is <50 chars
  // (was 20% of original, which was too aggressive for posts with Persian intro)
  const placeholderCount = (protectedText.match(/__PROMPT_BLOCK_\d+__/g) || []).length;
  const nonPlaceholderText = protectedText.replace(/__PROMPT_BLOCK_\d+__/g, "").trim();
  const isMostlyPlaceholders = nonPlaceholderText.length < 50 && placeholderCount > 0;

  if (isMostlyPlaceholders) {
    console.log(`[pipeline] v0.5.16 ⚠️ Text is mostly prompt placeholders (${placeholderCount} blocks, only ${nonPlaceholderText.length} chars of non-prompt text). Skipping AI rewrite.`);
  }

  const textForAI = replyContext + protectedText;
  traceStep("clean", true, `${rawText.length}→${cleanedText.length} chars${protectedPrompts.length > 0 ? ` (${protectedPrompts.length} prompts protected${isMostlyPlaceholders ? ", SKIP AI" : ""})` : ""}`);

  // AI rewrite
  let finalText = cleanedText;
  let wasRewritten = false;
  let aiProvider = "none";
  let aiError = null;

  const effectiveRewriteMode = decision.rewrite_mode || settings.rewrite_mode || "normal";
  const intensity = settings.edit_intensity ?? 60;
  const emojiLevel = settings.emoji_level ?? 20;

  // v0.5.21: REMOVED auto-summarization trigger.
  // The bot should NEVER summarize on its own. It should only use "rewrite" mode.
  // Summarization will happen ONLY if the formatted text exceeds Telegram's limit
  // AND the bot gets an error from Telegram when trying to publish.
  // (See the retry-with-summary logic in the publish section below.)
  // v0.5.22: Use ACTUAL Telegram limits (not conservative estimates)
  // Telegram text limit: 4096 chars, caption limit: 1024 chars
  const hasMedia = !!content.mediaFileId;
  const TELEGRAM_TEXT_LIMIT = 4096;
  const TELEGRAM_CAPTION_LIMIT = 1024;
  const effectiveLimit = hasMedia ? TELEGRAM_CAPTION_LIMIT : TELEGRAM_TEXT_LIMIT;

  let finalMode = effectiveRewriteMode;
  // v0.5.21: Do NOT force summary based on text length. Only use the user's rewrite_mode setting.
  const shouldRewrite = finalMode !== "none" && cleanedText.length > 0 && !isMostlyPlaceholders;
  console.log(`[pipeline] rewrite: mode=${finalMode} (settings: ${effectiveRewriteMode}) intensity=${intensity}% should=${shouldRewrite} (input ${cleanedText.length} chars, limit=${effectiveLimit})`);

  if (shouldRewrite && decision.needs_rewrite !== false) {
    try {
      if (finalMode === "summary") {
        const targetCharLimit = effectiveLimit - 150;
        const res = await aiSummarize(env, settings, textForAI, effectiveLang, targetCharLimit);
        if (res.ok && res.text) {
          // v0.5.14: AI OVER-SUMMARIZATION GUARD
          // Free AI models are terrible at character counting and may shrink
          // a 3900-char post to 1000 chars. If AI output is less than 60% of
          // the original, REJECT it and use the original text instead.
          // truncateHtml will handle the slight overflow safely.
          const aiOutputLen = res.text.length;
          const originalLen = cleanedText.length;
          if (aiOutputLen < originalLen * 0.60 && originalLen <= 4500) {
            console.warn(`[pipeline] ⚠️ AI over-summarized: ${aiOutputLen} chars (was ${originalLen}). Rejecting AI output, using original.`);
            finalText = cleanedText; // Revert to original
            wasRewritten = false;
            traceStep("ai_summarize_rejected", true, `AI shrunk ${originalLen}→${aiOutputLen} (>40% loss), using original`);
          } else {
            finalText = res.text;
            wasRewritten = true;
            aiProvider = res.provider;
            traceStep("ai_summarize", true, `provider=${res.provider} ${res.text.length}chars (target=${targetCharLimit})`);
          }
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

  // v0.5.14: Restore protected AI prompt blocks AFTER AI rewrite
  // This ensures prompts are preserved exactly as-is in the final output
  if (protectedPrompts.length > 0) {
    finalText = restorePrompts(finalText, protectedPrompts);
    console.log(`[pipeline] v0.5.14 restored ${protectedPrompts.length} AI prompt block(s) after AI rewrite`);
  }

  // Format WITHOUT footer first, then truncate, then add footer.
  // Step 1: Format the body text (no footer yet)
  const { text: formattedBody, parseMode } = formatPost(finalText, {
    footer: null,
    engineName: "html",
    intensity,
    emojiLevel,
  });
  traceStep("format_body", true, `${formattedBody.length} chars`);

  // Step 2: Calculate footer
  const footerHtml = settings.footer_text
    ? `\n\n<blockquote>${settings.footer_text}</blockquote>`
    : "";
  const footerLen = footerHtml.length;
  let maxBodyLen = effectiveLimit - footerLen - 10; // v0.5.22: Minimal margin (was 50)

  // v0.5.17: If maxBodyLen is too small, skip footer
  let effectiveFooterHtml = footerHtml;
  let effectiveFooterLen = footerLen;
  if (maxBodyLen < 200) {
    console.warn(`[pipeline] v0.5.17 ⚠️ maxBodyLen too small (${maxBodyLen})! Skipping footer.`);
    effectiveFooterHtml = "";
    effectiveFooterLen = 0;
    maxBodyLen = effectiveLimit - 10;
  }

  // Step 3: v0.5.22 — SPLIT instead of truncate!
  // If text exceeds Telegram's limit, split it into multiple parts instead of
  // cutting it with "…". Each part is sent as a separate message.
  let safeBody = formattedBody;
  let extraParts = []; // v0.5.22: Additional parts to send after the main post

  if (formattedBody.length > maxBodyLen) {
    console.warn(`[pipeline] v0.5.22 body too long (${formattedBody.length} > ${maxBodyLen}), splitting into parts...`);

    // Split at paragraph boundaries first, then sentence boundaries
    let remaining = formattedBody;
    let currentPart = "";
    const partLimit = maxBodyLen - 20; // Leave room for "(ادامه...)" marker

    while (remaining.length > 0) {
      if ((currentPart + remaining).length <= partLimit) {
        currentPart += remaining;
        remaining = "";
        break;
      }

      // Find the best split point in remaining
      let splitPoint = partLimit - currentPart.length;
      if (splitPoint <= 0) splitPoint = partLimit;

      // Try paragraph boundary
      let bestSplit = remaining.lastIndexOf("\n\n", splitPoint);
      if (bestSplit < partLimit * 0.5) {
        // Try single newline
        bestSplit = remaining.lastIndexOf("\n", splitPoint);
      }
      if (bestSplit < partLimit * 0.5) {
        // Try sentence boundary
        bestSplit = Math.max(
          remaining.lastIndexOf(". ", splitPoint),
          remaining.lastIndexOf("! ", splitPoint),
          remaining.lastIndexOf("? ", splitPoint),
          remaining.lastIndexOf("۔ ", splitPoint),
        );
      }
      if (bestSplit < partLimit * 0.3) {
        // Try space (don't cut mid-word)
        bestSplit = remaining.lastIndexOf(" ", splitPoint);
      }
      if (bestSplit < 10) {
        // Last resort: hard cut
        bestSplit = splitPoint;
      }

      currentPart += remaining.slice(0, bestSplit);
      extraParts.push(currentPart);

      remaining = remaining.slice(bestSplit).trim();
      currentPart = "";
    }

    // The last currentPart (or the only part if no split was needed)
    if (currentPart.length > 0) {
      extraParts.push(currentPart);
    }

    // First part is the main post, rest go in extraParts
    if (extraParts.length > 0) {
      safeBody = extraParts.shift(); // First part
      // Add "(ادامه...)" to the main post if there are more parts
      if (extraParts.length > 0) {
        safeBody += "\n\n<i>(ادامه...)</i>";
      }
    }

    console.log(`[pipeline] v0.5.22 split into ${extraParts.length + 1} parts (main: ${safeBody.length} chars, ${extraParts.length} extra)`);
    traceStep("split_post", true, `${formattedBody.length} chars → ${extraParts.length + 1} parts`);
  }

  // Step 4: Append footer (may be empty if maxBodyLen was too small)
  let safeFormattedText = safeBody + effectiveFooterHtml;
  traceStep("format_final", true, `${safeFormattedText.length} chars (body=${safeBody.length} + footer=${effectiveFooterLen})`);

  // v0.5.16: CRITICAL SAFETY CHECK — Never send empty output
  // If formatting produced empty/near-empty text, fall back to cleanedText
  if (!safeFormattedText.trim() || safeFormattedText.trim().length < 10) {
    console.error(`[pipeline] ⚠️ formatted text is empty (${safeFormattedText.length} chars)! Falling back to cleanedText.`);
    const fallbackFormatted = formatPost(cleanedText, {
      footer: settings.footer_text, engineName: "html", intensity: 40, emojiLevel: 10,
    });
    safeBody = fallbackFormatted.text || cleanedText.slice(0, effectiveLimit - footerLen - 50);
    safeFormattedText = safeBody + footerHtml;
    traceStep("format_fallback", true, `fallback to cleanedText: ${safeFormattedText.length} chars`);
  }

  // Publish
  const targetChannel = env.TARGET_CHANNEL;
  if (!targetChannel) {
    traceStep("publish", false, "TARGET_CHANNEL not set");
    if (feedbackChatId) await sendMessage(env.BOT_TOKEN, feedbackChatId, "❌ <code>TARGET_CHANNEL</code> not configured.", { parse_mode: "HTML" });
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

  // v0.5.14: SILENT CRON FALLBACK scheduling
  // Primary: native Telegram schedule_date
  // Fallback: if native fails (verifyScheduled returns false), silently enqueue
  //           to KV cron queue. User sees "📅 Scheduled!" regardless.
  let publishRes;
  let scheduledTime = null;
  let wasScheduled = false;
  let scheduleError = null;
  let usedCronFallback = false;

  if (settings.scheduling_enabled) {
    try {
      const botId = await getBotId(env);
      console.log(`[sched] Step 1: Checking permissions for ${targetChannel}...`);
      const permCheck = await checkSchedulingPermissions(env.BOT_TOKEN, targetChannel, botId);
      if (!permCheck.ok) {
        console.error(`[sched] ✗ Permissions failed: ${permCheck.error}`);
        scheduleError = permCheck.error;
        publishRes = { ok: false, scheduled: false, scheduleError };
      } else {
        console.log(`[sched] ✓ Permissions OK, calculating schedule time...`);
        let effectiveInterval = settings.schedule_interval_minutes ?? 30;
        if (settings.schedule_posts_per_day > 0) {
          effectiveInterval = Math.floor(1440 / settings.schedule_posts_per_day);
          if (effectiveInterval < 5) effectiveInterval = 5;
        }

        const lastScheduled = await getLastScheduledTime(SETTINGS, targetChannel);
        const baseTime = Date.now() + (settings.schedule_delay_hours * 3600 * 1000);
        const minNext = lastScheduled ? lastScheduled + (effectiveInterval * 60 * 1000) : 0;
        scheduledTime = Math.max(baseTime, minNext);

        const now = Date.now();
        const MIN_SCHEDULE_MS = 90 * 1000;
        const MAX_SCHEDULE_MS = 7 * 24 * 3600 * 1000;
        if (scheduledTime - now < MIN_SCHEDULE_MS) {
          console.log(`[sched] Scheduled time too soon, bumping to 90s`);
          scheduledTime = now + MIN_SCHEDULE_MS;
        }
        if (scheduledTime - now > MAX_SCHEDULE_MS) {
          console.log(`[sched] Scheduled time too far, capping to 7 days`);
          scheduledTime = now + MAX_SCHEDULE_MS;
        }

        const scheduleDateUnix = Math.floor(scheduledTime / 1000);
        console.log(`[sched] Step 2: schedule_date=${scheduleDateUnix} (${new Date(scheduledTime).toISOString()}), now=${Math.floor(now/1000)}, diff=${Math.floor((scheduledTime-now)/1000)}s`);

        await setLastScheduledTime(SETTINGS, targetChannel, scheduledTime);

        // v0.5.10: Resolve @username to numeric chat_id
        console.log(`[sched] Step 2.5: Resolving channel ${targetChannel} to numeric ID...`);
        const resolvedChannel = await resolveChatId(env.BOT_TOKEN, targetChannel);
        console.log(`[sched] Step 2.5: Resolved → ${resolvedChannel}`);

        // v0.5.12: NO disable_web_page_preview with schedule_date
        console.log(`[sched] Step 3: Calling publishToChannel with schedule_date...`);
        publishRes = await publishToChannel(env.BOT_TOKEN, resolvedChannel, {
          text: safeFormattedText, mediaType: content.mediaType, mediaFileId: content.mediaFileId,
          extra: { parse_mode: parseMode, schedule_date: scheduleDateUnix },
        });

        console.log(`[sched] Step 4: Telegram response:`, JSON.stringify(publishRes).slice(0, 600));

        // Verify Telegram actually scheduled it
        const verification = verifyScheduled(publishRes, scheduleDateUnix);
        console.log(`[sched] Verification: scheduled=${verification.scheduled}, reason=${verification.reason}, diffSeconds=${verification.diffSeconds || 0}`);

        if (publishRes.ok && verification.scheduled) {
          wasScheduled = true;
          console.log(`[sched] ✓ Native scheduling VERIFIED`);
        } else {
          // v0.5.14: SILENT CRON FALLBACK — don't show error, just queue it
          // v0.5.15: Respect cron_fallback_enabled setting
          const cronEnabled = settings.cron_fallback_enabled !== false;
          if (!cronEnabled) {
            console.warn(`[sched] ⚠️ Native scheduling failed and cron fallback is OFF. Showing error.`);
            scheduleError = verification.description || publishRes.description || "Scheduling failed (cron fallback disabled)";
            publishRes.scheduleError = scheduleError;
            wasScheduled = false;
          } else {
            console.warn(`[sched] ⚠️ Native scheduling failed (${verification.reason}). Using SILENT cron fallback.`);
            usedCronFallback = true;

            const schedId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            await enqueueScheduled(SETTINGS, {
              id: schedId,
              scheduledTime,
              chatId: resolvedChannel, // Use numeric chatId
              text: safeFormattedText,
              mediaType: content.mediaType,
              mediaFileId: content.mediaFileId,
              parseMode,
              adminId,
              notifyChatId: feedbackChatId,
              createdAt: Date.now(),
            });
            // Tell the user it's scheduled — they don't know it's via cron
            publishRes = { ok: true, scheduled: true };
            wasScheduled = true;
            traceStep("cron_fallback", true, `id=${schedId}`);
          }
        }
      }
    } catch (e) {
      console.error(`[sched] Exception: ${e.message}`);
      scheduleError = e.message;
      publishRes = { ok: false, scheduled: false, scheduleError };
    }
  } else {
    publishRes = await publishToChannel(env.BOT_TOKEN, targetChannel, {
      text: safeFormattedText, mediaType: content.mediaType, mediaFileId: content.mediaFileId,
      extra: { parse_mode: parseMode, disable_web_page_preview: false },
    });
  }

  // v0.5.21: RETRY WITH SUMMARY — if publishing fails because the text is too long,
  // automatically summarize and retry. This is the ONLY time summarization happens.
  if (!publishRes.ok && !settings.scheduling_enabled) {
    const errDesc = (publishRes.description || "").toLowerCase();
    const isTooLongError = errDesc.includes("too long") || errDesc.includes("message is too long") || errDesc.includes("caption is too long") || errDesc.includes("400");

    if (isTooLongError && !wasRewritten) {
      console.warn(`[pipeline] v0.5.21 ⚠️ Publish failed (too long: ${safeFormattedText.length} chars). Retrying with AI summary...`);
      traceStep("retry_summary_start", false, `text too long: ${safeFormattedText.length} chars`);

      try {
        const targetCharLimit = effectiveLimit - 200;
        const summaryRes = await aiSummarize(env, settings, cleanedText, effectiveLang, targetCharLimit);
        if (summaryRes.ok && summaryRes.text) {
          // Restore prompts in the summary too
          let summaryText = summaryRes.text;
          if (protectedPrompts.length > 0) {
            summaryText = restorePrompts(summaryText, protectedPrompts);
          }

          const { text: summaryFormatted, parseMode: summaryParseMode } = formatPost(summaryText, {
            footer: settings.footer_text, engineName: "html", intensity: 40, emojiLevel: 10,
          });

          // Truncate if still too long
          let summarySafe = summaryFormatted;
          if (summaryFormatted.length > effectiveLimit - 50) {
            summarySafe = truncateHtml(summaryFormatted, effectiveLimit - 50, "\n\n<i>…</i>");
          }

          console.log(`[pipeline] v0.5.21 Summary generated: ${summarySafe.length} chars (was ${safeFormattedText.length})`);
          publishRes = await publishToChannel(env.BOT_TOKEN, targetChannel, {
            text: summarySafe, mediaType: content.mediaType, mediaFileId: content.mediaFileId,
            extra: { parse_mode: summaryParseMode, disable_web_page_preview: false },
          });

          if (publishRes.ok) {
            wasRewritten = true;
            aiProvider = summaryRes.provider;
            traceStep("retry_summary_ok", true, `summarized to ${summarySafe.length} chars`);
          } else {
            traceStep("retry_summary_fail", false, publishRes.description || "unknown");
          }
        }
      } catch (summaryErr) {
        console.error(`[pipeline] v0.5.21 Summary retry failed: ${summaryErr.message}`);
        traceStep("retry_summary_error", false, summaryErr.message);
      }
    }
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
      ? `⚠️ AI failed — format-only fallback\n   <i>Error:</i> <code>${(aiError || "").slice(0, 150)}</code>`
      : `✅ AI: ${wasRewritten ? `yes (${aiProvider})` : "no (format only)"}`;

    if (feedbackChatId && processingMsgId) {
      let headerLine, schedMsg;
      if (wasScheduled) {
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
      } else if (settings.scheduling_enabled && publishRes.scheduleError) {
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
        { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    }

    // v0.5.22: Send extra parts (if the post was split)
    if (extraParts.length > 0 && !settings.scheduling_enabled) {
      console.log(`[pipeline] v0.5.22 sending ${extraParts.length} extra part(s)...`);
      for (let i = 0; i < extraParts.length; i++) {
        const partText = extraParts[i];
        const isLast = i === extraParts.length - 1;
        // Add footer only to the last part
        const partFooter = isLast ? effectiveFooterHtml : "";
        const partText2 = partText + partFooter;

        console.log(`[pipeline] v0.5.22 sending part ${i + 2}/${extraParts.length + 1} (${partText2.length} chars)`);
        const partRes = await publishToChannel(env.BOT_TOKEN, targetChannel, {
          text: partText2, mediaType: null, mediaFileId: null,
          extra: { parse_mode: parseMode, disable_web_page_preview: false },
        }).catch((e) => ({ ok: false, description: e.message }));

        if (!partRes.ok) {
          console.error(`[pipeline] v0.5.22 part ${i + 2} failed: ${partRes.description}`);
        }
        // Small delay between parts to maintain order
        if (!isLast) await new Promise((r) => setTimeout(r, 500));
      }
      traceStep("extra_parts_sent", true, `${extraParts.length} parts`);
    }

    return { ok: true, detail: `published: ${decision.content_type}/${effectiveRewriteMode}` };
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
    const errorMsg = publishRes.scheduleError || publishRes.description || "unknown error";
    console.error("[pipeline] publish failed:", errorMsg);

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
        { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    }
    return { ok: false, detail: `publish: ${errorMsg}` };
  }
}

// ============================================================
// CHANNEL EDIT PIPELINE
// ============================================================
export async function runChannelEditPipeline(env, content, update) {
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
      { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    if (update) await logUpdate(SETTINGS, update, "ok", `channel-edit: ${decision.content_type}/${effectiveRewriteMode}`, env);
  } else {
    await bumpStats(SETTINGS, adminId, "failed");
    await bumpGlobalStats(SETTINGS, "failed");
    console.error("[channel-edit] failed:", editRes.description);
    await sendMessage(env.BOT_TOKEN, adminId,
      `❌ <b>Channel edit failed:</b> <code>${editRes.description || "unknown"}</code>`,
      { parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    if (update) await logUpdate(SETTINGS, update, "error", `channel-edit: ${editRes.description}`, env);
  }
}
