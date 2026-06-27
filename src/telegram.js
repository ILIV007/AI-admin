/**
 * src/telegram.js
 * Thin Telegram Bot API client for Cloudflare Workers.
 */

const TG_API = (token) => `https://api.telegram.org/bot${token}`;

async function tgCall(token, method, payload = {}) {
  const url = `${TG_API(token)}/${method}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
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

export async function sendMessage(token, chatId, text, extra = {}) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: extra.parse_mode ?? "HTML",
    disable_web_page_preview: extra.disable_web_page_preview ?? false,
    reply_markup: extra.reply_markup,
    reply_to_message_id: extra.reply_to_message_id,
  });
}

export async function sendPhoto(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendPhoto", {
    chat_id: chatId, photo: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
  });
}

export async function sendVideo(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendVideo", {
    chat_id: chatId, video: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
  });
}

export async function sendDocument(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendDocument", {
    chat_id: chatId, document: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
  });
}

export async function sendAnimation(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendAnimation", {
    chat_id: chatId, animation: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
  });
}

export async function sendMediaGroup(token, chatId, mediaItems, extra = {}) {
  const media = mediaItems.map((item, i) => {
    const m = { type: item.type, media: item.fileId };
    if (i === 0 && item.caption) {
      m.caption = item.caption;
      m.parse_mode = extra.parse_mode ?? "HTML";
    }
    return m;
  });
  return tgCall(token, "sendMediaGroup", {
    chat_id: chatId, media,
    reply_markup: extra.reply_markup,
    disable_notification: extra.disable_notification,
  });
}

export async function editMessageText(token, chatId, messageId, text, extra = {}) {
  return tgCall(token, "editMessageText", {
    chat_id: chatId, message_id: messageId, text,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
  });
}

export async function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return tgCall(token, "editMessageReplyMarkup", {
    chat_id: chatId, message_id: messageId, reply_markup: replyMarkup,
  });
}

export async function editMessageCaption(token, chatId, messageId, caption, extra = {}) {
  return tgCall(token, "editMessageCaption", {
    chat_id: chatId, message_id: messageId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
  });
}

export async function answerCallbackQuery(token, callbackQueryId, text = null, showAlert = false) {
  return tgCall(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? undefined,
    show_alert: showAlert,
  });
}

export async function sendChatAction(token, chatId, action = "typing") {
  return tgCall(token, "sendChatAction", { chat_id: chatId, action });
}

export async function setWebhook(token, url, secretToken) {
  return tgCall(token, "setWebhook", {
    url, secret_token: secretToken,
    allowed_updates: ["message", "callback_query", "channel_post"],
    drop_pending_updates: true,
  });
}

export async function deleteWebhook(token) {
  return tgCall(token, "deleteWebhook", { drop_pending_updates: true });
}

export async function getMe(token) {
  return tgCall(token, "getMe");
}

export function extractContent(update) {
  const msg = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
  if (!msg) return null;

  let text = msg.text || msg.caption || "";
  const entities = msg.entities || msg.caption_entities || [];

  // Convert "text_link" entities (clickable text hiding a URL) into markdown-style [text](url).
  // This preserves the clickable text AND the URL. The formatter will convert these
  // to proper HTML <a> tags or blockquotes.
  // We process entities in REVERSE order (highest offset first) so offsets don't shift.
  const textLinks = entities.filter((e) => e.type === "text_link" && e.url).sort((a, b) => b.offset - a.offset);
  for (const ent of textLinks) {
    const start = ent.offset;
    const end = ent.offset + ent.length;
    const linkText = text.slice(start, end);
    // Replace the clickable text with [text](url) markdown format
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
    textLinkUrls: textLinkUrls, // explicit list for debugging
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

export async function publishToChannel(token, channel, post) {
  const { text, mediaType, mediaFileId, extra = {} } = post;

  if (!mediaType || !mediaFileId) {
    return sendMessage(token, channel, text, extra);
  }

  switch (mediaType) {
    case "photo":
      return sendPhoto(token, channel, mediaFileId, text, extra);
    case "video":
      return sendVideo(token, channel, mediaFileId, text, extra);
    case "document":
      return sendDocument(token, channel, mediaFileId, text, extra);
    case "animation":
      return sendAnimation(token, channel, mediaFileId, text, extra);
    default:
      return sendMessage(token, channel, text, extra);
  }
}
