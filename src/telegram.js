/**
 * src/telegram.js
 * Thin Telegram Bot API client for Cloudflare Workers.
 */

const TG_API = (token) => `https://api.telegram.org/bot${token}`;

async function tgCall(token, method, payload = {}) {
  // Remove undefined/null values — Telegram API rejects them
  const cleanPayload = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) {
      cleanPayload[key] = value;
    }
  }

  const url = `${TG_API(token)}/${method}`;
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanPayload),
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
    schedule_date: extra.schedule_date,
  });
}

export async function sendPhoto(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendPhoto", {
    chat_id: chatId, photo: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
    schedule_date: extra.schedule_date,
  });
}

export async function sendVideo(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendVideo", {
    chat_id: chatId, video: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
    schedule_date: extra.schedule_date,
  });
}

export async function sendDocument(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendDocument", {
    chat_id: chatId, document: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
    schedule_date: extra.schedule_date,
  });
}

export async function sendAnimation(token, chatId, fileId, caption, extra = {}) {
  return tgCall(token, "sendAnimation", {
    chat_id: chatId, animation: fileId, caption,
    parse_mode: extra.parse_mode ?? "HTML", reply_markup: extra.reply_markup,
    schedule_date: extra.schedule_date,
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
    schedule_date: extra.schedule_date,
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

// v0.5.8: Get chat info (channel type, permissions, etc.)
export async function getChat(token, chatId) {
  return tgCall(token, "getChat", { chat_id: chatId });
}

// v0.5.8: Get a member's info (status, permissions)
export async function getChatMember(token, chatId, userId) {
  return tgCall(token, "getChatMember", { chat_id: chatId, user_id: userId });
}

// ============================================================
// v0.5.8: Check if the bot has permission to schedule messages in a channel
// ============================================================
// Telegram's `schedule_date` parameter requires:
//   1. Bot must be an administrator in the channel (status = "administrator" or "creator")
//   2. Bot must have `can_post_messages = true` permission
//
// If either is missing, Telegram silently sends the message immediately
// instead of scheduling it. This is the root cause of the scheduling bug
// where posts appeared in the channel instantly despite schedule_date being set.
// ============================================================
export async function checkSchedulingPermissions(token, channel, botId) {
  if (!botId) {
    const me = await getMe(token);
    if (!me.ok) return { ok: false, error: `Cannot identify bot: ${me.description || "getMe failed"}` };
    botId = me.result.id;
  }

  const member = await getChatMember(token, channel, botId);
  if (!member.ok) {
    return {
      ok: false,
      error: `Cannot check bot permissions: ${member.description || "getChatMember failed"}`,
      details: member,
    };
  }

  const status = member.result.status;
  if (status !== "administrator" && status !== "creator") {
    return {
      ok: false,
      error: `Bot is "${status}" (not admin). Bot must be promoted to admin with 'Post Messages' permission in the channel.`,
      status,
      canPostMessages: false,
    };
  }

  // For "creator", all permissions are implied
  if (status === "creator") {
    return { ok: true, status, canPostMessages: true };
  }

  // For "administrator", check can_post_messages
  const canPost = member.result.can_post_messages === true;
  if (!canPost) {
    return {
      ok: false,
      error: `Bot is admin but does NOT have 'Post Messages' permission. Please edit the bot's admin permissions in the channel and enable 'Post Messages'.`,
      status,
      canPostMessages: false,
      rawPermissions: {
        can_post_messages: member.result.can_post_messages,
        can_edit_messages: member.result.can_edit_messages,
        can_delete_messages: member.result.can_delete_messages,
        can_promote_members: member.result.can_promote_members,
        can_restrict_members: member.result.can_restrict_members,
        can_invite_users: member.result.can_invite_users,
        can_change_info: member.result.can_change_info,
        can_pin_messages: member.result.can_pin_messages,
        can_manage_chat: member.result.can_manage_chat,
      },
    };
  }

  return { ok: true, status, canPostMessages: true };
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
    textLinkUrls: textLinks.map((e) => e.url), // explicit list for debugging
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

// ============================================================
// v0.5.6: Verify Telegram actually scheduled the message
// ============================================================
// Telegram's `schedule_date` parameter has several silent failure modes:
//   1. If schedule_date < 60s in the future, Telegram returns 400 "schedule_date is too short"
//   2. If the bot lacks admin rights, Telegram returns 400 "CHAT_ADMIN_REQUIRED"
//   3. In some edge cases (e.g., supergroups with restricted permissions), Telegram
//      may return ok:true but send the message IMMEDIATELY instead of at the
//      scheduled time. The result.date field reveals this: it will be ~NOW
//      instead of the requested schedule_date.
//
// This helper compares result.date with the requested schedule_date. If they
// differ by more than 5 seconds, the message was sent immediately (NOT scheduled).
// ============================================================
export function verifyScheduled(response, scheduleDateUnix) {
  if (!response || !response.ok || !response.result) {
    return { scheduled: false, reason: "response_not_ok", description: response?.description || "no result" };
  }

  // v0.5.8: For sendMediaGroup, result is an array — check the first message
  const result = Array.isArray(response.result) ? response.result[0] : response.result;
  if (!result) {
    return { scheduled: false, reason: "no_result", description: "Empty result array" };
  }

  const actualDate = result.date;
  if (typeof actualDate !== "number") {
    // No date field — can't verify, assume scheduled
    return { scheduled: true, reason: "no_date_field", actualDate: null };
  }

  const diff = Math.abs(actualDate - scheduleDateUnix);
  if (diff <= 5) {
    // result.date matches schedule_date (within 5s tolerance) — properly scheduled
    return { scheduled: true, reason: "verified", actualDate };
  }

  // result.date does NOT match schedule_date — Telegram sent it immediately
  return {
    scheduled: false,
    reason: "date_mismatch",
    actualDate,
    expectedDate: scheduleDateUnix,
    diffSeconds: diff,
    description: `Telegram returned ok:true but result.date (${actualDate}) != schedule_date (${scheduleDateUnix}), diff=${diff}s — message was sent immediately, NOT scheduled. Bot may lack 'Post Messages' permission.`,
  };
}
