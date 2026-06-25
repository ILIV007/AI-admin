/**
 * src/telegram.js
 * Thin Telegram Bot API client for Cloudflare Workers.
 * Uses native fetch — no external deps.
 *
 * All methods throw on network errors but NEVER throw on Telegram API errors;
 * they return `{ ok, error_code, description }` so the caller can decide.
 */

const TG_API = (token) => `https://api.telegram.org/bot${token}`;

/** Generic Telegram API call */
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
    // Network failure (DNS, TCP, etc.) — bubble up so caller can fallback.
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

/** Send a text message (HTML parse mode by default) */
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

/** Send a photo by file_id (re-use, never re-upload) */
export async function sendPhoto(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendPhoto", {
    chat_id: chatId,
    photo: fileId,
    caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
  });
}

/** Send a video by file_id */
export async function sendVideo(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendVideo", {
    chat_id: chatId,
    video: fileId,
    caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
  });
}

/** Send a document by file_id */
export async function sendDocument(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendDocument", {
    chat_id: chatId,
    document: fileId,
    caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
  });
}

/** Send an animation (GIF) by file_id */
export async function sendAnimation(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendAnimation", {
    chat_id: chatId,
    animation: fileId,
    caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
  });
}

/** Edit message text (used by admin panel inline menus) */
export async function editMessageText(token, chatId, messageId, text, extra = {}) {
  return tgCall(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
  });
}

/** Edit reply markup only (swap buttons without re-rendering text) */
export async function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return tgCall(token, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

/** Answer a callback query (removes the "loading" spinner on the button) */
export async function answerCallbackQuery(token, callbackQueryId, text = null, showAlert = false) {
  return tgCall(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text ?? undefined,
    show_alert: showAlert,
  });
}

/** Edit the caption of a message (used for channel post editing when media is present) */
export async function editMessageCaption(token, chatId, messageId, caption, extra = {}) {
  return tgCall(token, "editMessageCaption", {
    chat_id: chatId,
    message_id: messageId,
    caption,
    parse_mode: extra.parse_mode ?? "HTML",
    reply_markup: extra.reply_markup,
  });
}

/** Set the webhook URL */
export async function setWebhook(token, url, secretToken) {
  return tgCall(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query", "channel_post"],
    drop_pending_updates: true,
  });
}

/** Delete the webhook (switch back to long-polling) */
export async function deleteWebhook(token) {
  return tgCall(token, "deleteWebhook", { drop_pending_updates: true });
}

/** Get bot info (id, username, etc.) */
export async function getMe(token) {
  return tgCall(token, "getMe");
}

/**
 * Extract the textual content + media info from a Telegram update object.
 * Supports both private messages and channel posts.
 */
export function extractContent(update) {
  const msg = update.message || update.channel_post || update.edited_message || update.edited_channel_post;
  if (!msg) return null;

  const result = {
    chatId: msg.chat?.id,
    chatType: msg.chat?.type, // "private" | "group" | "supergroup" | "channel"
    fromId: msg.from?.id,
    messageId: msg.message_id,
    date: msg.date,
    text: msg.text || msg.caption || "",
    mediaType: null,
    mediaFileId: null,
    entities: msg.entities || msg.caption_entities || [],
    raw: msg,
  };

  // Detect media type and capture file_id (we never re-upload, just reuse)
  if (msg.photo && msg.photo.length > 0) {
    // photo is an array of sizes; pick the largest
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

/**
 * Send the final processed post to the target channel,
 * preserving the original media file_id.
 */
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
