/**
 * src/storage/repositories/settings.ts
 * -----------------------------------------------------------------------------
 * Per-user + global settings repository.
 *
 * Settings are stored in D1 as a JSON blob keyed by user_id. On read we merge
 * the parsed blob over DEFAULT_SETTINGS so that new fields added in future
 * releases automatically get their default value for existing users.
 *
 * Reads are KV-cached for 30s to avoid hitting D1 on every webhook update
 * (the hot path is: webhook → queue → consumer → getSettings). Writes
 * invalidate the cache.
 *
 * "Global" settings = the owner's settings (Number(env.ADMIN_ID)).
 * -----------------------------------------------------------------------------
 */

import type { Env, Settings } from "../../types";
import { DEFAULT_SETTINGS } from "../../config/defaults";
import { exec, execAll, nowMs } from "../d1";

// ============================================================
// Constants
// ============================================================

const SETTINGS_KV_PREFIX = "settings:user";
const SETTINGS_KV_TTL_SEC = 300; // 5 min cache (was 120s — reduces KV reads by 60%)

function kvKey(userId: number): string {
  return `${SETTINGS_KV_PREFIX}:${userId}`;
}

// ============================================================
// Merge helpers
// ============================================================

/** Merge a partial settings blob over DEFAULT_SETTINGS.
 * Also applies env.FOOTER_TEXT override if set (takes priority over default).
 *
 * MIGRATION: if the stored geminiModel/openrouterModel is a known STALE value
 * (from a previous version that used wrong models), override it with the current
 * default. This ensures users always get the correct models after an update.
 */
function mergeSettings(env: Env, partial: Partial<Settings> | null | undefined): Settings {
  const base = { ...DEFAULT_SETTINGS };
  if (env.FOOTER_TEXT) {
    base.footerText = env.FOOTER_TEXT;
  }
  if (!partial) return base;

  const merged = { ...base, ...partial };

  // MIGRATION: fix stale model values from older bot versions.
  // gemini-2.5-flash and gemini-2.5-flash-lite are NOW back in the catalog
  // as last-resort fallbacks, so they are NOT stale anymore.
  const STALE_GEMINI = new Set([
    "gemini-2.0-flash", "gemini-2.0-flash-lite",
    "gemini-1.5-flash", "gemini-1.5-flash-8b",
  ]);
  const STALE_OR = new Set([
    "google/gemma-2-9b-it:free",
    "qwen/qwen-2.5-7b-instruct:free",
    "microsoft/phi-3-medium-128k-instruct:free",
    "nvidia/llama-3.1-nemotron-70b-instruct:free",
  ]);
  if (merged.geminiModel && STALE_GEMINI.has(merged.geminiModel)) {
    merged.geminiModel = DEFAULT_SETTINGS.geminiModel;
  }
  if (merged.openrouterModel && STALE_OR.has(merged.openrouterModel)) {
    merged.openrouterModel = DEFAULT_SETTINGS.openrouterModel;
  }

  return merged;
}

// ============================================================
// Public API
// ============================================================

/**
 * Read settings for a user. Falls back to DEFAULT_SETTINGS if no row exists.
 * KV-cached for 30s.
 */
export async function getSettings(env: Env, userId: number): Promise<Settings> {
  // KV cache first.
  const cached = await kvGet(env, kvKey(userId));
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as Partial<Settings>;
      return mergeSettings(env, parsed);
    } catch {
      // Corrupt cache — fall through to D1.
    }
  }

  // D1 lookup.
  const rows = await execAll<{ payload: string }>(
    env.DB,
    "SELECT payload FROM settings WHERE user_id = ?",
    userId,
  );
  if (rows.length === 0) {
    // No overrides → return defaults. Don't pollute the cache with defaults
    // (the next write will populate it), but DO cache for 30s to avoid
    // repeat D1 hits when a user has no overrides row yet.
    const defaults = mergeSettings(env, null);
    await kvPut(env, kvKey(userId), JSON.stringify(defaults), SETTINGS_KV_TTL_SEC);
    return defaults;
  }

  let parsed: Partial<Settings>;
  try {
    parsed = JSON.parse(rows[0].payload) as Partial<Settings>;
  } catch {
    // Corrupt row — fall back to defaults.
    return mergeSettings(env, null);
  }
  const settings = mergeSettings(env, parsed);
  await kvPut(env, kvKey(userId), JSON.stringify(settings), SETTINGS_KV_TTL_SEC);
  return settings;
}

/**
 * Persist settings for a user (upsert). Invalidates the KV cache so the next
 * read picks up the new value immediately.
 */
export async function saveSettings(
  env: Env,
  userId: number,
  settings: Settings,
): Promise<void> {
  const payload = JSON.stringify(settings);
  await exec(
    env.DB,
    `INSERT INTO settings (user_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       payload    = excluded.payload,
       updated_at = excluded.updated_at`,
    userId,
    payload,
    nowMs(),
  );
  await kvDelete(env, kvKey(userId));
}

/**
 * Global settings = the owner's settings. Convenience wrapper used by
 * command handlers and the dashboard.
 */
export async function getGlobalSettings(env: Env): Promise<Settings> {
  const ownerUserId = Number(env.ADMIN_ID);
  return getSettings(env, ownerUserId);
}

// ============================================================
// KV helpers (never throw)
// ============================================================

async function kvGet(env: Env, key: string): Promise<string | null> {
  try {
    return await env.AI_ADMIN_KV.get(key);
  } catch {
    return null;
  }
}

async function kvPut(
  env: Env,
  key: string,
  value: string,
  ttlSec: number,
): Promise<void> {
  try {
    await env.AI_ADMIN_KV.put(key, value, { expirationTtl: ttlSec });
  } catch {
    // ignore
  }
}

async function kvDelete(env: Env, key: string): Promise<void> {
  try {
    await env.AI_ADMIN_KV.delete(key);
  } catch {
    // ignore
  }
}
