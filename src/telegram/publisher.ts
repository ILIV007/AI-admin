/**
 * src/telegram/publisher.ts
 * -----------------------------------------------------------------------------
 * Publish / edit / preview posts to the target channel & admin's private chat.
 *
 * CHUNKING CONTRACT (with the formatter):
 *   - The caller passes ALREADY-SPLIT `parts`, each ≤ 4096 visible chars.
 *   - The footer is ALREADY embedded in the LAST part by the formatter — we
 *     DO NOT append it again. (V1 bug: footer was duplicated on every part.)
 *   - If Telegram still rejects a part as "too long" (e.g. visible-length
 *     accounting differs from ours), we re-split on paragraph / line / char
 *     boundaries using truncateVisible so tags stay balanced.
 *
 * MEDIA CONTRACT:
 *   - We accept a SINGLE media item per post (the formatter condenses albums
 *     via the media-group pipeline elsewhere; this publisher handles the
 *     final single-media post).
 *   - If parts.length > 1 AND media is present:
 *       * Media goes out with parts[0] as its caption (≤1024 visible chars).
 *       * Remaining parts (1..N) go out as separate text messages.
 *   - If parts.length === 1 AND media is present:
 *       * Media goes out with parts[0] as caption.
 *   - If no media:
 *       * Each part goes out as a text message.
 * -----------------------------------------------------------------------------
 */

import type { Env, ExtractedContent } from "../types";
import { TELEGRAM_LIMITS } from "../config/defaults";
import {
  sendMessage,
  sendPhoto,
  sendVideo,
  sendDocument,
  sendAnimation,
  editMessageText,
  editMessageCaption,
} from "./client";
import { visibleLength, truncateVisible } from "./entities";
import { log } from "../observability/logger";

// ============================================================
// Public types
// ============================================================

export interface PublishResult {
  ok: boolean;
  messageIds: number[]; // every message we sent (may be > parts.length after re-split)
  error?: string;
}

export interface EditResult {
  ok: boolean;
  error?: string;
}

export interface PreviewResult {
  ok: boolean;
  messageId?: number; // the FIRST message id (caller attaches keyboard/actions to this)
  error?: string;
}

// ============================================================
// publishPost
// ============================================================

/**
 * Publish a post to env.TARGET_CHANNEL.
 *
 * Footer is already in the last part — do NOT add again.
 */
export async function publishPost(
  env: Env,
  html: string,
  parts: string[],
  media?: ExtractedContent["media"],
): Promise<PublishResult> {
  const token = env.BOT_TOKEN;
  const chatId = env.TARGET_CHANNEL;
  const safeParts = parts.length > 0 ? parts : [html];
  const messageIds: number[] = [];

  try {
    if (media) {
      // --- Media path: first part becomes the media caption. ---
      const firstCaption = safeParts[0] ?? "";

      // Caption hard limit is 1024 visible chars; truncate safely.
      const safeCaption = truncateVisible(
        firstCaption,
        TELEGRAM_LIMITS.CAPTION_MAX_LEN,
      );

      const mediaResult = await sendMediaWithCaption(
        token,
        chatId,
        safeCaption,
        media,
      );
      if (mediaResult?.message_id) messageIds.push(mediaResult.message_id);

      // Remaining parts go out as reply chain (each part replies to the previous).
      for (let i = 1; i < safeParts.length; i++) {
        const ids = await sendTextSafe(
          token,
          chatId,
          safeParts[i],
          undefined,
          messageIds[messageIds.length - 1], // reply to previous message
        );
        messageIds.push(...ids);
      }
      return { ok: true, messageIds };
    }

    // --- Text-only path: send each part as reply chain ---
    // First part: normal message
    // Subsequent parts: reply to previous message (reply chain)
    for (let i = 0; i < safeParts.length; i++) {
      const ids = await sendTextSafe(
        token,
        chatId,
        safeParts[i],
        undefined,
        i > 0 ? messageIds[messageIds.length - 1] : undefined,
      );
      messageIds.push(...ids);
    }
    return { ok: true, messageIds };
  } catch (err) {
    const msg = (err as Error).message;
    log("error", "publisher.publishPost", `Failed to publish: ${msg}`, {
      chatId,
      parts: safeParts.length,
      hasMedia: !!media,
    });
    return { ok: false, messageIds, error: msg };
  }
}

