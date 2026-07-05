/**
 * src/kv.js
 * Cloudflare KV helpers — v0.5.9
 *
 * v0.5.9 changes:
 *   - REMOVED cron-based scheduling queue (enqueueScheduled, listDueScheduled,
 *     deleteScheduledItem, SCHED_QUEUE_PREFIX) — user wants native-only scheduling
 *   - ADDED in-memory stats batching to reduce KV writes (TASK 4)
 *   - Kept getLastScheduledTime / setLastScheduledTime (still needed for interval tracking)
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
// NATIVE SCHEDULING — last scheduled timestamp tracking
// (kept for interval calculation between scheduled posts)
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

// v0.7.0: Module-level settings cache — avoids redundant getSettings reads
const _settingsCache = new Map();
const SETTINGS_CACHE_TTL = 30_000; // 30 seconds

/** Read the admin's settings, merged with defaults */
export async function getSettings(SETTINGS, adminId) {
  const cacheKey = String(adminId);
  const cached = _settingsCache.get(cacheKey);
  if (cached && (Date.now() - cached._ts < SETTINGS_CACHE_TTL)) {
    return { ...cached.settings };
  }

  const raw = await SETTINGS.get(KEY_ADMIN(adminId));
  let settings;
  if (!raw) {
    settings = { ...DEFAULTS, admin_id: String(adminId) };
  } else {
    try {
      const parsed = JSON.parse(raw);
      settings = { ...DEFAULTS, ...parsed, admin_id: String(adminId) };
    } catch {
      settings = { ...DEFAULTS, admin_id: String(adminId) };
    }
  }
  _settingsCache.set(cacheKey, { settings, _ts: Date.now() });
  return settings;
}

/** Persist the entire settings blob */
export async function saveSettings(SETTINGS, adminId, settings) {
  await SETTINGS.put(KEY_ADMIN(adminId), JSON.stringify(settings));
  // v0.7.0: Update cache
  _settingsCache.set(String(adminId), { settings: { ...settings }, _ts: Date.now() });
}

/** Update a single field, returning the new merged settings */
export async function updateSetting(SETTINGS, adminId, key, value) {
  const current = await getSettings(SETTINGS, adminId);
  const next = { ...current, [key]: value };
  await saveSettings(SETTINGS, adminId, next);
  return next;
}

// ============================================================
// v0.5.9 TASK 4: BATCHED STATS — reduces KV writes drastically
// ============================================================
// Problem: Free tier = 1,000 KV writes/day. Old code did Read+Write
// on EVERY pipeline run (bumpStats + bumpGlobalStats = 4 writes per post).
// A busy channel would exhaust the daily quota in ~250 posts.
//
// Solution: In-memory counters per Worker isolate. Increment in memory,
// flush to KV every BATCH_FLUSH_THRESHOLD calls OR when explicitly flushed.
// Since CF Workers isolates are ephemeral, we may lose a few increments
// when the isolate dies — but that's an acceptable tradeoff vs. hitting
// the write quota. Stats are "best effort", not "exact".
// ============================================================
const BATCH_FLUSH_THRESHOLD = 20; // v0.7.0: flush to KV every 20 increments (was 10)
const _statsCache = {
  perAdmin: new Map(), // adminId → { processed, rewritten, failed, _count }
  global: { processed: 0, rewritten: 0, failed: 0, _count: 0 },
};

/**
 * Increment a per-admin stat counter.
 * Uses in-memory batching: only writes to KV every BATCH_FLUSH_THRESHOLD calls.
 * Falls back to immediate write if cache miss (first increment for an admin).
 */
export async function bumpStats(SETTINGS, adminId, field) {
  if (!SETTINGS || !adminId || !field) return null;

  // Get or create cache entry for this admin
  let entry = _statsCache.perAdmin.get(adminId);
  if (!entry) {
    entry = { processed: 0, rewritten: 0, failed: 0, _count: 0 };
    _statsCache.perAdmin.set(adminId, entry);
  }

  entry[field] = (entry[field] || 0) + 1;
  entry._count++;

  // Flush to KV when threshold reached
  if (entry._count >= BATCH_FLUSH_THRESHOLD) {
    await _flushAdminStats(SETTINGS, adminId);
  }

  return entry;
}

/**
 * Increment a global stat counter (same batching logic as bumpStats).
 */
export async function bumpGlobalStats(SETTINGS, field) {
  if (!SETTINGS || !field) return null;

  _statsCache.global[field] = (_statsCache.global[field] || 0) + 1;
  _statsCache.global._count++;

  if (_statsCache.global._count >= BATCH_FLUSH_THRESHOLD) {
    await _flushGlobalStats(SETTINGS);
  }

  return _statsCache.global;
}

