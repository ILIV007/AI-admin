/**
 * src/telegram.js
 * Telegram Bot API client — v0.5.0
 * Features: Rich text formatting (MessageEntity), streaming support, improved error handling
 */

const TG_API = (token) => `https://api.telegram.org/bot${token}`;

async function tgCall(token, method, payload = {}, signal = null) {
  const url = `${TG_API(token)}/${method}`;
  let res;
  try {
    const fetchOpts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
    if (signal) fetchOpts.signal = signal;
    res = await fetch(url, fetchOpts);
  } catch (e) {
    if (e.name === "AbortError") throw new Error("REQUEST_ABORTED");
    throw new Error(`TG_NETWORK_ERROR: ${e.message}`);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error_code: res.status, description: "Invalid JSON from Telegram" };
  }
  return data;
}

export async function sendMessage(token, chatId, text, extra = {}, signal = null) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: extra.parse_mode ?? "HTML",
    disable_web_page_preview: extra.disable_web_page_preview ?? false,
    reply_markup: extra.reply_markup,
    reply_to_message_id: extra.reply_to_message_id,
    ...(extra.entities ? { entities: extra.entities } : {}),
    ...(extra.link_preview_options ? { link_preview_options: extra.link_preview_options } : {}),
  }, signal);
}

export async function sendPhoto(token, chatId, fileId, caption, extra = {}, signal = null) {
  return tgCall(token, "sendPhoto", {
    chat_id: chatId, photo: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
    ...(extra.entities ? { caption_entities: extra.entities } : {}),
  }, signal);
}

export async function sendVideo(token, chatId, fileId, caption, extra = {}, signal = null) {
  return tgCall(token, "sendVideo", {
    chat_id: chatId, video: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
    ...(extra.entities ? { caption_entities: extra.entities } : {}),
  }, signal);
}

export async function sendDocument(token, chatId, fileId, caption, extra = {}, signal = null) {
  return tgCall(token, "sendDocument", {
    chat_id: chatId, document: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
    ...(extra.entities ? { caption_entities: extra.entities } : {}),
  }, signal);
}

export async function sendAnimation(token, chatId, fileId, caption, extra = {}, signal = null) {
  return tgCall(token, "sendAnimation", {
    chat_id: chatId, animation: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
    ...(extra.entities ? { caption_entities: extra.entities } : {}),
  }, signal);
}

export async function sendMediaGroup(token, chatId, mediaItems, extra = {}, signal = null) {
  const media = mediaItems.map((item, i) => {
    const m = { type: item.type, media: item.fileId };
    if (i === 0 && item.caption) {
      m.caption = item.caption;
      m.parse_mode = extra.parse_mode ?? "HTML";
      if (extra.entities) m.caption_entities = extra.entities;
    }
    return m;
  });
  return tgCall(token, "sendMediaGroup", {
    chat_id: chatId, media,
    reply_markup: extra.reply_markup,
    disable_notification: extra.disable_notification,
  }, signal);
}

export async function editMessageText(token, chatId, messageId, text, extra = {}, signal = null) {
  return tgCall(token, "editMessageText", {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
    link_preview_options: extra.link_preview_options,
    ...(extra.entities ? { entities: extra.entities } : {}),
  }, signal);
}

export async function editMessageReplyMarkup(token, chatId, messageId, replyMarkup, signal = null) {
  return tgCall(token, "editMessageReplyMarkup", {
    chat_id: chatId, message_id: messageId, reply_markup: replyMarkup,
  }, signal);
}

export async function editMessageCaption(token, chatId, messageId, caption, extra = {}, signal = null) {
  return tgCall(token, "editMessageCaption", {
    chat_id: chatId, message_id: messageId, caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
    ...(extra.entities ? { caption_entities: extra.entities } : {}),
  }, signal);
}

export async function answerCallbackQuery(token, callbackQueryId, text = null, showAlert = false, signal = null) {
  return tgCall(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? undefined,
    show_alert: showAlert,
  }, signal);
}

