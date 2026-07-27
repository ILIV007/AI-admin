/**
 * src/telegram/updates.ts
 * -----------------------------------------------------------------------------
 * Update parsing + content extraction.
 *
 * The bot may receive updates from:
 *   - private chats (admin DMs)
 *   - groups/supergroups (admin discussions)
 *   - channels (when the bot is an admin in the source channel)
 *   - edited versions of any of the above
 *   - callback_query (inline button taps from admin previews)
 *
 * For channel posts, the sender may be the channel itself (`sender_chat`) when
 * "Sign messages" is OFF; in that case `from` is absent and we fall back to
 * `sender_chat.id`. This matters for the audit trail / stats attribution.
 * -----------------------------------------------------------------------------
 */

import type {
  TelegramUpdate,
  TelegramMessage,
  TelegramEntity,
  ExtractedContent,
} from "../types";

// ============================================================
// Update type detection
// ============================================================

/** Top-level keys that hold a message-like object. */
const MESSAGE_KEYS = [
  "message",
  "edited_message",
  "channel_post",
  "edited_channel_post",
] as const;
type MessageKey = (typeof MESSAGE_KEYS)[number];

/**
 * Classify an update by which top-level field is present.
 * Priority follows the order Telegram sends them; in practice only one is set.
 */
export function isUpdateType(update: TelegramUpdate): string {
  if (update.message) return "message";
  if (update.edited_message) return "edited_message";
  if (update.channel_post) return "channel_post";
  if (update.edited_channel_post) return "edited_channel_post";
  if (update.callback_query) return "callback_query";
  return "unknown";
}

// ============================================================
// Content extraction
// ============================================================

/**
 * Extract text/caption/entities/media from a message-bearing update.
 *
 * Returns null if the update has no usable content (not a message update,
 * or no text/caption/media/media_group_id).
 *
 * For channel posts, prefers `sender_chat.id` over `from.id` when `from` is
 * missing (channels post as themselves unless message-signing is enabled).
 */
export function extractContent(update: TelegramUpdate): ExtractedContent | null {
  const type = isUpdateType(update);
  if (type === "unknown" || type === "callback_query") return null;

  const msg = (update as unknown as Record<string, unknown>)[type] as TelegramMessage | undefined;
  if (!msg) return null;

  return extractFromMessage(msg, type as MessageKey);
}

/**
 * Core extractor for a single message object. Pulled out so it can be reused
 * for `reply_to_message` if we ever need to extract that too.
 */
function extractFromMessage(
  msg: TelegramMessage,
  type: MessageKey,
): ExtractedContent | null {
  const isChannelPost = type === "channel_post" || type === "edited_channel_post";
  const isEdit = type === "edited_message" || type === "edited_channel_post";

  // ---- Sender attribution -----------------------------------------------
  // For channel posts without message-signing, `from` is absent; fall back to
  // `sender_chat.id` (the channel itself).
  let fromId: number | null = null;
  let fromName = "";
  if (msg.from) {
    fromId = msg.from.id;
    fromName =
      [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") ||
      msg.from.username ||
      "";
  } else if (msg.sender_chat) {
    fromId = msg.sender_chat.id;
    fromName = msg.sender_chat.title || msg.sender_chat.username || "";
  }

  // ---- Text + entities ---------------------------------------------------
  const text = msg.text ?? msg.caption ?? "";
  const entities: TelegramEntity[] = msg.entities ?? msg.caption_entities ?? [];

  // ---- Media (single item; media GROUPS are aggregated separately) -------
  let media: ExtractedContent["media"] = undefined;
  if (msg.photo && msg.photo.length > 0) {
    // Telegram sends multiple sizes; pick the largest (last entry).
    const largest = msg.photo[msg.photo.length - 1];
    media = { type: "photo", fileId: largest.file_id };
  } else if (msg.video) {
    media = { type: "video", fileId: msg.video.file_id };
  } else if (msg.animation) {
    media = { type: "animation", fileId: msg.animation.file_id };
  } else if (msg.document) {
    media = {
      type: "document",
      fileId: msg.document.file_id,
      fileName: msg.document.file_name,
      mimeType: msg.document.mime_type,
    };
  }

  // ---- No usable content? -----------------------------------------------
  // A media_group_id without other content still counts (it's part of an
  // album being aggregated elsewhere). Pure-sticker / pure-location etc.
  // messages with no text/media are dropped here.
  if (!text && !media && !msg.media_group_id) {
    return null;
  }

  // ---- Quoted text (for context-aware processing) ------------------------
  const reply = msg.reply_to_message;
  const replyToText = reply ? (reply.text ?? reply.caption) : undefined;

  return {
    fromId,
    fromName,
    chatId: msg.chat.id,
    chatType: msg.chat.type,
    messageId: msg.message_id,
    text,
    entities,
    media,
    mediaGroupId: msg.media_group_id,
    isChannelPost,
    isEdit,
    replyToText,
  };
}

// ============================================================
// Log summary
// ============================================================

/**
 * Compact one-liner summary of an update, suitable for log lines / debug rows.
 * Never throws; degrades gracefully for malformed updates.
 */
export function extractUpdateInfoForLog(update: TelegramUpdate): {
  updateType: string;
  fromId: number | null;
  chatId: number | null;
  textPreview: string;
} {
  const updateType = isUpdateType(update);

  // Callback queries: source user + the chat the button was attached to.
  if (updateType === "callback_query" && update.callback_query) {
    const cq = update.callback_query;
    return {
      updateType,
      fromId: cq.from?.id ?? null,
      chatId: cq.message?.chat?.id ?? null,
      textPreview: cq.data ?? "",
    };
  }

  if (updateType === "unknown") {
    return { updateType, fromId: null, chatId: null, textPreview: "" };
  }

  const content = extractContent(update);
  return {
    updateType,
    fromId: content?.fromId ?? null,
    chatId: content?.chatId ?? null,
    // Cap preview to keep log lines readable.
    textPreview: content ? content.text.slice(0, 120) : "",
  };
}
