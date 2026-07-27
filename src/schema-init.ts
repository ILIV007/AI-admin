/**
 * src/schema-init.ts
 * The D1 schema as a string — used by /Admi-bug/api/init-schema to auto-create
 * tables from the debug panel (no CLI needed).
 */

export const SCHEMA_SQL = `
-- Admins / roles
CREATE TABLE IF NOT EXISTS admins (
  user_id      INTEGER PRIMARY KEY,
  username     TEXT,
  first_name   TEXT,
  role         TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','reviewer','viewer')),
  added_at     INTEGER NOT NULL,
  added_by     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  user_id    INTEGER PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seen_updates (
  update_id   INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_updates_received ON seen_updates(received_at);

CREATE TABLE IF NOT EXISTS jobs (
  id                   TEXT PRIMARY KEY,
  type                 TEXT NOT NULL CHECK (type IN ('scheduled_post','approval')),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','published','rejected','expired','failed')),
  user_id              INTEGER NOT NULL,
  chat_id              INTEGER NOT NULL,
  message_id           INTEGER NOT NULL,
  payload              TEXT NOT NULL,
  scheduled_for        INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  published_message_id INTEGER,
  published_chat_id    INTEGER,
  error_message        TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_sched ON jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at);

CREATE TABLE IF NOT EXISTS media_group_items (
  media_group_id TEXT NOT NULL,
  message_id     INTEGER NOT NULL,
  chat_id        INTEGER NOT NULL,
  from_id        INTEGER NOT NULL,
  text           TEXT NOT NULL,
  media_type     TEXT,
  file_id        TEXT,
  file_name      TEXT,
  mime_type      TEXT,
  received_at    INTEGER NOT NULL,
  finalized      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (media_group_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_mgi_received ON media_group_items(media_group_id, received_at);

CREATE TABLE IF NOT EXISTS stats (
  key            TEXT PRIMARY KEY,
  total_received      INTEGER NOT NULL DEFAULT 0,
  total_published     INTEGER NOT NULL DEFAULT 0,
  total_rewritten     INTEGER NOT NULL DEFAULT 0,
  total_failed        INTEGER NOT NULL DEFAULT 0,
  total_approvals     INTEGER NOT NULL DEFAULT 0,
  total_rejected      INTEGER NOT NULL DEFAULT 0,
  total_scheduled     INTEGER NOT NULL DEFAULT 0,
  ai_calls            INTEGER NOT NULL DEFAULT 0,
  ai_failures         INTEGER NOT NULL DEFAULT 0,
  last_updated        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS debug_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  summary    TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debug_created ON debug_events(created_at);
`.trim();

export interface TableCheck {
  name: string;
  exists: boolean;
}

export async function checkTables(env: import("./types").Env): Promise<{
  ok: boolean;
  tables: TableCheck[];
  missing: string[];
}> {
  const expected = [
    "admins",
    "settings",
    "seen_updates",
    "jobs",
    "media_group_items",
    "stats",
    "audit_log",
    "debug_events",
  ];
  try {
    const result = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all();
    const existing = new Set((result.results || []).map((r) => r.name as string));
    const tables = expected.map((name) => ({ name, exists: existing.has(name) }));
    const missing = tables.filter((t) => !t.exists).map((t) => t.name);
    return { ok: missing.length === 0, tables, missing };
  } catch (e) {
    return {
      ok: false,
      tables: expected.map((name) => ({ name, exists: false })),
      missing: expected,
    };
  }
}

export async function initSchema(env: import("./types").Env): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    // D1 exec supports multiple statements separated by ';'
    await env.DB.exec(SCHEMA_SQL);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