/** Flush a specific admin's cached stats to KV */
async function _flushAdminStats(SETTINGS, adminId) {
  const entry = _statsCache.perAdmin.get(adminId);
  if (!entry || entry._count === 0) return;

  try {
    const current = await getSettings(SETTINGS, adminId);
    current.stats = current.stats || { processed: 0, rewritten: 0, failed: 0 };
    current.stats.processed = (current.stats.processed || 0) + entry.processed;
    current.stats.rewritten = (current.stats.rewritten || 0) + entry.rewritten;
    current.stats.failed = (current.stats.failed || 0) + entry.failed;
    await SETTINGS.put(KEY_ADMIN(adminId), JSON.stringify(current));

    // Reset cache counters (keep the map entry for fast access)
    entry.processed = 0;
    entry.rewritten = 0;
    entry.failed = 0;
    entry._count = 0;
  } catch (e) {
    console.error("[kv] _flushAdminStats failed:", e.message);
  }
}

/** Flush global cached stats to KV */
async function _flushGlobalStats(SETTINGS) {
  const g = _statsCache.global;
  if (g._count === 0) return;

  try {
    const cur = await getGlobalStats(SETTINGS);
    cur.processed = (cur.processed || 0) + g.processed;
    cur.rewritten = (cur.rewritten || 0) + g.rewritten;
    cur.failed = (cur.failed || 0) + g.failed;
    await SETTINGS.put(KEY_GLOBAL_STATS, JSON.stringify(cur));

    g.processed = 0;
    g.rewritten = 0;
    g.failed = 0;
    g._count = 0;
  } catch (e) {
    console.error("[kv] _flushGlobalStats failed:", e.message);
  }
}

/**
 * Flush ALL pending stats to KV. Call this at the end of a request
 * (via ctx.waitUntil) to ensure no increments are lost.
 */
export async function flushAllStats(SETTINGS) {
  if (!SETTINGS) return;
  const adminIds = Array.from(_statsCache.perAdmin.keys());
  await Promise.all([
    ...adminIds.map((id) => _flushAdminStats(SETTINGS, id)),
    _flushGlobalStats(SETTINGS),
  ]);
}

/** Global stats read (merges cache + KV) */
export async function getGlobalStats(SETTINGS) {
  if (!SETTINGS) return { processed: 0, rewritten: 0, failed: 0 };
  const raw = await SETTINGS.get(KEY_GLOBAL_STATS);
  const base = raw ? (() => { try { return JSON.parse(raw); } catch { return { processed: 0, rewritten: 0, failed: 0 }; } })() : { processed: 0, rewritten: 0, failed: 0 };
  // Merge with unflushed cache
  return {
    processed: (base.processed || 0) + (_statsCache.global.processed || 0),
    rewritten: (base.rewritten || 0) + (_statsCache.global.rewritten || 0),
    failed: (base.failed || 0) + (_statsCache.global.failed || 0),
  };
}

// ============================================================
// MEDIA GROUP BUFFERING (per-item keys — no race condition)
// ============================================================
const MG_PREFIX = (groupId) => `mg:${groupId}:`;
const MG_KEY = (groupId, msgId) => `mg:${groupId}:${msgId}`;

export async function saveMediaGroupItem(SETTINGS, groupId, msgId, item) {
  if (!SETTINGS || !groupId || !msgId) return;
  await SETTINGS.put(MG_KEY(groupId, msgId), JSON.stringify(item), { expirationTtl: 180 });
}

export async function listMediaGroupItems(SETTINGS, groupId) {
  if (!SETTINGS || !groupId) return [];
  try {
    const list = await SETTINGS.list({ prefix: MG_PREFIX(groupId), limit: 100 });
    const items = [];
    // v0.7.0: Use Promise.all for parallel reads (was sequential — N reads = N round trips)
    const raws = await Promise.all(list.keys.map(key => SETTINGS.get(key.name)));
    for (const raw of raws) {
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
    // v0.7.0: Use Promise.all for parallel deletes (was sequential)
    await Promise.all(list.keys.map(key => SETTINGS.delete(key.name)));
  } catch (e) {
    console.error("[kv] deleteMediaGroup failed:", e.message);
  }
}

// NOTE: v0.5.9 — Cron-based scheduling queue functions REMOVED per user request.
// Only native Telegram schedule_date is used now. If native fails, the bot
// shows an error to the user (no KV-based fallback).