// ============================================================
// editChannelPost
// ============================================================

/**
 * Edit an existing channel post. Uses editMessageText for text-only posts,
 * editMessageCaption when the original post had media (we can't swap the
 * file itself via the Bot API — only the caption).
 */
export async function editChannelPost(
  env: Env,
  chatId: number,
  messageId: number,
  html: string,
  hasMedia: boolean,
): Promise<EditResult> {
  const token = env.BOT_TOKEN;
  try {
    if (hasMedia) {
      // Caption limit applies here.
      const safeCaption = truncateVisible(
        html,
        TELEGRAM_LIMITS.CAPTION_MAX_LEN,
      );
      await editMessageCaption(token, {
        chat_id: chatId,
        message_id: messageId,
        caption: safeCaption,
      });
    } else {
      await editMessageText(token, {
        chat_id: chatId,
        message_id: messageId,
        text: html,
      });
    }
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    log("error", "publisher.editChannelPost", `Failed to edit: ${msg}`, {
      chatId,
      messageId,
      hasMedia,
    });
    return { ok: false, error: msg };
  }
}

// ============================================================
// sendPreview
// ============================================================

/**
 * Send a preview to the admin's private chat (userId). The optional inline
 * keyboard (typically Publish/Reject buttons) is attached to the FIRST
 * message of the preview so the admin sees it immediately without scrolling.
 *
 * `html` is the full HTML (kept for symmetry with publishPost); `parts` is
 * the already-split version that actually gets sent.
 */
export async function sendPreview(
  env: Env,
  userId: number,
  html: string,
  parts: string[],
  media?: ExtractedContent["media"],
  keyboard?: string,
): Promise<PreviewResult> {
  const token = env.BOT_TOKEN;
  const chatId = userId;
  const safeParts = parts.length > 0 ? parts : [html];

  try {
    if (safeParts.length === 0) {
      return { ok: false, error: "no parts to preview" };
    }

    if (media) {
      // Media message gets the first part as caption + the keyboard.
      const safeCaption = truncateVisible(
        safeParts[0] ?? "",
        TELEGRAM_LIMITS.CAPTION_MAX_LEN,
      );
      const r = await sendMediaWithCaption(
        token,
        chatId,
        safeCaption,
        media,
        keyboard,
      );
      const firstId = r?.message_id;

      // Remaining parts go as plain text (no keyboard).
      for (let i = 1; i < safeParts.length; i++) {
        await sendTextSafe(token, chatId, safeParts[i]);
      }
      return { ok: true, messageId: firstId };
    }

    // Text-only: keyboard on the FIRST part.
    let firstId: number | undefined;
    for (let i = 0; i < safeParts.length; i++) {
      const ids = await sendTextSafe(
        token,
        chatId,
        safeParts[i],
        i === 0 ? keyboard : undefined,
      );
      if (i === 0) firstId = ids[0];
    }
    return { ok: true, messageId: firstId };
  } catch (err) {
    const msg = (err as Error).message;
    log("error", "publisher.sendPreview", `Failed to send preview: ${msg}`, {
      userId,
    });
    return { ok: false, error: msg };
  }
}

// ============================================================
// Internal helpers
// ============================================================

/**
 * Send a single media item with a caption. Dispatches to the correct wrapper
 * based on media.type. Always truncates the caption to the 1024-char limit
 * (caller can pre-truncate but we double-check here).
 */
