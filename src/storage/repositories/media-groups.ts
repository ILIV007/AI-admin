/**
 * src/storage/repositories/media-groups.ts
 * -----------------------------------------------------------------------------
 * Media group (album) aggregation repository.
 *
 * V1 used KV to aggregate media-group items and raced: the finalize timer
 * could fire while items were still being written, or two finalize timers
 * could fire concurrently and double-publish the album.
 *
 * V2 uses D1 as the source of truth:
 *   - Each item is `INSERT OR IGNORE`d into `media_group_items` (idempotent
 *     on (media_group_id, message_id) — Telegram retries are safe).
 *   - On the first item of a group, the webhook enqueues a
 *     `finalize_media_group` queue message with a delay.
 *   - The consumer, when it receives that finalize message, checks
 *     `isFinalized` (defends against double-finalize) and the inactivity
 *     window (if the last item arrived < MEDIA_GROUP_WINDOW_MS ago, re-enqueue
 *     with a small delay so late-arriving items can still be aggregated).
 *   - Once the inactivity window has elapsed, `markFinalized` sets
 *     finalized=1 on all rows for the group; the consumer combines captions +
 *     takes the first item's media as the "primary" media, then runs the
 *     pipeline.
 * -----------------------------------------------------------------------------
 */

import type { Env, ExtractedContent, MediaGroupItem } from "../../types";
import { exec, execAll } from "../d1";

// ============================================================
// Row mapping
// ============================================================

interface MediaGroupRow {
  media_group_id: string;
  message_id: number;
  chat_id: number;
  from_id: number;
  text: string;
  media_type: string | null;
  file_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  received_at: number;
  finalized: number;
}

function rowToItem(r: MediaGroupRow): MediaGroupItem {
  let media: ExtractedContent["media"] | undefined;
  if (r.media_type && r.file_id) {
    media = {
      type: r.media_type as NonNullable<ExtractedContent["media"]>["type"],
      fileId: r.file_id,
      fileName: r.file_name ?? undefined,
      mimeType: r.mime_type ?? undefined,
    };
  }
  return {
    mediaGroupId: r.media_group_id,
    messageId: r.message_id,
    chatId: r.chat_id,
    fromId: r.from_id,
    text: r.text,
    media,
    receivedAt: r.received_at,
    finalized: r.finalized,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Add an item to a media group. `INSERT OR IGNORE` makes it safe against
 * Telegram retries (which re-send the same message_id within the group).
 */
export async function addItem(env: Env, item: MediaGroupItem): Promise<void> {
  const mediaType = item.media?.type ?? null;
  const fileId = item.media?.fileId ?? null;
  const fileName = item.media?.fileName ?? null;
  const mimeType = item.media?.mimeType ?? null;
  await exec(
    env.DB,
    `INSERT OR IGNORE INTO media_group_items
       (media_group_id, message_id, chat_id, from_id, text,
        media_type, file_id, file_name, mime_type, received_at, finalized)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    item.mediaGroupId,
    item.messageId,
    item.chatId,
    item.fromId,
    item.text,
    mediaType,
    fileId,
    fileName,
    mimeType,
    item.receivedAt,
  );
}

/**
 * Get all items for a media group, ordered by message_id ASC (Telegram sends
 * album items in order; this gives us a deterministic caption-merge order).
 */
export async function getItems(
  env: Env,
  mediaGroupId: string,
): Promise<MediaGroupItem[]> {
  const rows = await execAll<MediaGroupRow>(
    env.DB,
    "SELECT * FROM media_group_items WHERE media_group_id = ? ORDER BY message_id ASC",
    mediaGroupId,
  );
  return rows.map(rowToItem);
}

/**
 * Atomically claim a media group for finalization.
 *
 * Sets finalized=1 on all rows for the group ONLY IF none are already finalized.
 * Returns true if this call claimed the group (caller may proceed to publish),
 * false if another handler already finalized it (caller must back off).
 *
 * This is the fix for the double-publish race: two concurrent finalize
 * handlers both call isFinalized() → both see false → both call markFinalized.
 * With this conditional UPDATE, only the first caller gets rows-affected > 0.
 */
export async function markFinalized(
  env: Env,
  mediaGroupId: string,
): Promise<boolean> {
  const r = await exec(
    env.DB,
    "UPDATE media_group_items SET finalized = 1 WHERE media_group_id = ? AND finalized = 0",
    mediaGroupId,
  );
  return (r.meta?.changes ?? 0) > 0;
}

/**
 * True iff ANY item in the group has finalized=1. We only need one — once
 * we've finalized, the group is "claimed" and concurrent finalize messages
 * must back off.
 */
export async function isFinalized(
  env: Env,
  mediaGroupId: string,
): Promise<boolean> {
  const rows = await execAll<{ finalized: number }>(
    env.DB,
    "SELECT finalized FROM media_group_items WHERE media_group_id = ? AND finalized = 1 LIMIT 1",
    mediaGroupId,
  );
  return rows.length > 0;
}
