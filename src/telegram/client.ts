/**
 * src/telegram/client.ts
 * -----------------------------------------------------------------------------
 * Telegram Bot API HTTP client.
 *
 * Design notes:
 *   - Single low-level entry point `tgApi(token, method, body)` performs a
 *     JSON POST to `https://api.telegram.org/bot{token}/{method}` and returns
 *     the parsed `result` field on success.
 *   - On HTTP non-200, throws an Error whose message includes the Telegram
 *     `description` (best-effort: body is JSON-parsed).
 *   - On API-level 429 (rate limit) signaled via `parameters.retry_after`,
 *     sleeps and retries ONCE. No further retries — the caller is responsible
 *     for higher-level retry/backoff.
 *   - All wrappers default `parse_mode` to "HTML" since our pipeline emits
 *     HTML. Callers can override per-call.
 *   - CRITICAL: there is NO `schedule_date` anywhere in this file. The Bot API
 *     has no such parameter — V1 had a long-standing bug where scheduling was
 *     attempted via this phantom parameter. Scheduling in V2 is done via D1
 *     jobs + cron, never via the Bot API.
 * -----------------------------------------------------------------------------
 */

import type { Env } from "../types";

const API_BASE = "https://api.telegram.org/bot";

/** Promise-based sleep that works in Cloudflare Workers (setTimeout is available). */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// Low-level API shape
// ============================================================

export interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
    migrate_to_chat_id?: number;
  };
}

/** Minimal Telegram Message shape returned by send/edit methods. */
export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type?: string; title?: string; username?: string };
  from?: { id: number; is_bot: boolean; first_name: string; username?: string };
  text?: string;
  caption?: string;
}

// ============================================================
// Core: tgApi
// ============================================================

/**
 * Low-level Bot API call.
 *
 * @param token   Bot token (from env.BOT_TOKEN).
 * @param method  Bot API method name (e.g. "sendMessage").
 * @param body    JSON-serializable parameter object.
 * @returns       The `result` field of the successful API response.
 * @throws        Error with Telegram description on HTTP non-200 or API `ok=false`.
 *                Retries once on 429 (retry_after) before throwing.
 */