export async function sendChatAction(token, chatId, action = "typing", signal = null) {
  return tgCall(token, "sendChatAction", { chat_id: chatId, action }, signal);
}

export async function setWebhook(token, url, secretToken, signal = null) {
  return tgCall(token, "setWebhook", {
    url, secret_token: secretToken,
    allowed_updates: ["message", "callback_query", "channel_post", "edited_channel_post"],
    drop_pending_updates: true,
  }, signal);
}

export async function deleteWebhook(token, signal = null) {
  return tgCall(token, "deleteWebhook", { drop_pending_updates: true }, signal);
}

export async function getMe(token, signal = null) {
  return tgCall(token, "getMe", {}, signal);
}

// ============================================================
// CONTENT EXTRACTOR — Enhanced with rich text entity support
// ============================================================
export function extractContent(update) {
  const msg = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
  if (!msg) return null;

  let text = msg.text || msg.caption || "";
  const entities = msg.entities || msg.caption_entities || [];

  // Convert text_link entities to markdown-style [text](url)
  const textLinks = entities.filter((e) => e.type === "text_link" && e.url).sort((a, b) => b.offset - a.offset);
  for (const ent of textLinks) {
    const start = ent.offset;
    const end = ent.offset + ent.length;
    const linkText = text.slice(start, end);
    text = text.slice(0, start) + `[${linkText}](${ent.url})` + text.slice(end);
  }

  const result = {
    chatId: msg.chat?.id,
    chatType: msg.chat?.type,
    fromId: msg.from?.id,
    messageId: msg.message_id,
    date: msg.date,
    text: text,
    mediaType: null,
    mediaFileId: null,
    mediaGroupId: msg.media_group_id || null,
    replyToMessage: msg.reply_to_message || null,
    entities: entities,
    textLinkUrls: textLinks.map((e) => e.url),
    raw: msg,
  };

  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    result.mediaType = "photo";
    result.mediaFileId = largest.file_id;
  } else if (msg.video) {
    result.mediaType = "video";
    result.mediaFileId = msg.video.file_id;
  } else if (msg.document) {
    result.mediaType = "document";
    result.mediaFileId = msg.document.file_id;
  } else if (msg.animation) {
    result.mediaType = "animation";
    result.mediaFileId = msg.animation.file_id;
  }

  return result;
}

export async function publishToChannel(token, channel, post, signal = null) {
  const { text, mediaType, mediaFileId, extra = {} } = post;

  if (!mediaType || !mediaFileId) {
    return sendMessage(token, channel, text, extra, signal);
  }

  switch (mediaType) {
    case "photo":
      return sendPhoto(token, channel, mediaFileId, text, extra, signal);
    case "video":
      return sendVideo(token, channel, mediaFileId, text, extra, signal);
    case "document":
      return sendDocument(token, channel, mediaFileId, text, extra, signal);
    case "animation":
      return sendAnimation(token, channel, mediaFileId, text, extra, signal);
    default:
      return sendMessage(token, channel, text, extra, signal);
  }
}

// ============================================================
// RICH FORMATTING: Build MessageEntity array for structured output
// v0.5.0: Support for headings, expandable blockquotes, tables, etc.
// ============================================================

/**
 * Build a MessageEntity array from structured content.
 * This is the modern way to format Telegram messages (Bot API 9.3+)
 * instead of HTML/Markdown parse_mode.
 */
export function buildMessageEntities(text) {
  const entities = [];
  // This is a placeholder for future rich entity building.
  // For now, we use HTML parse_mode which is fully supported.
  // In v0.6.0, we can migrate to MessageEntity-based formatting.
  return entities;
}

/**
 * Detect if client supports rich formatting (Desktop 6.9+)
 * For now, always return false and use HTML fallback.
 */
export function supportsRichFormatting(clientInfo) {
  // Future: check client version from getChat or message metadata
  return false;
}
