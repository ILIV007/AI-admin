/**
 * src/storage/repositories/admins.ts
 * -----------------------------------------------------------------------------
 * Admin / role repository + authorization cache.
 *
 * Authorization is hot-path: every webhook update triggers an isAuthorized()
 * check. We avoid a D1 round-trip per request by caching the binary decision
 * in KV for 60s. Role mutations (upsertAdmin / removeAdmin) invalidate the KV
 * cache so changes take effect immediately.
 *
 * The owner is bootstrapped lazily by ensureOwnerExists(), which is called from
 * the webhook boot path AND from the cron (defensive — in case the webhook
 * hasn't run yet, e.g. fresh deploy with the cron firing first).
 *
 * Authz rules (V2):
 *   - userId === Number(env.ADMIN_ID) → owner (always authorized, even if the
 *     admins row is somehow missing — defensive).
 *   - Otherwise → authorized iff a row exists in `admins`.
 *   - Role-based permissions (editor/reviewer/viewer) are enforced in the
 *     command handlers, not here; this module only answers "is this user an
 *     admin at all" and "what role".
 * -----------------------------------------------------------------------------
 */

import type { AdminRecord, Env, Role } from "../../types";
import { exec, execAll, nowMs } from "../d1";
import { log } from "../../observability/logger";

// ============================================================
// KV cache constants
// ============================================================

const AUTH_KV_PREFIX = "auth:user";
const AUTH_CACHE_TTL_SEC = 120; // 2 min cache (was 60s — reduces KV reads)

function authKvKey(userId: number): string {
  return `${AUTH_KV_PREFIX}:${userId}`;
}

// ============================================================
// Row mapping
// ============================================================

interface AdminRow {
  user_id: number;
  username: string | null;
  first_name: string | null;
  role: string;
  added_at: number;
  added_by: number;
}

function rowToAdmin(r: AdminRow): AdminRecord {
  return {
    userId: r.user_id,
    username: r.username ?? undefined,
    firstName: r.first_name ?? undefined,
    role: r.role as Role,
    addedAt: r.added_at,
    addedBy: r.added_by,
  };
}

// ============================================================
// CRUD
// ============================================================

export async function getAdmin(env: Env, userId: number): Promise<AdminRecord | null> {
  const rows = await execAll<AdminRow>(
    env.DB,
    "SELECT user_id, username, first_name, role, added_at, added_by FROM admins WHERE user_id = ?",
    userId,
  );
  return rows.length > 0 ? rowToAdmin(rows[0]) : null;
}

export async function listAdmins(env: Env): Promise<AdminRecord[]> {
  const rows = await execAll<AdminRow>(
    env.DB,
    "SELECT user_id, username, first_name, role, added_at, added_by FROM admins ORDER BY added_at ASC",
  );
  return rows.map(rowToAdmin);
}

export async function upsertAdmin(env: Env, rec: AdminRecord): Promise<void> {
  await exec(
    env.DB,
    `INSERT INTO admins (user_id, username, first_name, role, added_at, added_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       username   = excluded.username,
       first_name = excluded.first_name,
       role       = excluded.role,
       added_at   = excluded.added_at,
       added_by   = excluded.added_by`,
    rec.userId,
    rec.username ?? null,
    rec.firstName ?? null,
    rec.role,
    rec.addedAt,
    rec.addedBy,
  );
  // Invalidate the auth cache so the role change takes effect immediately.
  await kvDelete(env, authKvKey(rec.userId));
}

export async function removeAdmin(env: Env, userId: number): Promise<void> {
  await exec(env.DB, "DELETE FROM admins WHERE user_id = ?", userId);
  await kvDelete(env, authKvKey(userId));
}

// ============================================================
// Authorization
// ============================================================

/**
 * Return true iff `userId` is authorized (i.e. is an admin or the configured
 * owner). Result is cached in KV for 60s; cache misses fall through to D1.
 */
export async function isAuthorized(env: Env, userId: number): Promise<boolean> {
  // Owner is always authorized — defensive; the owner row may not exist yet
  // (ensureOwnerExists hasn't run) but the owner must never be locked out.
  const owner = Number(env.ADMIN_ID);
  if (userId === owner) return true;

  // KV cache.
  const cached = await kvGet(env, authKvKey(userId));
  if (cached === "1") return true;
  if (cached === "0") return false;

  // D1 lookup.
  const admin = await getAdmin(env, userId);
  const ok = admin !== null;

  // Write back to KV (best-effort).
  await kvPut(env, authKvKey(userId), ok ? "1" : "0", AUTH_CACHE_TTL_SEC);
  return ok;
}

export async function getRole(env: Env, userId: number): Promise<Role | null> {
  const admin = await getAdmin(env, userId);
  return admin?.role ?? null;
}

export async function isOwner(env: Env, userId: number): Promise<boolean> {
  // Fast path: env.ADMIN_ID is the canonical owner identifier.
  if (userId === Number(env.ADMIN_ID)) return true;
  const admin = await getAdmin(env, userId);
  return admin?.role === "owner";
}

/**
 * Idempotent: insert the configured ADMIN_ID as an owner if no admin row
 * exists for them yet. Called from webhook boot and the cron trigger.
 */
export async function ensureOwnerExists(env: Env): Promise<void> {
  const ownerUserId = Number(env.ADMIN_ID);
  if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
    log("warn", "admins.ensureOwnerExists", "ADMIN_ID not set or invalid", {
      ADMIN_ID: env.ADMIN_ID,
    });
    return;
  }
  const existing = await getAdmin(env, ownerUserId);
  if (existing) return;
  await upsertAdmin(env, {
    userId: ownerUserId,
    role: "owner",
    addedAt: nowMs(),
    addedBy: ownerUserId, // self-bootstrap
  });
  log("info", "admins.ensureOwnerExists", "bootstrapped owner row", {
    userId: ownerUserId,
  });
}

// ============================================================
// Audit log
// ============================================================

/**
 * Append a row to `audit_log`. Used for role changes, admin add/remove,
 * settings changes — anything we want a tamper-evident record of.
 */
export async function audit(
  env: Env,
  actorId: number,
  action: string,
  target: string,
  detail: string,
): Promise<void> {
  await exec(
    env.DB,
    "INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)",
    actorId,
    action,
    target,
    detail,
    nowMs(),
  );
}

// ============================================================
// KV helpers (never throw — cache failures are non-fatal)
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
    // ignore — non-fatal
  }
}

async function kvDelete(env: Env, key: string): Promise<void> {
  try {
    await env.AI_ADMIN_KV.delete(key);
  } catch {
    // ignore — non-fatal
  }
}
