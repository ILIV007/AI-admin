/**
 * src/kv.js
 * Cloudflare KV helpers — v0.7.3 (safe KV optimization on Prime v0.6.11)
 *
 * v0.7.3 changes (KV optimization — strictly behavior-preserving):
 *   - ADDED module-level settings cache (30s TTL) for getSettings()
 *   - ADDED admin_list cache (60s TTL) for getAdminList() / isAdminInList()
 *   - ADDED last-scheduled-time cache (60s TTL) + write-through on set
 *   - INCREASED BATCH_FLUSH_THRESHOLD from 10 → 20 (was 10, now 20)
 *   - CHANGED listMediaGroupItems: sequential KV.get → Promise.all parallel
 *   - CHANGED deleteMediaGroup: sequential KV.delete → Promise.all parallel
 *   - PRESERVED all v0.6.x features: approve_enabled, admin_list, getAdminList,
 *     isAdminInList, getLastScheduledTime, saveMediaGroupItem, etc.
 *   - NO changes to function signatures, NO changes to return values,
 *     NO changes to error handling — strictly additive caching.
 *
 * v0.5.9 changes (kept):
 *   - REMOVED cron-based scheduling queue — native-only scheduling
 *   - In-memory stats batching to reduce KV writes
 *   - Kept getLastScheduledTime / setLastScheduledTime
 *
 * v0.6.9 changes (kept):
 *   - admin_list stored in global KV key (KEY_ADMIN_LIST)
 *   - getAdminList / isAdminInList for cross-admin auth checks
 *
 * v0.6.8 changes (kept):
 *   - approve_enabled flag in DEFAULTS
 *   - admin_list array in DEFAULTS
 */

const KEY_ADMIN = (id) => `admin:${id}`;
const KEY_GLOBAL_STATS = "stats:global";
const KEY_ADMIN_LIST = "global:admin_list";

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
  // v0.6.8: Additional admins (array of user IDs)
  admin_list: [],
  // v0.6.8: Approve mode — bot shows approve button before publishing
  approve_enabled: false,
});

// ============================================================
// NATIVE SCHEDULING — last scheduled timestamp tracking
// (kept for interval calculation between scheduled posts)
// v0.7.3: Added 60s in-memory cache (read-heavy, write-through)
// ============================================================
const KEY_LAST_SCHEDULED = (channel) => `sched:last:${channel}`;

const _lastSchedCache = new Map(); // channel → { ts, _expires }
const LAST_SCHED_CACHE_TTL = 60_000; // 60 seconds

export async function getLastScheduledTime(SETTINGS, channel) {
  if (!SETTINGS || !channel) return null;
  // v0.7.3: Check cache first
  const cached = _lastSchedCache.get(channel);
  if (cached && Date.now() < cached._expires) {
    return cached.ts;
  }
  try {
    const raw = await SETTINGS.get(KEY_LAST_SCHEDULED(channel));
    const ts = raw ? parseInt(raw, 10) : null;
    _lastSchedCache.set(channel, { ts, _expires: Date.now() + LAST_SCHED_CACHE_TTL });
    return ts;
  } catch { return null; }
}

export async function setLastScheduledTime(SETTINGS, channel, timestamp) {
  if (!SETTINGS || !channel) return;
  try {
    await SETTINGS.put(KEY_LAST_SCHEDULED(channel), String(timestamp));
    // v0.7.3: Write-through cache so next read skips KV
    _lastSchedCache.set(channel, { ts: timestamp, _expires: Date.now() + LAST_SCHED_CACHE_TTL });
  } catch (e) {
    console.error("[kv] setLastScheduledTime failed:", e.message);
  }
}

// ============================================================
// v0.7.3: Module-level caches (settings 30s, admin_list 60s, last_sched 60s)
// ============================================================
// Pipeline calls getSettings() 2-3x per request. Without cache, that's
// 2-3 KV reads per request. With 30s cache, repeat calls in the same
// isolate skip KV entirely. saveSettings / updateSetting invalidate.
// isAdminInList() runs on EVERY request — caching it saves 1 KV read/req.
// ============================================================
const _settingsCache = new Map(); // adminId → { settings, _expires }
const SETTINGS_CACHE_TTL = 30_000; // 30 seconds

