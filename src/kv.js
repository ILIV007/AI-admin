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
// Flow:
//   1. First update with a given media_group_id → store item, wait ~1.5s, then
//      read the full group from KV and process it as one unit.
//   2. Subsequent updates with the same media_group_id → just add to the KV
//      list and return early. The first waiter handles processing.
// ============================================================

const KEY_MEDIA_GROUP = (id) => `mg:${id}`;

export async function getMediaGroup(SETTINGS, mediaGroupId) {
  if (!SETTINGS || !mediaGroupId) return [];
  try {
    const raw = await SETTINGS.get(KEY_MEDIA_GROUP(mediaGroupId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveMediaGroup(SETTINGS, mediaGroupId, items) {
  if (!SETTINGS || !mediaGroupId) return;
  // TTL of 60 seconds so abandoned groups don't pile up
  await SETTINGS.put(KEY_MEDIA_GROUP(mediaGroupId), JSON.stringify(items), { expirationTtl: 60 });
}

export async function deleteMediaGroup(SETTINGS, mediaGroupId) {
  if (!SETTINGS || !mediaGroupId) return;
  await SETTINGS.delete(KEY_MEDIA_GROUP(mediaGroupId));
}
