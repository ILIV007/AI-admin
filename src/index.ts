/**
 * src/index.ts
 * AI Admin V2 — Cloudflare Worker entry point.
 *
 * Three handlers:
 *   - fetch:     webhook (POST /webhook), health (GET /), info, debug (protected)
 *   - queue:     delegates to queue consumer (the REAL processing)
 *   - scheduled: the ONE cron trigger → runCron
 *
 * Design (fixes V1 critical bugs):
 *   - Webhook validates secret (REQUIRED), dedupes update_id, enqueues, returns
 *     200 in <50ms. Heavy work happens in the queue consumer (fixes V1 #2:
 *     ctx.waitUntil running a 90s pipeline).
 *   - No schedule_date anywhere (fixes V1 #1: scheduling via Bot API is
 *     impossible). Scheduling = D1 job + cron trigger.
 *   - Debug dashboard requires a token AND returns 404 if unset (fixes V1 #3).
 */

import type { Env, TelegramUpdate } from "./types";
import { assertEnv, isDebug } from "./config/env";
import { log, debugEvent } from "./observability/logger";
import { enqueueUpdate } from "./queue/producer";
import { runCron } from "./scheduling/cron";
import { isSeen, markSeen } from "./storage/repositories/seen-updates";
import { ensureOwnerExists } from "./storage/repositories/admins";
import { getMe, getWebhookInfo } from "./telegram/client";
import { listEvents } from "./storage/repositories/debug-events";
import { getStats } from "./storage/repositories/stats";
import { execAll } from "./storage/d1";
import queueConsumer from "./queue/consumer";

const VERSION = "2.0.0";

// ============================================================
// MAIN EXPORT
// ============================================================

export default {
  // ── HTTP fetch handler (webhook + health + debug) ──────────────
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // GET / : health check
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        name: "AI Admin",
        version: VERSION,
        time: new Date().toISOString(),
      });
    }

    // GET /api/status — public, lightweight uptime probe (UptimeRobot-friendly).
    // No D1/KV/Telegram calls. Returns only version + time + a fixed string.
    if (request.method === "GET" && url.pathname === "/api/status") {
      return json({
        ok: true,
        version: VERSION,
        time: new Date().toISOString(),
        uptime_estimate: "since first request",
      });
    }

    // GET /api/health — deep health probe (requires DEBUG_TOKEN bearer auth).
    if (request.method === "GET" && url.pathname === "/api/health") {
      return handleHealthRoute(request, env);
    }

    // /debug/* routes (protected — fixes V1 #3)
    if (url.pathname === "/debug" || url.pathname.startsWith("/debug/")) {
      return handleDebugRoute(request, url, env);
    }

    // GET /webhook/info (public-ish, low harm; returns bot identity)
    if (request.method === "GET" && url.pathname === "/webhook/info") {
      try {
        const me = await getMe(env.BOT_TOKEN);
        return json({ ok: true, bot: me });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 502);
      }
    }

    // POST /webhook — the main entry
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleWebhook(request, env, ctx);
    }

    return new Response("Not Found", { status: 404 });
  },

  // ── Queue consumer (the REAL processing) ───────────────────────
  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Delegate to the consumer module. Cast is safe: the queue is typed in
    // wrangler.toml and the producer only sends QueueMessage-shaped bodies.
    return (queueConsumer as {
      queue: (
        b: MessageBatch<unknown>,
        e: Env,
        c: ExecutionContext,
      ) => Promise<void>;
    }).queue(batch, env, ctx);
  },

  // ── Scheduled (the ONE cron trigger) ───────────────────────────
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    log("info", "cron", "scheduled trigger fired");
    try {
      await runCron(env, ctx);
    } catch (e) {
      log("error", "cron", "runCron threw", { error: String(e) });
    }
  },
};

// ============================================================
// WEBHOOK HANDLER — fast, validates, dedupes, enqueues
// ============================================================

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. Secret check (REQUIRED in V2 — fixes V1 #15)
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
    log("warn", "webhook", "403 — secret mismatch or missing");
    return new Response("Forbidden", { status: 403 });
  }

  // 2. Parse body
  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    log("warn", "webhook", "400 — invalid JSON");
    return new Response("Bad Request", { status: 400 });
  }

  // 3. Idempotency: dedupe update_id (fixes V1 #15)
  if (update.update_id != null) {
    const seen = await isSeen(env, update.update_id);
    if (seen) {
      log("info", "webhook", "duplicate update_id; skipping", {
        update_id: update.update_id,
      });
      return new Response("ok", { status: 200 });
    }
    ctx.waitUntil(markSeen(env, update.update_id));
  }

  // 4. Enqueue for async processing (fixes V1 #2 — no long waitUntil)
  try {
    await enqueueUpdate(env, update);
  } catch (e) {
    log("error", "webhook", "enqueue failed", { error: String(e) });
    // Return 500 so Telegram retries the update
    return new Response("Internal Server Error", { status: 500 });
  }

  // 5. Background: ensure owner exists + debug log
  ctx.waitUntil(
    (async () => {
      try {
        await ensureOwnerExists(env);
      } catch { /* ignore */ }
      if (isDebug(env)) {
        await debugEvent(env, "update", `update_id=${update.update_id}`, {
          type: Object.keys(update)[0],
        }).catch(() => undefined);
      }
    })(),
  );

  return new Response("ok", { status: 200 });
}

// ============================================================
// DEBUG ROUTES (protected — fixes V1 #3)
// ============================================================

