/**
 * src/observability/logger.ts
 * -----------------------------------------------------------------------------
 * Structured JSON logging + optional D1 debug events.
 *
 * - log() emits a single JSON line to console.log. Cloudflare Workers'
 *   runtime captures stdout and ships it to Workers Logs / `wrangler tail`.
 *   Every line includes ts, level, scope, msg; extra is included verbatim
 *   when provided.
 *
 * - debugEvent() persists a row to D1 `debug_events` ONLY when
 *   env.DEBUG_MODE === "true". It's safe to call in hot paths when debug is
 *   off — the function short-circuits before any DB I/O. The cron job is
 *   responsible for pruning the table to the last 500 rows; we don't prune
 *   here to avoid write amplification on every event.
 * -----------------------------------------------------------------------------
 */

import type { Env } from "../types";

export type LogLevel = "info" | "warn" | "error";

export interface LogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  extra?: unknown;
}

/**
 * Emit a structured JSON log line.
 *
 * @param level  severity — info / warn / error
 * @param scope  dotted module path (e.g. "publisher.publishPost") for filtering
 * @param msg    human-readable summary
 * @param extra  optional structured payload — included verbatim
 */
export function log(
  level: LogLevel,
  scope: string,
  msg: string,
  extra?: unknown,
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg,
  };
  if (extra !== undefined) {
    entry.extra = extra;
  }
  // JSON.stringify on a small object is cheap and Workers-logs friendly.
  console.log(JSON.stringify(entry));
}

/**
 * Record a debug event to D1. No-op when DEBUG_MODE !== "true".
 *
 * @param env     Worker env (for DEBUG_MODE check + DB binding)
 * @param kind    event category — "update" | "error" | "raw" | "pipeline" | …
 * @param summary short human-readable line
 * @param detail  structured payload — JSON-stringified before storage
 */
export async function debugEvent(
  env: Env,
  kind: string,
  summary: string,
  detail: unknown,
): Promise<void> {
  // Cheap check first — never touch the DB when debug is off.
  if (env.DEBUG_MODE !== "true") return;

  try {
    const detailStr =
      typeof detail === "string" ? detail : JSON.stringify(detail);
    await env.DB.prepare(
      "INSERT INTO debug_events (kind, summary, detail, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(kind, summary, detailStr, Date.now())
      .run();
  } catch (err) {
    // Debug logging must NEVER break the request. Log and swallow.
    log("warn", "logger.debugEvent", `Failed to record: ${(err as Error).message}`, {
      kind,
      summary,
    });
  }
}
