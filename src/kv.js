/**
 * src/kv.js
 * Cloudflare KV helpers for storing per-admin bot settings + media group buffering.
 */

const KEY_ADMIN = (id) => `admin:${id}`;
const KEY_GLOBAL_STATS = "stats:global";

export const DEFAULTS = Object.freeze({
  language_mode: "auto",
  rewrite_mode: "normal",
  personality_mode: "friendly",
  footer_text: "🌀 @ILIVIR3",
  ai_provider: "openrouter",
  channel_editing_enabled: false,
  edit_intensity: 60,
  emoji_level: 20,
  active_profile: null,
  // v0.5.1: Smart Scheduling
  scheduling_enabled: false,
  schedule_delay_hours: 24,
  schedule_interval_minutes: 30,
  schedule_posts_per_day: 0,
  stats: { processed: 0, rewritten: 0, failed: 0 },
});

// ============================================================
// v0.5.1: NATIVE SCHEDULING — just store last scheduled timestamp
// ============================================================
const KEY_LAST_SCHEDULED = (channel) => `sched:last:${channel}`;

export async function getLastScheduledTime(SETTINGS, channel) {
  if (!SETTINGS || !channel) return null;
  try {
    const raw = await SETTINGS.get(KEY_LAST_SCHEDULED(channel));
    return raw ? parseInt(raw, 10) : null;
  } catch { return null; }
}

export async function setLastScheduledTime(SETTINGS, channel, timestamp) {
  if (!SETTINGS || !channel) return;
  try {
    await SETTINGS.put(KEY_LAST_SCHEDULED(channel), String(timestamp));
  } catch (e) {
    console.error("[kv] setLastScheduledTime failed:", e.message);
  }
}

/** Read the admin's settings, merged with defaults */
export async function getSettings(SETTINGS, adminId) {
  const raw = await SETTINGS.get(KEY_ADMIN(adminId));
  if (!raw) return { ...DEFAULTS, admin_id: String(adminId) };
  try {
    const parsed = JSON.parse(raw);
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

/** Increment stats counters */
export async function bumpStats(SETTINGS, adminId, field) {
  const s = await getSettings(SETTINGS, adminId);
  s.stats = s.stats || { processed: 0, rewritten: 0, failed: 0 };
  s.stats[field] = (s.stats[field] || 0) + 1;
  await saveSettings(SETTINGS, adminId, s);
  return s;
}

/** Global stats */
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
// MEDIA GROUP BUFFERING (per-item keys — no race condition)
// ============================================================
const MG_PREFIX = (groupId) => `mg:${groupId}:`;
const MG_KEY = (groupId, msgId) => `mg:${groupId}:${msgId}`;

export async function saveMediaGroupItem(SETTINGS, groupId, msgId, item) {
  if (!SETTINGS || !groupId || !msgId) return;
  await SETTINGS.put(MG_KEY(groupId, msgId), JSON.stringify(item), { expirationTtl: 120 });
}

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
    items.sort((a, b) => (a.messageId || 0) - (b.messageId || 0));
    return items;
  } catch (e) {
    console.error("[kv] listMediaGroupItems failed:", e.message);
    return [];
  }
}

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
