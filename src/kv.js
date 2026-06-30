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
  ai_provider: "openrouter", // Default to OpenRouter (Gemini often hits 429 on free tier)
  channel_editing_enabled: false,
  // edit_intensity controls BOTH AI rewrite strength AND formatter formatting level
  //   0%   = format only (no AI, just links + footer in quotes)
  //   20%  = minimal (links + footer in quotes, NO paragraph quoting)
  //   40%  = light rewrite + light formatting (quote long paragraphs)
  //   60%  = DEFAULT — quote long paragraphs + bold key terms + moderate rewrite
  //   80%  = strong rewrite + heavy formatting + more emoji
  //   100% = maximum — full rewrite + heavy quoting + bold everywhere + heavy emoji
  edit_intensity: 60,
  // emoji_level controls how many emojis the AI adds (0-100%)
  //   0%   = no emojis
  //   20%  = DEFAULT — minimal emojis (1-3) for visual polish
  //   50%  = moderate (3-5 emojis)
  //   100% = heavy (lots of emojis)
  emoji_level: 20,
  stats: { processed: 0, rewritten: 0, failed: 0 },
});

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