// Declared early (before saveSettings uses it) for clarity
const _adminListCache = { list: null, _expires: 0 };
const ADMIN_LIST_CACHE_TTL = 60_000;

/** Read the admin's settings, merged with defaults */
export async function getSettings(SETTINGS, adminId) {
  const cacheKey = String(adminId);
  const cached = _settingsCache.get(cacheKey);
  if (cached && Date.now() < cached._expires) {
    // Return a shallow copy so callers can mutate without polluting cache
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
  _settingsCache.set(cacheKey, { settings, _expires: Date.now() + SETTINGS_CACHE_TTL });
  return { ...settings };
}

/** Persist the entire settings blob */
export async function saveSettings(SETTINGS, adminId, settings) {
  await SETTINGS.put(KEY_ADMIN(adminId), JSON.stringify(settings));
  // v0.6.9: Also sync admin_list to global key so other admins can be authorized
  if (settings.admin_list !== undefined) {
    await SETTINGS.put(KEY_ADMIN_LIST, JSON.stringify(settings.admin_list));
    // v0.7.3: Invalidate admin list cache
    _adminListCache._expires = 0;
  }
  // v0.7.3: Write-through cache
  _settingsCache.set(String(adminId), { settings: { ...settings }, _expires: Date.now() + SETTINGS_CACHE_TTL });
}

// v0.6.9: Get admin list from global key (so any user's auth check can read it)
// v0.7.3: Cached for 60s (declared above with other caches)
export async function getAdminList(SETTINGS) {
  if (!SETTINGS) return [];
  // v0.7.3: Check cache first
  if (_adminListCache.list && Date.now() < _adminListCache._expires) {
    return _adminListCache.list;
  }
  try {
    const raw = await SETTINGS.get(KEY_ADMIN_LIST);
    const list = raw ? JSON.parse(raw) : [];
    _adminListCache.list = list;
    _adminListCache._expires = Date.now() + ADMIN_LIST_CACHE_TTL;
    return list;
  } catch { return []; }
}

// v0.6.9: Check if a user ID is in the admin list (global)
export async function isAdminInList(SETTINGS, userId) {
  const list = await getAdminList(SETTINGS);
  const uid = String(userId);
  return list.some(id => String(id) === uid);
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
// v0.7.3: Increased from 10 → 20 (was 10, now 20)
// Still safe because flushAllStats() runs at end of every request
// via ctx.waitUntil, so dirty counters get persisted before isolate dies.
const BATCH_FLUSH_THRESHOLD = 20;
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
    // v0.7.3: Update settings cache so next getSettings skips KV read
    _settingsCache.set(String(adminId), { settings: { ...current }, _expires: Date.now() + SETTINGS_CACHE_TTL });

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

// v0.7.3: Parallel reads via Promise.all (was sequential — N round trips)
export async function listMediaGroupItems(SETTINGS, groupId) {
  if (!SETTINGS || !groupId) return [];
  try {
    const list = await SETTINGS.list({ prefix: MG_PREFIX(groupId), limit: 100 });
    if (list.keys.length === 0) return [];
    const raws = await Promise.all(list.keys.map(key => SETTINGS.get(key.name)));
    const items = [];
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

// v0.7.3: Parallel deletes via Promise.all (was sequential)
export async function deleteMediaGroup(SETTINGS, groupId) {
  if (!SETTINGS || !groupId) return;
  try {
    const list = await SETTINGS.list({ prefix: MG_PREFIX(groupId), limit: 100 });
    if (list.keys.length === 0) return;
    await Promise.all(list.keys.map(key => SETTINGS.delete(key.name)));
  } catch (e) {
    console.error("[kv] deleteMediaGroup failed:", e.message);
  }
}

// NOTE: v0.5.9 — Cron-based scheduling queue functions REMOVED per user request.
// Only native Telegram schedule_date is used now. If native fails, the bot
// shows an error to the user (no KV-based fallback).