export async function tgApi<T = unknown>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  // At most 2 iterations: initial attempt + one retry on 429.
  for (let attempt = 0; attempt < 2; attempt++) {
    const url = `${API_BASE}${token}/${method}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    } catch (err) {
      // Network error — no point retrying; surface immediately.
      throw new Error(`tgApi[${method}] network error: ${(err as Error).message}`);
    }

    // HTTP non-200 → try to extract description from JSON body, then throw.
    if (!response.ok) {
      let description = `HTTP ${response.status}`;
      try {
        const errBody = (await response.json()) as TelegramApiResponse;
        if (errBody?.description) description = errBody.description;
      } catch {
        /* Body wasn't JSON — keep generic HTTP description. */
      }
      throw new Error(`tgApi[${method}] HTTP ${response.status}: ${description}`);
    }

    let data: TelegramApiResponse<T>;
    try {
      data = (await response.json()) as TelegramApiResponse<T>;
    } catch (err) {
      throw new Error(`tgApi[${method}] invalid JSON response: ${(err as Error).message}`);
    }

    // 429 rate-limit → sleep and retry ONCE.
    if (!data.ok && data.parameters?.retry_after && attempt === 0) {
      // Telegram returns retry_after in seconds. Add a 0.5s safety margin.
      const waitMs = (data.parameters.retry_after + 0.5) * 1000;
      await sleep(waitMs);
      continue;
    }

    // Any other API error → throw.
    if (!data.ok) {
      const msg = data.description ?? "unknown error";
      const code = data.error_code ?? "?";
      throw new Error(`tgApi[${method}] ${code}: ${msg}`);
    }

    return data.result as T;
  }

  // Unreachable: the loop either returns or throws on iteration 0/1.
  throw new Error(`tgApi[${method}] exhausted retries (unexpected)`);
}

// ============================================================
// Convenience wrappers — each takes (token, params) and calls tgApi.
// parse_mode defaults to "HTML"; callers may override per-call.
// ============================================================

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  entities?: unknown[];
  link_preview_options?: { is_disabled?: boolean; url?: string };
  disable_notification?: boolean;
  protect_content?: boolean;
  reply_markup?: string; // JSON-encoded InlineKeyboardMarkup
  reply_to_message_id?: number;
  message_thread_id?: number;
}

export async function sendMessage(
  token: string,
  params: SendMessageParams,
): Promise<TgMessage> {
  return tgApi<TgMessage>(token, "sendMessage", {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...params,
  });
}

export interface SendPhotoParams {
  chat_id: number | string;
  photo: string; // file_id or URL
  caption?: string;
  parse_mode?: "HTML" | "MarkdownV2";
  caption_entities?: unknown[];
  has_spoiler?: boolean;
  disable_notification?: boolean;
  protect_content?: boolean;
  reply_markup?: string;
  reply_to_message_id?: number;
  message_thread_id?: number;
}

export async function sendPhoto(
  token: string,
  params: SendPhotoParams,
): Promise<TgMessage> {
  return tgApi<TgMessage>(token, "sendPhoto", {
    parse_mode: "HTML",
    ...params,
  });
}

export interface SendVideoParams {
  chat_id: number | string;
  video: string; // file_id or URL
  caption?: string;
  parse_mode?: "HTML" | "MarkdownV2";
  caption_entities?: unknown[];
  has_spoiler?: boolean;
  duration?: number;
  width?: number;
  height?: number;
  thumbnail?: string;
  disable_notification?: boolean;
  protect_content?: boolean;
  reply_markup?: string;
  reply_to_message_id?: number;
  message_thread_id?: number;
}

export async function sendVideo(
  token: string,
  params: SendVideoParams,
): Promise<TgMessage> {
  return tgApi<TgMessage>(token, "sendVideo", {
    parse_mode: "HTML",
    ...params,
  });
}

export interface SendDocumentParams {
  chat_id: number | string;
  document: string; // file_id or URL
  caption?: string;
  parse_mode?: "HTML" | "MarkdownV2";
  caption_entities?: unknown[];
  disable_content_type_detection?: boolean;
  thumbnail?: string;
  disable_notification?: boolean;
  protect_content?: boolean;
  reply_markup?: string;
  reply_to_message_id?: number;
  message_thread_id?: number;
}

export async function sendDocument(
  token: string,
  params: SendDocumentParams,
): Promise<TgMessage> {
  return tgApi<TgMessage>(token, "sendDocument", {
    parse_mode: "HTML",
    ...params,
  });
}

export interface SendAnimationParams {
  chat_id: number | string;
  animation: string; // file_id or URL
  caption?: string;
  parse_mode?: "HTML" | "MarkdownV2";
  caption_entities?: unknown[];
  has_spoiler?: boolean;
  duration?: number;
  width?: number;
  height?: number;
  thumbnail?: string;
  disable_notification?: boolean;
  protect_content?: boolean;
  reply_markup?: string;
  reply_to_message_id?: number;
  message_thread_id?: number;
}

export async function sendAnimation(
  token: string,
  params: SendAnimationParams,
): Promise<TgMessage> {
  return tgApi<TgMessage>(token, "sendAnimation", {
    parse_mode: "HTML",
    ...params,
  });
}

export interface InputMediaItem {
  type: "photo" | "video" | "document" | "animation";
  media: string; // file_id or URL (no multipart upload in this bot)
  caption?: string;
  parse_mode?: "HTML";
  caption_entities?: unknown[];
  has_spoiler?: boolean;
  // Type-specific optional fields omitted for brevity; add as needed.
}

export interface SendMediaGroupParams {
  chat_id: number | string;
  media: InputMediaItem[]; // 2–10 items
  disable_notification?: boolean;
  protect_content?: boolean;
  reply_to_message_id?: number;
  message_thread_id?: number;
}

/**
 * Send a media group (album). Per Bot API, only the FIRST item may carry a
 * caption. We automatically attach `parse_mode: "HTML"` to the first item if
 * it has a caption.
 */
export async function sendMediaGroup(
  token: string,
  params: SendMediaGroupParams,
): Promise<TgMessage[]> {
  const media = params.media.map((m, i) =>
    i === 0 && m.caption
      ? { ...m, parse_mode: "HTML" as const }
      : m,
  );
  return tgApi<TgMessage[]>(token, "sendMediaGroup", { ...params, media });
}

export interface EditMessageTextParams {
  chat_id: number | string;
  message_id: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  link_preview_options?: { is_disabled?: boolean; url?: string };
  reply_markup?: string;
}

export async function editMessageText(
  token: string,
  params: EditMessageTextParams,
): Promise<TgMessage | true> {
  return tgApi<TgMessage | true>(token, "editMessageText", {
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    ...params,
  });
}

export interface EditMessageCaptionParams {
  chat_id?: number | string;
  message_id?: number;
  inline_message_id?: string;
  caption: string;
  parse_mode?: "HTML" | "MarkdownV2";
  caption_entities?: unknown[];
  reply_markup?: string;
}

export async function editMessageCaption(
  token: string,
  params: EditMessageCaptionParams,
): Promise<TgMessage | true> {
  return tgApi<TgMessage | true>(token, "editMessageCaption", {
    parse_mode: "HTML",
    ...params,
  });
}

export interface DeleteMessageParams {
  chat_id: number | string;
  message_id: number;
}

export async function deleteMessage(
  token: string,
  params: DeleteMessageParams,
): Promise<boolean> {
  return tgApi<boolean>(token, "deleteMessage", params as unknown as Record<string, unknown>);
}

export interface AnswerCallbackQueryParams {
  callback_query_id: string;
  text?: string;
  show_alert?: boolean;
  url?: string;
  cache_time?: number;
}

export async function answerCallbackQuery(
  token: string,
  params: AnswerCallbackQueryParams,
): Promise<boolean> {
  return tgApi<boolean>(token, "answerCallbackQuery", params as unknown as Record<string, unknown>);
}

export interface GetMeResult {
  id: number;
  is_bot: boolean;
  first_name: string;
  username: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
}

export async function getMe(token: string): Promise<GetMeResult> {
  return tgApi<GetMeResult>(token, "getMe", {});
}

export interface SetWebhookParams {
  url: string;
  secret_token?: string;
  max_connections?: number;
  allowed_updates?: string[];
  drop_pending_updates?: boolean;
}

export async function setWebhook(
  token: string,
  params: SetWebhookParams,
): Promise<boolean> {
  return tgApi<boolean>(token, "setWebhook", params as unknown as Record<string, unknown>);
}

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
  max_connections: number;
  allowed_updates?: string[];
  ip_address?: string;
}

export async function getWebhookInfo(token: string): Promise<WebhookInfo> {
  return tgApi<WebhookInfo>(token, "getWebhookInfo", {});
}

export interface DeleteWebhookParams {
  drop_pending_updates?: boolean;
}

/**
 * Remove the currently-configured webhook. After this, the bot will fall back
 * to long-polling via getUpdates (which we don't use in V2, but the call is
 * still useful for tearing down a misconfigured webhook).
 */
export async function deleteWebhook(
  token: string,
  params?: DeleteWebhookParams,
): Promise<boolean> {
  return tgApi<boolean>(
    token,
    "deleteWebhook",
    (params ?? {}) as unknown as Record<string, unknown>,
  );
}

export interface SendChatActionParams {
  chat_id: number | string;
  action:
    | "typing"
    | "upload_photo"
    | "record_video"
    | "upload_video"
    | "record_voice"
    | "upload_voice"
    | "upload_document"
    | "find_location"
    | "record_video_note"
    | "upload_video_note";
}

export async function sendChatAction(
  token: string,
  params: SendChatActionParams,
): Promise<boolean> {
  return tgApi<boolean>(token, "sendChatAction", params as unknown as Record<string, unknown>);
}

// ============================================================
// Convenience: pull BOT_TOKEN out of env so callers don't repeat themselves.
// (Optional helper — wrappers above still take explicit `token` per spec.)
// ============================================================

export function botToken(env: Env): string {
  return env.BOT_TOKEN;
}
