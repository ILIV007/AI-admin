-- ============================================================
-- AI Admin V2 — D1 schema
-- SQLite (Cloudflare D1). All persistent state lives here.
-- KV is used ONLY for short-lived cache + model health cache.
-- ============================================================

-- Admins / roles
CREATE TABLE IF NOT EXISTS admins (
  user_id      INTEGER PRIMARY KEY,
  username     TEXT,
  first_name   TEXT,
  role         TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','editor','reviewer','viewer')),
  added_at     INTEGER NOT NULL,
  added_by     INTEGER NOT NULL
);

-- Per-user settings overrides (JSON blob)
CREATE TABLE IF NOT EXISTS settings (
  user_id    INTEGER PRIMARY KEY,
  payload    TEXT NOT NULL,           -- JSON: Settings
  updated_at INTEGER NOT NULL
);

-- Processed update_ids for idempotency (last 7 days retained)
CREATE TABLE IF NOT EXISTS seen_updates (
  update_id   INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seen_updates_received ON seen_updates(received_at);

-- Jobs: scheduled posts + approvals (state machine)
CREATE TABLE IF NOT EXISTS jobs (
  id                   TEXT PRIMARY KEY,           -- ulid-ish
  type                 TEXT NOT NULL CHECK (type IN ('scheduled_post','approval')),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','published','rejected','expired','failed')),
  user_id              INTEGER NOT NULL,
  chat_id              INTEGER NOT NULL,
  message_id           INTEGER NOT NULL,
  payload              TEXT NOT NULL,              -- JSON
  scheduled_for        INTEGER,                    -- epoch ms (nullable)
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  published_message_id INTEGER,
  published_chat_id    INTEGER,
  error_message        TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jobs_status_sched ON jobs(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(user_id, created_at);

-- Published posts mapping (P1-CE2: enables channel editing).
-- Maps an admin's source message to the channel message it produced, so
-- that when the admin edits their source message, the bot can edit the
-- corresponding channel post in place (within Telegram's 48h edit window).
CREATE TABLE IF NOT EXISTS published_posts (
  source_chat_id      INTEGER NOT NULL,
  source_message_id   INTEGER NOT NULL,
  published_chat_id   INTEGER NOT NULL,
  published_message_id INTEGER NOT NULL,
  published_at        INTEGER NOT NULL,
  PRIMARY KEY (source_chat_id, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_published_posts_chat_msg ON published_posts(published_chat_id, published_message_id);

-- Media group items (aggregation; finalized=0 means pending)
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

-- Stats (single global row keyed by 'global', plus per-admin rows)
CREATE TABLE IF NOT EXISTS stats (
  key            TEXT PRIMARY KEY,    -- 'global' or 'u:<user_id>'
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

-- Audit log (role changes, admin add/remove, settings changes)
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   INTEGER NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- Debug events (bounded; cron prunes to last 500)
CREATE TABLE IF NOT EXISTS debug_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,            -- 'update','error','raw','pipeline'
  summary    TEXT,
  detail     TEXT,                     -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_debug_created ON debug_events(created_at);
