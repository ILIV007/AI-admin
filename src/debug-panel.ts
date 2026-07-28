/**
 * src/debug-panel.ts
 * Professional Admin + Debug panel at /Admi-bug (English, enhanced UI).
 *
 * Auth: requires DEBUG_TOKEN (Bearer header or ?token= query param).
 * If DEBUG_TOKEN is not set, returns 404.
 */

import type { Env } from "./types";
import { checkTables, initSchema } from "./schema-init";
import { runFormatterSelfTests } from "./formatting/self-test";
import { getMe, getWebhookInfo, sendMessage } from "./telegram/client";
import { listEvents } from "./storage/repositories/debug-events";
import { getStats } from "./storage/repositories/stats";
import { ensureOwnerExists } from "./storage/repositories/admins";
import { refreshModelHealth } from "./ai/fallback";

const VERSION = "2.3.0";

// ============================================================
// AUTH
// ============================================================

export function checkPanelAuth(request: Request, env: Env): boolean {
  const token = env.DEBUG_TOKEN;
  if (!token) return false;
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ") && auth.slice(7) === token) return true;
  const url = new URL(request.url);
  const qp = url.searchParams.get("token");
  if (qp && qp === token) return true;
  return false;
}

// ============================================================
// ROUTER
// ============================================================

export async function handlePanelRoute(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  if (!env.DEBUG_TOKEN) {
    return new Response("Not Found", { status: 404 });
  }

  if (!checkPanelAuth(request, env)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Unauthorized. Use ?token=DEBUG_TOKEN or Authorization: Bearer DEBUG_TOKEN" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // GET /Admi-bug → HTML panel
  if (request.method === "GET" && (url.pathname === "/Admi-bug" || url.pathname === "/Admi-bug/")) {
    return new Response(panelHTML(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (request.method === "GET" && url.pathname === "/Admi-bug/api/status") {
    return handleStatus(env);
  }

  if (request.method === "GET" && url.pathname === "/Admi-bug/api/tables") {
    const result = await checkTables(env);
    return json({ ok: result.ok, tables: result.tables, missing: result.missing });
  }

  if (request.method === "POST" && url.pathname === "/Admi-bug/api/init-schema") {
    const result = await initSchema(env);
    if (result.ok) {
      try { await ensureOwnerExists(env); } catch { /* ignore */ }
    }
    return json({ ok: result.ok, error: result.error });
  }

  if (request.method === "POST" && url.pathname === "/Admi-bug/api/test-message") {
    try {
      const me = await getMe(env.BOT_TOKEN);
      const text = `🧪 Test message from debug panel\n\nBot: @${me.username}\nTime: ${new Date().toISOString()}\nVersion: ${VERSION}`;
      await sendMessage(env.BOT_TOKEN, {
        chat_id: Number(env.ADMIN_ID),
        text,
        parse_mode: "HTML",
      });
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  if (request.method === "POST" && url.pathname === "/Admi-bug/api/self-test") {
    try {
      const result = runFormatterSelfTests();
      return json({ ok: true, ...result });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  if (request.method === "GET" && url.pathname === "/Admi-bug/api/events") {
    try {
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      const events = await listEvents(env, limit);
      return json({ ok: true, events });
    } catch (e) {
      return json({ ok: false, error: String(e), events: [] });
    }
  }

  if (request.method === "GET" && url.pathname === "/Admi-bug/api/stats") {
    try {
      const stats = await getStats(env, "global");
      return json({ ok: true, stats });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  if (request.method === "POST" && url.pathname === "/Admi-bug/api/refresh-health") {
    try {
      await refreshModelHealth(env);
      return json({ ok: true, message: "Model health refreshed" });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  if (request.method === "POST" && url.pathname === "/Admi-bug/api/ensure-owner") {
    try {
      await ensureOwnerExists(env);
      return json({ ok: true, message: "Owner ensured", ownerId: Number(env.ADMIN_ID) });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  // GET /Admi-bug/api/history → last 10 published jobs
  if (request.method === "GET" && url.pathname === "/Admi-bug/api/history") {
    try {
      const result = await env.DB.prepare(
        "SELECT id, type, status, user_id, chat_id, message_id, created_at, updated_at, published_message_id, error_message FROM jobs ORDER BY created_at DESC LIMIT 10",
      ).all();
      return json({ ok: true, jobs: result.results || [] });
    } catch (e) {
      return json({ ok: false, error: String(e), jobs: [] });
    }
  }

  // GET /Admi-bug/api/models → list all AI models with health
  if (request.method === "GET" && url.pathname === "/Admi-bug/api/models") {
    try {
      const { GEMINI_MODELS, OPENROUTER_MODELS } = await import("./config/defaults");
      const allModels = [
        ...GEMINI_MODELS.map((m) => ({ ...m, provider: "gemini" as const })),
        ...OPENROUTER_MODELS.map((m) => ({ ...m, provider: "openrouter" as const })),
      ];
      const withHealth = await Promise.all(
        allModels.map(async (m) => {
          const key = `ai:health:${m.provider}:${m.id}`;
          let health: { healthy?: boolean; lastCheck?: number; consecutiveFailures?: number } | null = null;
          try {
            const raw = await env.AI_ADMIN_KV.get(key);
            if (raw) health = JSON.parse(raw);
          } catch { /* ignore */ }
          return {
            id: m.id,
            label: m.label,
            provider: m.provider,
            maxTokens: m.maxTokens,
            notes: m.notes,
            healthy: health?.healthy ?? null,
            lastCheck: health?.lastCheck ?? null,
            consecutiveFailures: health?.consecutiveFailures ?? 0,
          };
        }),
      );
      return json({ ok: true, models: withHealth });
    } catch (e) {
      return json({ ok: false, error: String(e), models: [] });
    }
  }

  // POST /Admi-bug/api/test-model → test a specific AI model with a simple prompt
  if (request.method === "POST" && url.pathname === "/Admi-bug/api/test-model") {
    try {
      const body = (await request.json()) as { provider: string; model: string };
      const t0 = Date.now();
      let result: { ok: boolean; text?: string; latencyMs: number; error?: string };

      if (body.provider === "gemini") {
        const url2 = `https://generativelanguage.googleapis.com/v1beta/models/${body.model}:generateContent?key=${env.GEMINI_API_KEY}`;
        const resp = await fetch(url2, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Say 'hello' in one word." }], role: "user" }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 50 },
          }),
        });
        const data = (await resp.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
          error?: { message?: string };
        };
        if (resp.ok && data.candidates?.[0]?.content?.parts?.[0]?.text) {
          result = { ok: true, text: data.candidates[0].content.parts[0].text.trim(), latencyMs: Date.now() - t0 };
        } else {
          result = { ok: false, latencyMs: Date.now() - t0, error: data.error?.message || "Unknown error" };
        }
      } else if (body.provider === "openrouter") {
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://ilivir3.bot",
            "X-Title": "AI Admin Panel Test",
          },
          body: JSON.stringify({
            model: body.model,
            messages: [{ role: "user", content: "Say 'hello' in one word." }],
            max_tokens: 50,
          }),
        });
        const data = (await resp.json()) as {
          choices?: { message?: { content?: string } }[];
          error?: { message?: string };
        };
        if (resp.ok && data.choices?.[0]?.message?.content) {
          result = { ok: true, text: data.choices[0].message.content.trim(), latencyMs: Date.now() - t0 };
        } else {
          result = { ok: false, latencyMs: Date.now() - t0, error: data.error?.message || "Unknown error" };
        }
      } else {
        result = { ok: false, latencyMs: 0, error: "Unknown provider: " + body.provider };
      }
      // Return result fields (don't spread `ok` twice)
      return json({ ...result });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  return new Response("Not Found", { status: 404 });
}

// ============================================================
// STATUS
// ============================================================

async function handleStatus(env: Env): Promise<Response> {
  const status: Record<string, unknown> = {
    ok: true,
    version: VERSION,
    time: new Date().toISOString(),
    secrets: {
      BOT_TOKEN: !!env.BOT_TOKEN,
      WEBHOOK_SECRET: !!env.WEBHOOK_SECRET,
      GEMINI_API_KEY: !!env.GEMINI_API_KEY,
      OPENROUTER_API_KEY: !!env.OPENROUTER_API_KEY,
      ADMIN_ID: !!env.ADMIN_ID,
      TARGET_CHANNEL: !!env.TARGET_CHANNEL,
      FOOTER_TEXT: !!env.FOOTER_TEXT,
      DEBUG_TOKEN: !!env.DEBUG_TOKEN,
    },
    bindings: {
      DB: !!env.DB,
      AI_ADMIN_KV: !!env.AI_ADMIN_KV,
      QUEUE: !!env.QUEUE,
    },
    vars: {
      DEFAULT_AI_PROVIDER: env.DEFAULT_AI_PROVIDER || "(unset)",
      GEMINI_MODEL: env.GEMINI_MODEL || "(unset)",
      OPENROUTER_MODEL: env.OPENROUTER_MODEL || "(unset)",
      DEBUG_MODE: env.DEBUG_MODE || "false",
      CHANNEL_PROFILE: env.CHANNEL_PROFILE || "ilivir3",
    },
    config: {
      adminId: env.ADMIN_ID ? Number(env.ADMIN_ID) : null,
      targetChannel: env.TARGET_CHANNEL || "(unset)",
      footerText: env.FOOTER_TEXT || "(default: 🌀 @ILIVIR3)",
    },
  };

  // WEBHOOK_SECRET is OPTIONAL — just note if it's unset (no critical error)
  if (!env.WEBHOOK_SECRET) {
    (status as Record<string, unknown>).warning = "WEBHOOK_SECRET is not set. Webhook accepts all requests (no auth). Set it as a Secret for better security.";
  }

  try {
    const me = await getMe(env.BOT_TOKEN);
    status.botApi = { ok: true, username: me.username, firstName: me.first_name, canJoinGroups: me.can_join_groups };
  } catch (e) {
    status.botApi = { ok: false, error: String(e) };
    status.ok = false;
  }

  try {
    const wh = await getWebhookInfo(env.BOT_TOKEN);
    status.webhook = {
      ok: true,
      url: wh.url,
      pendingUpdateCount: wh.pending_update_count,
      lastErrorMessage: wh.last_error_message,
      lastErrorDate: wh.last_error_date,
      maxConnections: wh.max_connections,
    };
    if (wh.last_error_message) status.ok = false;
  } catch (e) {
    status.webhook = { ok: false, error: String(e) };
  }

  try {
    const t0 = Date.now();
    await env.DB.prepare("SELECT 1 as ok").first();
    status.d1 = { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    status.d1 = { ok: false, error: String(e) };
    status.ok = false;
  }

  try {
    const t0 = Date.now();
    await env.AI_ADMIN_KV.put("panel:probe", "1", { expirationTtl: 60 });
    const v = await env.AI_ADMIN_KV.get("panel:probe");
    status.kv = { ok: v === "1", latencyMs: Date.now() - t0 };
  } catch (e) {
    status.kv = { ok: false, error: String(e) };
  }

  try {
    const tablesCheck = await checkTables(env);
    status.tables = tablesCheck;
    if (!tablesCheck.ok) status.ok = false;
  } catch (e) {
    status.tables = { ok: false, error: String(e) };
  }

  return json(status);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ============================================================
// HTML PANEL — Professional English UI
// ============================================================

function panelHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Admin — Control Panel</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0a0e1a;
    --surface: #131826;
    --surface2: #1a2033;
    --border: #2a3142;
    --text: #e4e7ec;
    --text-muted: #8b95a7;
    --emerald: #10b981;
    --emerald-dark: #059669;
    --red: #ef4444;
    --amber: #f59e0b;
    --sky: #0ea5e9;
    --violet: #8b5cf6;
  }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    padding: 1rem;
    line-height: 1.5;
  }
  .container { max-width: 1200px; margin: 0 auto; }

  /* Header */
  header {
    background: linear-gradient(135deg, #059669 0%, #0d9488 50%, #0891b2 100%);
    padding: 2rem;
    border-radius: 16px;
    margin-bottom: 1.5rem;
    box-shadow: 0 10px 40px rgba(5,150,105,0.25);
    position: relative;
    overflow: hidden;
  }
  header::before {
    content: '';
    position: absolute;
    top: -50%; right: -20%;
    width: 400px; height: 400px;
    background: radial-gradient(circle, rgba(255,255,255,0.1) 0%, transparent 70%);
    border-radius: 50%;
  }
  header h1 {
    font-size: 1.75rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  header p {
    opacity: 0.9;
    font-size: 0.95rem;
    position: relative;
  }
  .header-badges {
    display: flex;
    gap: 0.5rem;
    margin-top: 1rem;
    position: relative;
    flex-wrap: wrap;
  }
  .badge {
    background: rgba(255,255,255,0.15);
    backdrop-filter: blur(10px);
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 600;
    border: 1px solid rgba(255,255,255,0.2);
  }

  /* Alerts */
  #alert-container { margin-bottom: 1rem; }
  .alert {
    padding: 1rem 1.25rem;
    border-radius: 10px;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    border: 1px solid;
  }
  .alert-error { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.3); color: #fca5a5; }
  .alert-success { background: rgba(16,185,129,0.1); border-color: rgba(16,185,129,0.3); color: #6ee7b7; }
  .alert-warning { background: rgba(245,158,11,0.1); border-color: rgba(245,158,11,0.3); color: #fcd34d; }
  .alert-icon { font-size: 1.25rem; flex-shrink: 0; }
  .alert-content { flex: 1; }
  .alert-title { font-weight: 700; margin-bottom: 0.25rem; }
  .alert-code {
    background: rgba(0,0,0,0.3);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
    font-family: 'SF Mono', Monaco, monospace;
    font-size: 0.75rem;
    margin-top: 0.5rem;
    display: inline-block;
  }

  /* Action bar */
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
    background: var(--surface);
    padding: 1rem;
    border-radius: 12px;
    border: 1px solid var(--border);
  }
  button {
    background: var(--emerald-dark);
    color: white;
    border: none;
    padding: 0.625rem 1.125rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.8125rem;
    font-weight: 600;
    transition: all 0.15s ease;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  button:hover { background: var(--emerald); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(16,185,129,0.3); }
  button:active { transform: translateY(0); }
  button:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  button.danger { background: var(--red); }
  button.danger:hover { background: #dc2626; box-shadow: 0 4px 12px rgba(239,68,68,0.3); }
  button.secondary { background: var(--surface2); border: 1px solid var(--border); }
  button.secondary:hover { background: var(--border); box-shadow: none; }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  .tab {
    padding: 0.625rem 1.25rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--text-muted);
    font-size: 0.8125rem;
    font-weight: 600;
    white-space: nowrap;
    transition: all 0.15s;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--emerald); border-bottom-color: var(--emerald); }
  .tab-content { display: none; }
  .tab-content.active { display: block; animation: fadeIn 0.2s ease; }
  @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }

  /* Cards */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.25rem;
    transition: border-color 0.15s;
  }
  .card:hover { border-color: var(--emerald); }
  .card h2 {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    margin-bottom: 0.875rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 700;
  }
  .status-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--border);
    font-size: 0.8125rem;
  }
  .status-item:last-child { border-bottom: none; }
  .status-label { color: var(--text-muted); font-family: 'SF Mono', Monaco, monospace; font-size: 0.75rem; }
  .status-value { font-weight: 600; }
  .ok { color: var(--emerald); }
  .err { color: var(--red); }
  .warn { color: var(--amber); }
  .muted { color: var(--text-muted); }

  /* Pills */
  .pill {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  .pill-ok { background: rgba(16,185,129,0.15); color: var(--emerald); }
  .pill-err { background: rgba(239,68,68,0.15); color: var(--red); }
  .pill-warn { background: rgba(245,158,11,0.15); color: var(--amber); }

  /* Code blocks */
  pre {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 1rem;
    overflow-x: auto;
    font-size: 0.75rem;
    line-height: 1.6;
    max-height: 500px;
    overflow-y: auto;
    font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
    color: #a5b4fc;
  }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border); }
  th { color: var(--text-muted); font-weight: 600; font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.05em; }
  td code { background: var(--surface2); padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.75rem; }

  /* Spinner */
  .spinner {
    display: inline-block;
    width: 14px; height: 14px;
    border: 2px solid rgba(255,255,255,0.2);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* Footer */
  footer {
    text-align: center;
    padding: 2rem 1rem;
    color: var(--text-muted);
    font-size: 0.75rem;
  }
  footer a { color: var(--emerald); text-decoration: none; }

  /* Critical banner */
  .critical-banner {
    background: linear-gradient(135deg, rgba(239,68,68,0.15), rgba(239,68,68,0.05));
    border: 2px solid rgba(239,68,68,0.4);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1rem;
    display: flex;
    gap: 1rem;
    align-items: flex-start;
  }
  .critical-banner-icon { font-size: 2rem; }
  .critical-banner-content { flex: 1; }
  .critical-banner-title { font-size: 1.125rem; font-weight: 700; color: #fca5a5; margin-bottom: 0.5rem; }
  .critical-banner-text { color: #fca5a5; font-size: 0.875rem; line-height: 1.6; }
  .critical-banner-text code { background: rgba(0,0,0,0.3); padding: 0.125rem 0.375rem; border-radius: 4px; font-size: 0.8125rem; }
  .critical-banner-steps { margin-top: 0.75rem; padding-left: 1.25rem; }
  .critical-banner-steps li { margin-bottom: 0.25rem; }

  /* Loading state */
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 2rem;
    color: var(--text-muted);
    font-size: 0.875rem;
  }

  @media (max-width: 640px) {
    header { padding: 1.25rem; }
    header h1 { font-size: 1.25rem; }
    .actions { padding: 0.75rem; }
    button { padding: 0.5rem 0.875rem; font-size: 0.75rem; }
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🤖 AI Admin — Control Panel</h1>
    <p>Manage, debug, and monitor your Telegram bot</p>
    <div class="header-badges">
      <span class="badge">v${VERSION}</span>
      <span class="badge">Cloudflare Workers</span>
      <span class="badge">Free Tier</span>
    </div>
  </header>

  <div id="alert-container"></div>

  <div class="actions">
    <button onclick="loadStatus()">📊 Refresh Status</button>
    <button onclick="initSchema()" class="danger">🗄️ Init Schema</button>
    <button onclick="testMessage()">📨 Send Test</button>
    <button onclick="runSelfTest()">🧪 Run Self-Tests</button>
    <button onclick="ensureOwner()" class="secondary">👑 Ensure Owner</button>
    <button onclick="refreshHealth()" class="secondary">🔄 Refresh Models</button>
    <button onclick="loadEvents()" class="secondary">📜 View Logs</button>
    <button onclick="loadStats()" class="secondary">📈 Stats</button>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab(event,'status')">Status</div>
    <div class="tab" onclick="switchTab(event,'tables')">Tables</div>
    <div class="tab" onclick="switchTab(event,'history')">History</div>
    <div class="tab" onclick="switchTab(event,'models')">AI Models</div>
    <div class="tab" onclick="switchTab(event,'events')">Logs</div>
    <div class="tab" onclick="switchTab(event,'stats')">Stats</div>
    <div class="tab" onclick="switchTab(event,'raw')">Raw JSON</div>
  </div>

  <div id="tab-status" class="tab-content active">
    <div class="grid" id="status-grid">
      <div class="card"><div class="loading"><span class="spinner"></span> Loading status…</div></div>
    </div>
  </div>

  <div id="tab-tables" class="tab-content">
    <div class="card">
      <h2>🗄️ D1 Tables</h2>
      <div id="tables-content"><div class="loading"><span class="spinner"></span> Loading…</div></div>
    </div>
  </div>

  <div id="tab-history" class="tab-content">
    <div class="card">
      <h2>🕘 Last 10 Messages</h2>
      <div id="history-content"><p class="muted">Loading history…</p></div>
    </div>
  </div>

  <div id="tab-models" class="tab-content">
    <div class="card">
      <h2>🤖 AI Models</h2>
      <div id="models-content"><p class="muted">Loading models…</p></div>
    </div>
  </div>

  <div id="tab-events" class="tab-content">
    <div class="card">
      <h2>📜 Debug Events</h2>
      <div id="events-content"><p class="muted">Click "View Logs" to load.</p></div>
    </div>
  </div>

  <div id="tab-stats" class="tab-content">
    <div class="card">
      <h2>📈 Global Statistics</h2>
      <div id="stats-content"><p class="muted">Click "Stats" to load.</p></div>
    </div>
  </div>

  <div id="tab-raw" class="tab-content">
    <div class="card">
      <h2>📋 Full JSON Status <button onclick="copyJson()" class="secondary" style="float:right;padding:0.25rem 0.625rem;font-size:0.6875rem">📋 Copy</button></h2>
      <pre id="raw-content">Loading…</pre>
    </div>
  </div>

  <footer>
    AI Admin v${VERSION} • <a href="https://ilivir3.bot">ILIVIR3</a> • Powered by Cloudflare Workers
  </footer>
</div>

<script>
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const headers = TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {};

function showAlert(type, title, msg) {
  const c = document.getElementById('alert-container');
  const icons = { error: '🚨', success: '✅', warning: '⚠️' };
  c.innerHTML = '<div class="alert alert-' + type + '"><span class="alert-icon">' + icons[type] + '</span><div class="alert-content"><div class="alert-title">' + title + '</div>' + (msg || '') + '</div></div>';
  setTimeout(() => c.innerHTML = '', 10000);
}

function showCriticalBanner(title, text, steps) {
  const c = document.getElementById('critical-banner-container');
  let stepsHtml = '';
  if (steps && steps.length) {
    stepsHtml = '<ol class="critical-banner-steps">' + steps.map(s => '<li>' + s + '</li>').join('') + '</ol>';
  }
  c.innerHTML = '<div class="critical-banner"><span class="critical-banner-icon">🚨</span><div class="critical-banner-content"><div class="critical-banner-title">' + title + '</div><div class="critical-banner-text">' + text + stepsHtml + '</div></div></div>';
}

async function api(path, method) {
  method = method || 'GET';
  try {
    const r = await fetch(path, { method, headers });
    const data = await r.json();
    return data;
  } catch (e) {
    showAlert('error', 'Network Error', e.message);
    return { ok: false, error: e.message };
  }
}

async function loadStatus() {
  const data = await api('/Admi-bug/api/status');

  if (data.ok) {
    if (data.warning) {
      showAlert('warning', 'Security Note', data.warning);
    } else {
      showAlert('success', 'All Systems Operational', 'Everything looks good. The bot should be responding to messages.');
    }
  } else {
    const issues = [];
    if (data.webhook && data.webhook.lastErrorMessage) issues.push('Webhook: ' + data.webhook.lastErrorMessage);
    if (data.d1 && !data.d1.ok) issues.push('D1 error');
    if (data.tables && !data.tables.ok) issues.push(data.tables.missing.length + ' tables missing');
    showAlert('error', 'Issues Detected', issues.join('<br>'));
  }

  renderStatus(data);
  document.getElementById('raw-content').textContent = JSON.stringify(data, null, 2);
  loadTables();
  loadHistory();
  loadModels();
}

function renderStatus(data) {
  const grid = document.getElementById('status-grid');
  const cards = [];

  // Secrets
  const secrets = data.secrets || {};
  const secretItems = Object.entries(secrets).map(([k, v]) => {
    const critical = (k === 'WEBHOOK_SECRET' && !v);
    const cls = critical ? 'err' : (v ? 'ok' : 'warn');
    const icon = critical ? '✗' : (v ? '✓' : '!');
    return '<div class="status-item"><span class="status-label">' + k + '</span><span class="' + cls + '">' + icon + ' ' + (v ? 'set' : 'NOT SET') + '</span></div>';
  }).join('');
  cards.push('<div class="card"><h2>🔐 Secrets</h2>' + secretItems + '</div>');

  // Bindings
  const bindings = data.bindings || {};
  const bindingItems = Object.entries(bindings).map(([k, v]) =>
    '<div class="status-item"><span class="status-label">' + k + '</span><span class="' + (v ? 'ok' : 'err') + '">' + (v ? '✓ bound' : '✗ missing') + '</span></div>'
  ).join('');
  cards.push('<div class="card"><h2>🔗 Bindings</h2>' + bindingItems + '</div>');

  // Bot API
  const bot = data.botApi || {};
  let botHtml;
  if (bot.ok) {
    botHtml = '<div class="status-item"><span class="status-label">Bot</span><span class="ok">@' + bot.username + '</span></div>' +
              '<div class="status-item"><span class="status-label">Name</span><span>' + bot.firstName + '</span></div>' +
              '<div class="status-item"><span class="status-label">Can Join Groups</span><span class="' + (bot.canJoinGroups ? 'ok' : 'err') + '">' + (bot.canJoinGroups ? '✓' : '✗') + '</span></div>';
  } else {
    botHtml = '<div class="status-item"><span class="status-label">Bot API</span><span class="err">✗ Failed</span></div><div class="status-item"><span class="status-label">Error</span><span class="err" style="font-size:0.7rem">' + (bot.error || '') + '</span></div>';
  }
  cards.push('<div class="card"><h2>🤖 Bot API</h2>' + botHtml + '</div>');

  // Webhook
  const wh = data.webhook || {};
  let whHtml;
  if (wh.ok) {
    whHtml = '<div class="status-item"><span class="status-label">URL</span><span class="status-value" style="font-size:0.65rem;word-break:break-all;text-align:right">' + (wh.url || '(none)') + '</span></div>' +
             '<div class="status-item"><span class="status-label">Pending</span><span class="' + (wh.pendingUpdateCount > 0 ? 'warn' : 'ok') + '">' + wh.pendingUpdateCount + '</span></div>' +
             '<div class="status-item"><span class="status-label">Max Conn</span><span>' + wh.maxConnections + '</span></div>';
    if (wh.lastErrorMessage) {
      whHtml += '<div class="status-item"><span class="status-label">Last Error</span><span class="err" style="font-size:0.65rem;max-width:180px;word-break:break-word;text-align:right">' + wh.lastErrorMessage + '</span></div>';
    }
  } else {
    whHtml = '<div class="status-item"><span class="status-label">Webhook</span><span class="err">✗ Failed</span></div>';
  }
  cards.push('<div class="card"><h2>📡 Webhook</h2>' + whHtml + '</div>');

  // D1
  const d1 = data.d1 || {};
  const d1Html = d1.ok
    ? '<div class="status-item"><span class="status-label">Status</span><span class="ok">✓ Healthy</span></div><div class="status-item"><span class="status-label">Latency</span><span>' + d1.latencyMs + 'ms</span></div>'
    : '<div class="status-item"><span class="status-label">Status</span><span class="err">✗ Error</span></div><div class="status-item"><span class="status-label">Error</span><span class="err" style="font-size:0.65rem">' + (d1.error || '') + '</span></div>';
  cards.push('<div class="card"><h2>🗄️ D1 Database</h2>' + d1Html + '</div>');

  // KV
  const kv = data.kv || {};
  const kvHtml = kv.ok
    ? '<div class="status-item"><span class="status-label">Status</span><span class="ok">✓ Healthy</span></div><div class="status-item"><span class="status-label">Latency</span><span>' + kv.latencyMs + 'ms</span></div>'
    : '<div class="status-item"><span class="status-label">Status</span><span class="err">✗ Error</span></div>';
  cards.push('<div class="card"><h2>⚡ KV Namespace</h2>' + kvHtml + '</div>');

  // Config
  const cfg = data.config || {};
  cards.push('<div class="card"><h2>⚙️ Configuration</h2>' +
    '<div class="status-item"><span class="status-label">ADMIN_ID</span><span>' + (cfg.adminId || '(unset)') + '</span></div>' +
    '<div class="status-item"><span class="status-label">TARGET_CHANNEL</span><span>' + (cfg.targetChannel || '(unset)') + '</span></div>' +
    '<div class="status-item"><span class="status-label">FOOTER_TEXT</span><span style="font-size:0.75rem">' + (cfg.footerText || '') + '</span></div>' +
    '</div>');

  grid.innerHTML = cards.join('');
}

async function loadTables() {
  const data = await api('/Admi-bug/api/tables');
  const c = document.getElementById('tables-content');
  if (data.ok) {
    c.innerHTML = '<div class="alert alert-success" style="margin-bottom:0.75rem"><span class="alert-icon">✅</span><div class="alert-content"><div class="alert-title">All 8 tables exist</div></div></div>' +
      '<table><tr><th>Table</th><th>Status</th></tr>' +
      data.tables.map(t => '<tr><td><code>' + t.name + '</code></td><td><span class="pill pill-ok">EXISTS</span></td></tr>').join('') +
      '</table>';
  } else {
    c.innerHTML = '<div class="alert alert-error" style="margin-bottom:0.75rem"><span class="alert-icon">🚨</span><div class="alert-content"><div class="alert-title">' + data.missing.length + ' table(s) missing</div>Click "Init Schema" to create them.</div></div>' +
      '<table><tr><th>Table</th><th>Status</th></tr>' +
      data.tables.map(t => '<tr><td><code>' + t.name + '</code></td><td>' + (t.exists ? '<span class="pill pill-ok">EXISTS</span>' : '<span class="pill pill-err">MISSING</span>') + '</td></tr>').join('') +
      '</table>';
  }
}

async function initSchema() {
  if (!confirm('Create D1 tables? (Safe — uses CREATE TABLE IF NOT EXISTS)')) return;
  showAlert('warning', 'Working…', 'Creating tables…');
  const data = await api('/Admi-bug/api/init-schema', 'POST');
  if (data.ok) {
    showAlert('success', 'Schema Initialized', 'All tables created successfully!');
    loadTables();
  } else {
    showAlert('error', 'Schema Init Failed', data.error || 'Unknown error');
  }
}

async function testMessage() {
  showAlert('warning', 'Working…', 'Sending test message…');
  const data = await api('/Admi-bug/api/test-message', 'POST');
  if (data.ok) {
    showAlert('success', 'Test Sent', 'Check your Telegram — a test message was sent to your admin chat.');
  } else {
    showAlert('error', 'Test Failed', data.error || '');
  }
}

async function runSelfTest() {
  showAlert('warning', 'Working…', 'Running formatter tests…');
  const data = await api('/Admi-bug/api/self-test', 'POST');
  if (data.ok) {
    if (data.failed === 0) {
      showAlert('success', 'All Tests Passed', data.passed + ' tests passed, 0 failed.');
    } else {
      showAlert('error', 'Tests Failed', data.passed + ' passed, ' + data.failed + ' failed.');
    }
    document.getElementById('raw-content').textContent = JSON.stringify(data, null, 2);
    switchTab(null, 'raw');
  }
}

async function ensureOwner() {
  showAlert('warning', 'Working…', 'Ensuring owner…');
  const data = await api('/Admi-bug/api/ensure-owner', 'POST');
  if (data.ok) {
    showAlert('success', 'Owner Ensured', 'Owner ID ' + data.ownerId + ' added to admins table.');
  } else {
    showAlert('error', 'Failed', data.error || '');
  }
}

async function refreshHealth() {
  showAlert('warning', 'Working…', 'Refreshing model health (may take 10s)…');
  const data = await api('/Admi-bug/api/refresh-health', 'POST');
  if (data.ok) {
    showAlert('success', 'Models Refreshed', 'AI model health cache updated.');
  } else {
    showAlert('error', 'Failed', data.error || '');
  }
}

async function loadEvents() {
  switchTab(null, 'events');
  const data = await api('/Admi-bug/api/events?limit=20');
  const c = document.getElementById('events-content');
  if (data.ok && data.events && data.events.length > 0) {
    c.innerHTML = '<table><tr><th>Time</th><th>Type</th><th>Summary</th></tr>' +
      data.events.map(e => '<tr><td style="font-size:0.7rem;white-space:nowrap">' + new Date(e.created_at).toLocaleString('en-US') + '</td><td><code>' + e.kind + '</code></td><td style="font-size:0.75rem">' + (e.summary || '') + '</td></tr>').join('') +
      '</table>';
  } else {
    c.innerHTML = '<p class="muted">No events recorded.</p>';
  }
}

async function loadStats() {
  switchTab(null, 'stats');
  const data = await api('/Admi-bug/api/stats');
  const c = document.getElementById('stats-content');
  if (data.ok && data.stats) {
    const s = data.stats;
    c.innerHTML = '<table>' +
      '<tr><th>Metric</th><th>Value</th></tr>' +
      '<tr><td>Total Received</td><td>' + s.totalReceived + '</td></tr>' +
      '<tr><td>Total Published</td><td>' + s.totalPublished + '</td></tr>' +
      '<tr><td>Total Rewritten</td><td>' + s.totalRewritten + '</td></tr>' +
      '<tr><td>Total Failed</td><td>' + s.totalFailed + '</td></tr>' +
      '<tr><td>Total Approvals</td><td>' + s.totalApprovals + '</td></tr>' +
      '<tr><td>Total Rejected</td><td>' + s.totalRejected + '</td></tr>' +
      '<tr><td>Total Scheduled</td><td>' + s.totalScheduled + '</td></tr>' +
      '<tr><td>AI Calls</td><td>' + s.aiCalls + '</td></tr>' +
      '<tr><td>AI Failures</td><td>' + s.aiFailures + '</td></tr>' +
      '</table>';
  } else {
    c.innerHTML = '<p class="muted">Stats unavailable (stats table may not exist).</p>';
  }
}

function switchTab(evt, name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (evt && evt.target) evt.target.classList.add('active');
  else {
    const tabs = document.querySelectorAll('.tab');
    const tabTexts = { status: 'Status', tables: 'Tables', history: 'History', models: 'AI Models', events: 'Logs', stats: 'Stats', raw: 'Raw JSON' };
    tabs.forEach(t => { if (t.textContent.trim() === tabTexts[name]) t.classList.add('active'); });
  }
}

// Copy JSON status to clipboard
function copyJson() {
  const text = document.getElementById('raw-content').textContent;
  navigator.clipboard.writeText(text).then(() => {
    showAlert('success', 'Copied!', 'JSON status copied to clipboard.');
  }).catch(() => {
    showAlert('error', 'Copy Failed', 'Could not copy to clipboard.');
  });
}

// Load last 10 messages (history)
async function loadHistory() {
  const data = await api('/Admi-bug/api/history');
  const c = document.getElementById('history-content');
  if (data.ok && data.jobs && data.jobs.length > 0) {
    c.innerHTML = '<table><tr><th>Time</th><th>Type</th><th>Status</th><th>Job ID</th><th>Msg ID</th></tr>' +
      data.jobs.map(j => {
        const statusPill = j.status === 'published' ? 'pill-ok' : (j.status === 'failed' ? 'pill-err' : 'pill-warn');
        return '<tr>' +
          '<td style="font-size:0.7rem;white-space:nowrap">' + new Date(j.created_at).toLocaleString('en-US') + '</td>' +
          '<td><code>' + j.type + '</code></td>' +
          '<td><span class="pill ' + statusPill + '">' + j.status + '</span></td>' +
          '<td style="font-size:0.7rem"><code>' + (j.id || '').slice(0,12) + '</code></td>' +
          '<td>' + (j.published_message_id || j.message_id || '-') + '</td>' +
          '</tr>';
      }).join('') +
      '</table>';
  } else {
    c.innerHTML = '<p class="muted">No messages processed yet. Send a message to your bot to see history.</p>';
  }
}

// Load AI models (no live health — just Test button per model)
async function loadModels() {
  const data = await api('/Admi-bug/api/models');
  const c = document.getElementById('models-content');
  if (data.ok && data.models && data.models.length > 0) {
    c.innerHTML = '<table><tr><th>Model</th><th>Provider</th><th>Max Tokens</th><th>Test</th></tr>' +
      data.models.map((m, i) => {
        const providerColor = m.provider === 'gemini' ? 'var(--emerald)' : 'var(--sky)';
        return '<tr>' +
          '<td><code style="font-size:0.7rem">' + m.id + '</code><br><span style="font-size:0.75rem;color:var(--text-muted)">' + m.label + (m.notes ? ' (' + m.notes + ')' : '') + '</span></td>' +
          '<td><span style="color:' + providerColor + ';font-weight:600">' + m.provider + '</span></td>' +
          '<td>' + (m.maxTokens || '-') + '</td>' +
          '<td><button onclick="testModel(' + i + ')" class="secondary" style="padding:0.25rem 0.5rem;font-size:0.7rem" data-provider="' + m.provider + '" data-model="' + m.id + '">Test</button></td>' +
          '</tr>';
      }).join('') +
      '</table>' +
      '<div id="model-test-result" style="margin-top:1rem"></div>';
    // Store models globally for testModel
    window._models = data.models;
  } else {
    c.innerHTML = '<p class="muted">No models available.</p>';
  }
}

// Test a specific AI model
async function testModel(index) {
  const models = window._models || [];
  const m = models[index];
  if (!m) return;
  const result = document.getElementById('model-test-result');
  result.innerHTML = '<div class="loading"><span class="spinner"></span> Testing ' + m.label + '…</div>';
  try {
    const r = await fetch('/Admi-bug/api/test-model', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: m.provider, model: m.id }),
    });
    const data = await r.json();
    if (data.ok && data.text) {
      result.innerHTML = '<div class="alert alert-success"><span class="alert-icon">✅</span><div class="alert-content"><div class="alert-title">Success — ' + data.latencyMs + 'ms</div>Response: <code>' + data.text + '</code></div></div>';
    } else {
      result.innerHTML = '<div class="alert alert-error"><span class="alert-icon">❌</span><div class="alert-content"><div class="alert-title">Failed' + (data.latencyMs ? ' — ' + data.latencyMs + 'ms' : '') + '</div>' + (data.error || 'Unknown error') + '</div></div>';
    }
  } catch (e) {
    result.innerHTML = '<div class="alert alert-error"><span class="alert-icon">❌</span><div class="alert-content"><div class="alert-title">Error</div>' + e.message + '</div></div>';
  }
}

// Auto-load on page open
loadStatus();
</script>
</body>
</html>`;
}
