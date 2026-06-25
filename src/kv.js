/**
 * src/kv.js
 * Cloudflare KV helpers for storing per-admin bot settings.
 *
 * Schema (single JSON blob per admin, keyed by `admin:<admin_id>`):
 *   {
 *     language_mode:   "auto" | "fa" | "en",
 *     rewrite_mode:    "none" | "light" | "normal" | "summary",
 *     personality_mode:"friendly" | "professional" | "technical" | "news",
 *     footer_text:     "🌀 @ILIVIR3",
 *     ai_provider:     "gemini" | "openrouter",
 *     stats: { processed: 0, rewritten: 0, failed: 0 }
 *   }
 *
 * Why one blob instead of multiple keys?
 *   - Free tier: 1,000 writes/day. One write per settings change, not 5.
 */

const KEY_ADMIN = (id) => `admin:${id}`;
const KEY_GLOBAL_STATS = "stats:global";

export const DEFAULTS = Object.freeze({
  language_mode: "auto",
  rewrite_mode: "normal",
  personality_mode: "friendly",
  footer_text: "🌀 @ILIVIR3",
  ai_provider: "openrouter", // Default to OpenRouter (Gemini often hits 429 on free tier)
  channel_editing_enabled: false, // Default OFF — channel posts are NOT edited unless admin enables this
  stats: { processed: 0, rewritten: 0, failed: 0 },
});

/** Read the admin's settings, merged with defaults */
export async function getSettings(SETTINGS, adminId) {
  const raw = await SETTINGS.get(KEY_ADMIN(adminId));
  if (!raw) return { ...DEFAULTS, admin_id: String(adminId) };
  try {
    const parsed = JSON.parse(raw);
    // Make sure new fields (added later) get default values
    return { ...DEFAULTS, ...parsed, admin_id: String(adminId) };
  } catch {
    return { ...DEFAULTS, admin_id: String(adminId) };
  }
}

/** Persist the entire settings blob */
export async function saveSettings(SETTINGS, adminId, settings) {
  await SETTINGS.put(KEY_ADMIN(adminId), JSON.stringify(settings));
}

/** Update a single field, returning the new merged settings */
export async function updateSetting(SETTINGS, adminId, key, value) {
  const current = await getSettings(SETTINGS, adminId);
  const next = { ...current, [key]: value };
  await saveSettings(SETTINGS, adminId, next);
  return next;
}

/** Increment stats counters atomically (best-effort; KV is eventually consistent) */
export async function bumpStats(SETTINGS, adminId, field) {
  const s = await getSettings(SETTINGS, adminId);
  s.stats = s.stats || { processed: 0, rewritten: 0, failed: 0 };
  s.stats[field] = (s.stats[field] || 0) + 1;
  await saveSettings(SETTINGS, adminId, s);
  return s;
}

/** Global stats (across all admins — single shared key) */
export async function getGlobalStats(SETTINGS) {
  const raw = await SETTINGS.get(KEY_GLOBAL_STATS);
  if (!raw) return { processed: 0, rewritten: 0, failed: 0 };
  try {
    return JSON.parse(raw);
  } catch {
    return { processed: 0, rewritten: 0, failed: 0 };
  }
}

export async function bumpGlobalStats(SETTINGS, field) {
  const cur = await getGlobalStats(SETTINGS);
  cur[field] = (cur[field] || 0) + 1;
  await SETTINGS.put(KEY_GLOBAL_STATS, JSON.stringify(cur));
  return cur;
}

// ============================================================
// MEDIA GROUP BUFFERING
// ============================================================
// Telegram sends each photo in an album as a separate update, all sharing
// the same `media_group_id`. We buffer them in KV so we can send them all
// together with `sendMediaGroup` (preserves the album layout).
//
// RACE CONDITION FIX (v0.1.9):
// Previous versions stored all items under ONE key (mg:<groupId>), which caused
// a read-modify-write race: multiple concurrent invocations would each read
// "empty", save their own item, and overwrite each other.
//
// New approach: each item gets its OWN unique key (mg:<groupId>:<messageId>).
// This eliminates the overwrite race. Then we use KV's list() method to
// collect all items with the same group prefix, and use leader election
// (smallest message_id processes) to avoid duplicate processing.
// ============================================================

const MG_PREFIX = (groupId) => `mg:${groupId}:`;
const MG_KEY = (groupId, msgId) => `mg:${groupId}:${msgId}`;

/** Save a single media group item under its own unique key */
export async function saveMediaGroupItem(SETTINGS, groupId, msgId, item) {
  if (!SETTINGS || !groupId || !msgId) return;
  await SETTINGS.put(MG_KEY(groupId, msgId), JSON.stringify(item), { expirationTtl: 120 });
}

/** List all items in a media group using prefix scan */
export async function listMediaGroupItems(SETTINGS, groupId) {
  if (!SETTINGS || !groupId) return [];
  try {
    const list = await SETTINGS.list({ prefix: MG_PREFIX(groupId), limit: 100 });
    const items = [];
    for (const key of list.keys) {
      const raw = await SETTINGS.get(key.name);
      if (raw) {
        try {
          items.push(JSON.parse(raw));
        } catch {}
      }
    }
    // Sort by message_id to preserve order
    items.sort((a, b) => (a.messageId || 0) - (b.messageId || 0));
    return items;
  } catch (e) {
    console.error("[kv] listMediaGroupItems failed:", e.message);
    return [];
  }
}

/** Delete all items in a media group */
export async function deleteMediaGroup(SETTINGS, groupId) {
  if (!SETTINGS || !groupId) return;
  try {
    const list = await SETTINGS.list({ prefix: MG_PREFIX(groupId), limit: 100 });
    for (const key of list.keys) {
      await SETTINGS.delete(key.name);
    }
  } catch (e) {
    console.error("[kv] deleteMediaGroup failed:", e.message);
  }
}