async function sendMediaWithCaption(
  token: string,
  chatId: number | string,
  caption: string,
  media: NonNullable<ExtractedContent["media"]>,
  replyMarkup?: string,
): Promise<{ message_id: number } | null> {
  const safeCaption = caption
    ? truncateVisible(caption, TELEGRAM_LIMITS.CAPTION_MAX_LEN)
    : "";

  // Common base. `reply_markup` is included even if undefined — the wrappers
  // accept it as optional.
  const base = {
    chat_id: chatId,
    caption: safeCaption,
    reply_markup: replyMarkup,
  };

  switch (media.type) {
    case "photo":
      return sendPhoto(token, { ...base, photo: media.fileId });
    case "video":
      return sendVideo(token, { ...base, video: media.fileId });
    case "document":
      return sendDocument(token, {
        ...base,
        document: media.fileId,
      });
    case "animation":
      return sendAnimation(token, { ...base, animation: media.fileId });
    default:
      // Exhaustiveness guard — should never happen with a discriminated union.
      throw new Error(
        `sendMediaWithCaption: unknown media type ${JSON.stringify(media.type)}`,
      );
  }
}

/**
 * Send a text message; if Telegram rejects with 400 "too long", re-split on
 * paragraph / line / char boundaries and send each chunk.
 *
 * Returns ALL resulting message_ids (usually one; more if re-split occurred).
 */
async function sendTextSafe(
  token: string,
  chatId: number | string,
  text: string,
  replyMarkup?: string,
  replyToMessageId?: number,
): Promise<number[]> {
  try {
    const r = await sendMessage(token, {
      chat_id: chatId,
      text,
      reply_markup: replyMarkup,
      reply_to_message_id: replyToMessageId,
    });
    return [r.message_id];
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("too long")) {
      log("warn", "publisher.sendTextSafe", "Re-splitting too-long message", {
        visibleLen: visibleLength(text),
      });
      const chunks = resplit(text, TELEGRAM_LIMITS.MESSAGE_MAX_LEN);
      const ids: number[] = [];
      const last = chunks.length - 1;
      let prevId = replyToMessageId;
      for (let i = 0; i < chunks.length; i++) {
        const r = await sendMessage(token, {
          chat_id: chatId,
          text: chunks[i],
          reply_markup: i === last ? replyMarkup : undefined,
          reply_to_message_id: prevId,
        });
        ids.push(r.message_id);
        prevId = r.message_id;
      }
      return ids;
    }
    throw err;
  }
}

/**
 * Re-split an HTML fragment that exceeded the message length limit.
 *
 * Strategy (in order, each fallback kicks in only if the previous left a unit
 * still too big):
 *   1. Split on blank lines (paragraphs), accumulate into chunks ≤ maxLen.
 *   2. If a single paragraph is still too long, split on single newlines.
 *   3. If a single line is still too long, hard visible-truncate (tags closed
 *      by truncateVisible).
 *
 * `maxLen` is VISIBLE characters (Telegram's accounting).
 *
 * Limitation: re-splitting a paragraph that lives inside a <pre><code> block
 * won't reopen the <pre><code> on the next chunk. The formatter is expected
 * to produce well-sized chunks in normal operation; this is a safety net.
 */
function resplit(html: string, maxLen: number): string[] {
  if (visibleLength(html) <= maxLen) return [html];

  const chunks: string[] = [];
  const paragraphs = html.split(/\n{2,}/);
  let buf = "";

  const flush = (): void => {
    if (buf.trim()) chunks.push(buf);
    buf = "";
  };

  for (const para of paragraphs) {
    if (visibleLength(para) > maxLen) {
      // Paragraph alone exceeds the limit — flush buf, then split para by lines.
      flush();
      const lines = para.split("\n");
      for (const line of lines) {
        if (visibleLength(line) > maxLen) {
          // Single line still too long — hard truncate.
          flush();
          chunks.push(truncateVisible(line, maxLen));
        } else {
          const cand = buf ? `${buf}\n${line}` : line;
          if (visibleLength(cand) > maxLen) {
            flush();
            buf = line;
          } else {
            buf = cand;
          }
        }
      }
      flush();
    } else {
      const cand = buf ? `${buf}\n\n${para}` : para;
      if (visibleLength(cand) > maxLen) {
        flush();
        buf = para;
      } else {
        buf = cand;
      }
    }
  }
  flush();

  // Defensive fallback — always return at least one chunk.
  return chunks.length > 0 ? chunks : [truncateVisible(html, maxLen)];
}