async function handleDebugRoute(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  // In V2, debug access requires a DEBUG_TOKEN secret. If unset, return 404
  // (the endpoint effectively does not exist). This is the opposite of V1
  // which returned a public dashboard.
  const token = env.DEBUG_TOKEN;
  if (!token) {
    return new Response("Not Found", { status: 404 });
  }

  // Token must be sent via Authorization: Bearer <token> (never query string).
  const auth = request.headers.get("Authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided !== token) {
    return new Response("Forbidden", { status: 403 });
  }

  // GET /debug — minimal status JSON (no public HTML dashboard in V2)
  if (request.method === "GET" && url.pathname === "/debug") {
    return json({
      ok: true,
      version: VERSION,
      time: new Date().toISOString(),
      has_bot_token: !!env.BOT_TOKEN,
      has_admin_id: !!env.ADMIN_ID,
      has_kv: !!env.KV,
      has_db: !!env.DB,
      has_queue: !!env.QUEUE,
      has_webhook_secret: !!env.WEBHOOK_SECRET,
    });
  }

  // GET /debug/api/events — recent debug events
  if (request.method === "GET" && url.pathname === "/debug/api/events") {
    const kind = url.searchParams.get("kind") || undefined;
    const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);
    try {
      const rows = await listEvents(env, limit, kind);
      return json({ ok: true, events: rows });
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  }

  return new Response("Not Found", { status: 404 });
}

// ============================================================
// /api/health — deep health probe (DEBUG_TOKEN-protected)
// ============================================================

interface HealthBot {
  ok: boolean;
  username?: string;
  can_join_groups?: boolean;
  error?: string;
}

interface HealthProbe {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

interface HealthWebhook {
  ok: boolean;
  pending_update_count?: number;
  last_error_message?: string | null;
  last_error_date?: number | null;
  error?: string;
}

interface HealthStats {
  ok: boolean;
  received?: number;
  published?: number;
  failed?: number;
  error?: string;
}

/**
 * Deep health endpoint. Returns 200 with a partial JSON even when some probes
 * fail — `ok: false` flags that something is wrong, but the structure is
 * always the same so monitoring can scrape it without parsing errors.
 *
 * All probes run in parallel via Promise.all; each is individually wrapped in
 * try/catch so one failure can't abort the others. The total response time is
 * roughly the slowest probe (typically D1 or Telegram API).
 */
async function handleHealthRoute(
  request: Request,
  env: Env,
): Promise<Response> {
  // --- Auth: same DEBUG_TOKEN bearer scheme as /debug routes ---
  const token = env.DEBUG_TOKEN;
  if (!token) {
    return new Response("Not Found", { status: 404 });
  }
  const auth = request.headers.get("Authorization") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided !== token) {
    return new Response("Forbidden", { status: 403 });
  }

  const now = new Date().toISOString();

  // --- Probe: Telegram getMe (bot identity) ---
  const botProbe = (async (): Promise<HealthBot> => {
    try {
      const me = await getMe(env.BOT_TOKEN);
      return {
        ok: true,
        username: me.username,
        can_join_groups: me.can_join_groups,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();

  // --- Probe: Telegram getWebhookInfo ---
  const webhookProbe = (async (): Promise<HealthWebhook> => {
    try {
      const hook = await getWebhookInfo(env.BOT_TOKEN);
      const hasError = !!hook.last_error_message || (hook.pending_update_count ?? 0) > 5;
      return {
        ok: !hasError,
        pending_update_count: hook.pending_update_count,
        last_error_message: hook.last_error_message ?? null,
        last_error_date: hook.last_error_date ?? null,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();

  // --- Probe: D1 (SELECT 1) ---
  const d1Probe = (async (): Promise<HealthProbe> => {
    try {
      const t0 = Date.now();
      const rows = await execAll<{ ok: number }>(env.DB, "SELECT 1 as ok");
      const latencyMs = Date.now() - t0;
      const ok = rows.length > 0 && rows[0].ok === 1;
      return { ok, latencyMs };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();

  // --- Probe: KV (write + read back) ---
  const kvProbe = (async (): Promise<HealthProbe> => {
    try {
      const t0 = Date.now();
      const probeValue = `probe-${Date.now()}`;
      await env.KV.put("health:probe", probeValue, { expirationTtl: 60 });
      const readBack = await env.KV.get("health:probe");
      const latencyMs = Date.now() - t0;
      return { ok: readBack === probeValue, latencyMs };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();

  // --- Probe: global stats (read-only) ---
  const statsProbe = (async (): Promise<HealthStats> => {
    try {
      const stats = await getStats(env, "global");
      return {
        ok: true,
        received: stats.totalReceived,
        published: stats.totalPublished,
        failed: stats.totalFailed,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })();

  // Run all probes in parallel; each is internally try/caught so Promise.all
  // never rejects.
  const [bot, webhook, d1, kv, stats] = await Promise.all([
    botProbe,
    webhookProbe,
    d1Probe,
    kvProbe,
    statsProbe,
  ]);

  const ok =
    bot.ok && webhook.ok && d1.ok && kv.ok && stats.ok;

  return json({
    ok,
    version: VERSION,
    time: now,
    bot,
    d1,
    kv,
    webhook,
    stats,
  });
}

// ============================================================
// helpers
// ============================================================

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Re-export assertEnv for tooling that wants to validate at boot.
export { assertEnv, VERSION };
