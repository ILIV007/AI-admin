/**
 * src/debug-panel.ts
 * Admin + Debug panel at /Admi-bug
 *
 * Features:
 *  - Status cards: bindings, secrets, D1, KV, Queue, Bot API, Webhook
 *  - Schema check + one-click auto-init
 *  - Send test message to admin
 *  - Run formatter self-tests
 *  - View recent debug events
 *  - View global stats
 *  - Refresh model health
 *
 * Auth: requires DEBUG_TOKEN (Bearer header) or ?token= query param.
 * If DEBUG_TOKEN is not set, the panel returns 404 (security: endpoint
 * effectively does not exist).
 */

import type { Env } from "./types";
import { checkTables, initSchema } from "./schema-init";
import { runFormatterSelfTests } from "./formatting/self-test";
import { getMe, getWebhookInfo, sendMessage } from "./telegram/client";
import { listEvents } from "./storage/repositories/debug-events";
import { getStats } from "./storage/repositories/stats";
import { ensureOwnerExists } from "./storage/repositories/admins";
import { refreshModelHealth } from "./ai/fallback";

const VERSION = "2.0.5";

// ============================================================
// AUTH
// ============================================================

export function checkPanelAuth(request: Request, env: Env): boolean {
  const token = env.DEBUG_TOKEN;
  if (!token) return false; // panel disabled if no token
  // Bearer header
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ") && auth.slice(7) === token) return true;
  // Query param ?token=...
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
  // If no DEBUG_TOKEN, return 404
  if (!env.DEBUG_TOKEN) {
    return new Response("Not Found", { status: 404 });
  }

  // Auth check
  if (!checkPanelAuth(request, env)) {
    return new Response(
      JSON.stringify({ ok: false, error: "Unauthorized. Use ?token=DEBUG_TOKEN or Authorization: Bearer DEBUG_TOKEN" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  // GET /Admi-bug → HTML panel
  if (request.method === "GET" && (url.pathname === "/Admi-bug" || url.pathname === "/Admi-bug/")) {
    return new Response(panelHTML(env), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // GET /Admi-bug/api/status → JSON diagnostic
  if (request.method === "GET" && url.pathname === "/Admi-bug/api/status") {
    return handleStatus(env);
  }

  // GET /Admi-bug/api/tables → check D1 tables
  if (request.method === "GET" && url.pathname === "/Admi-bug/api/tables") {
    const result = await checkTables(env);
    return json({ ok: result.ok, tables: result.tables, missing: result.missing });
  }

  // POST /Admi-bug/api/init-schema → create D1 tables
  if (request.method === "POST" && url.pathname === "/Admi-bug/api/init-schema") {
    const result = await initSchema(env);
    if (result.ok) {
      // Also ensure owner exists
      try {
        await ensureOwnerExists(env);
      } catch {
        /* ignore */
      }
    }
    return json({ ok: result.ok, error: result.error });
  }

  // POST /Admi-bug/api/test-message → send test to admin
  if (request.method === "POST" && url.pathname === "/Admi-bug/api/test-message") {
    try {
      const me = await getMe(env.BOT_TOKEN);
      const text = `🧪 پیام تست از پنل دیباگ\n\nبات: @${me.username}\nزمان: ${new Date().toISOString()}\nنسخه: ${VERSION}`;
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

  // POST /Admi-bug/api/self-test → run formatter tests
  if (request.method === "POST" && url.pathname === "/Admi-bug/api/self-test") {
    try {
      const result = runFormatterSelfTests();
      return json({ ok: true, ...result });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  // GET /Admi-bug/api/events → recent debug events
  if (request.method === "GET" && url.pathname === "/Admi-bug/api/events") {
    try {
      const limit = Math.min(Number(url.searchParams.get("limit") || 20), 100);
      const events = await listEvents(env, limit);
      return json({ ok: true, events });
    } catch (e) {
      return json({ ok: false, error: String(e), events: [] });
    }
  }

  // GET /Admi-bug/api/stats → global stats
  if (request.method === "GET" && url.pathname === "/Admi-bug/api/stats") {
    try {
      const stats = await getStats(env, "global");
      return json({ ok: true, stats });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  // POST /Admi-bug/api/refresh-health → refresh model health
  if (request.method === "POST" && url.pathname === "/Admi-bug/api/refresh-health") {
    try {
      await refreshModelHealth(env);
      return json({ ok: true, message: "Model health refreshed" });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  // POST /Admi-bug/api/ensure-owner → create owner row in admins table
  if (request.method === "POST" && url.pathname === "/Admi-bug/api/ensure-owner") {
    try {
      await ensureOwnerExists(env);
      return json({ ok: true, message: "Owner ensured", ownerId: Number(env.ADMIN_ID) });
    } catch (e) {
      return json({ ok: false, error: String(e) });
    }
  }

  return new Response("Not Found", { status: 404 });
}

// ============================================================
// STATUS ENDPOINT
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

  // Test Bot API
  try {
    const me = await getMe(env.BOT_TOKEN);
    status.botApi = {
      ok: true,
      username: me.username,
      firstName: me.first_name,
      canJoinGroups: me.can_join_groups,
    };
  } catch (e) {
    status.botApi = { ok: false, error: String(e) };
    status.ok = false;
  }

  // Test Webhook info
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

  // Test D1
  try {
    const t0 = Date.now();
    await env.DB.prepare("SELECT 1 as ok").first();
    status.d1 = { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    status.d1 = { ok: false, error: String(e) };
    status.ok = false;
  }

  // Test KV
  try {
    const t0 = Date.now();
    await env.AI_ADMIN_KV.put("panel:probe", "1", { expirationTtl: 60 });
    const v = await env.AI_ADMIN_KV.get("panel:probe");
    status.kv = { ok: v === "1", latencyMs: Date.now() - t0 };
  } catch (e) {
    status.kv = { ok: false, error: String(e) };
  }

  // Check D1 tables
  try {
    const tablesCheck = await checkTables(env);
    status.tables = tablesCheck;
    if (!tablesCheck.ok) status.ok = false;
  } catch (e) {
    status.tables = { ok: false, error: String(e) };
  }

  return json(status);
}

// ============================================================
// HELPERS
// ============================================================

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ============================================================
// HTML PANEL
// ============================================================

function panelHTML(_env: Env): string {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Admin — پنل دیباگ</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Tahoma, sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    min-height: 100vh;
    padding: 1rem;
  }
  .container { max-width: 1100px; margin: 0 auto; }
  header {
    background: linear-gradient(135deg, #059669, #0d9488);
    padding: 1.5rem;
    border-radius: 12px;
    margin-bottom: 1.5rem;
    box-shadow: 0 4px 20px rgba(5,150,105,0.3);
  }
  header h1 { font-size: 1.5rem; margin-bottom: 0.25rem; }
  header p { opacity: 0.9; font-size: 0.875rem; }
  .version {
    display: inline-block;
    background: rgba(255,255,255,0.2);
    padding: 0.125rem 0.5rem;
    border-radius: 6px;
    font-size: 0.75rem;
    font-family: monospace;
    margin-top: 0.5rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }
  .card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 10px;
    padding: 1rem;
  }
  .card h2 {
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #94a3b8;
    margin-bottom: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .status-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.4rem 0;
    border-bottom: 1px solid #334155;
    font-size: 0.875rem;
  }
  .status-item:last-child { border-bottom: none; }
  .status-label { color: #cbd5e1; font-family: monospace; }
  .status-value { font-weight: 600; }
  .ok { color: #34d399; }
  .err { color: #f87171; }
  .warn { color: #fbbf24; }
  .muted { color: #64748b; }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }
  button {
    background: #059669;
    color: white;
    border: none;
    padding: 0.6rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 600;
    transition: all 0.2s;
  }
  button:hover { background: #047857; transform: translateY(-1px); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.danger { background: #dc2626; }
  button.danger:hover { background: #b91c1c; }
  button.secondary { background: #475569; }
  button.secondary:hover { background: #334155; }
  pre {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    padding: 1rem;
    overflow-x: auto;
    font-size: 0.75rem;
    line-height: 1.5;
    max-height: 400px;
    overflow-y: auto;
  }
  .section-title {
    font-size: 1.125rem;
    font-weight: 700;
    margin: 1.5rem 0 0.75rem;
    color: #f1f5f9;
  }
  .alert {
    padding: 0.75rem 1rem;
    border-radius: 8px;
    margin-bottom: 1rem;
    font-size: 0.875rem;
  }
  .alert-error {
    background: rgba(220,38,38,0.15);
    border: 1px solid rgba(220,38,38,0.4);
    color: #fca5a5;
  }
  .alert-success {
    background: rgba(5,150,105,0.15);
    border: 1px solid rgba(5,150,105,0.4);
    color: #6ee7b7;
  }
  .alert-warning {
    background: rgba(251,191,36,0.15);
    border: 1px solid rgba(251,191,36,0.4);
    color: #fcd34d;
  }
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: white;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .tabs {
    display: flex;
    gap: 0.25rem;
    margin-bottom: 1rem;
    border-bottom: 1px solid #334155;
  }
  .tab {
    padding: 0.5rem 1rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: #94a3b8;
    font-size: 0.875rem;
    font-weight: 600;
  }
  .tab.active {
    color: #34d399;
    border-bottom-color: #34d399;
  }
  .tab-content { display: none; }
  .tab-content.active { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th, td { padding: 0.4rem; text-align: right; border-bottom: 1px solid #334155; }
  th { color: #94a3b8; font-weight: 600; }
  .pill {
    display: inline-block;
    padding: 0.125rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
  }
  .pill-ok { background: rgba(52,211,153,0.2); color: #34d399; }
  .pill-err { background: rgba(248,113,113,0.2); color: #f87171; }
  footer {
    text-align: center;
    padding: 2rem;
    color: #64748b;
    font-size: 0.75rem;
  }
</style>
</head>
<body>
<div class="container">
  <header>
    <h1>🤖 AI Admin — پنل دیباگ</h1>
    <p>مدیریت، دیباگ و مانیتورینگ بات تلگرام</p>
    <span class="version">v${VERSION}</span>
  </header>

  <div id="alert-container"></div>

  <div class="actions">
    <button onclick="loadStatus()" id="btn-status">📊 بارگذاری وضعیت</button>
    <button onclick="initSchema()" class="danger">🗄️ ساخت جدول‌ها</button>
    <button onclick="testMessage()">🧪 پیام تست</button>
    <button onclick="runSelfTest()">🧪 تست فرمت‌ها</button>
    <button onclick="ensureOwner()" class="secondary">👑 ثبت مالک</button>
    <button onclick="refreshHealth()" class="secondary">🔄 بررسی مدل‌ها</button>
    <button onclick="loadEvents()" class="secondary">📜 لاگ‌ها</button>
    <button onclick="loadStats()" class="secondary">📈 آمار</button>
  </div>

  <div class="tabs">
    <div class="tab active" onclick="switchTab('status')">وضعیت</div>
    <div class="tab" onclick="switchTab('tables')">جدول‌ها</div>
    <div class="tab" onclick="switchTab('events')">لاگ‌ها</div>
    <div class="tab" onclick="switchTab('stats')">آمار</div>
    <div class="tab" onclick="switchTab('raw')">JSON کامل</div>
  </div>

  <div id="tab-status" class="tab-content active">
    <div class="grid" id="status-grid">
      <div class="card"><p class="muted">روی «بارگذاری وضعیت» کلیک کنید.</p></div>
    </div>
  </div>

  <div id="tab-tables" class="tab-content">
    <div class="card">
      <h2>🗄️ جدول‌های D1</h2>
      <div id="tables-content"><p class="muted">بارگذاری...</p></div>
    </div>
  </div>

  <div id="tab-events" class="tab-content">
    <div class="card">
      <h2>📜 رویدادهای دیباگ</h2>
      <div id="events-content"><p class="muted">روی «لاگ‌ها» کلیک کنید.</p></div>
    </div>
  </div>

  <div id="tab-stats" class="tab-content">
    <div class="card">
      <h2>📈 آمار جهانی</h2>
      <div id="stats-content"><p class="muted">روی «آمار» کلیک کنید.</p></div>
    </div>
  </div>

  <div id="tab-raw" class="tab-content">
    <div class="card">
      <h2>📋 JSON کامل</h2>
      <pre id="raw-content">بارگذاری...</pre>
    </div>
  </div>

  <footer>
    AI Admin V${VERSION} • <a href="https://ilivir3.bot" style="color:#475569;">ILIVIR3</a>
  </footer>
</div>

<script>
const TOKEN = new URLSearchParams(location.search).get('token') || '';
const headers = TOKEN ? { 'Authorization': 'Bearer ' + TOKEN } : {};

function showAlert(type, msg) {
  const c = document.getElementById('alert-container');
  c.innerHTML = '<div class="alert alert-' + type + '">' + msg + '</div>';
  setTimeout(() => c.innerHTML = '', 8000);
}

function btnLoading(id, text) {
  const btn = document.getElementById(id) || document.querySelector('button:has(---)');
  // simpler: find active button
}

async function api(path, method = 'GET') {
  try {
    const r = await fetch(path, { method, headers });
    const data = await r.json();
    if (!r.ok || !data.ok) {
      showAlert('error', 'خطا: ' + (data.error || r.statusText));
    }
    return data;
  } catch (e) {
    showAlert('error', 'خطای شبکه: ' + e.message);
    return { ok: false, error: e.message };
  }
}

async function loadStatus() {
  const data = await api('/Admi-bug/api/status');
  if (!data.ok) {
    showAlert('error', 'سیستم مشکل دارد. جزئیات در تب JSON.');
  } else {
    showAlert('success', '✓ سیستم سالم است.');
  }
  renderStatus(data);
  document.getElementById('raw-content').textContent = JSON.stringify(data, null, 2);

  // Also load tables
  loadTables();
}

function renderStatus(data) {
  const grid = document.getElementById('status-grid');
  const cards = [];

  // Secrets card
  const secrets = data.secrets || {};
  const secretItems = Object.entries(secrets).map(([k, v]) =>
    '<div class="status-item"><span class="status-label">' + k + '</span><span class="' + (v ? 'ok' : 'err') + '">' + (v ? '✓' : '✗') + '</span></div>'
  ).join('');
  cards.push('<div class="card"><h2>🔐 Secretها</h2>' + secretItems + '</div>');

  // Bindings card
  const bindings = data.bindings || {};
  const bindingItems = Object.entries(bindings).map(([k, v]) =>
    '<div class="status-item"><span class="status-label">' + k + '</span><span class="' + (v ? 'ok' : 'err') + '">' + (v ? '✓ بسته‌شده' : '✗ نبسته') + '</span></div>'
  ).join('');
  cards.push('<div class="card"><h2>🔗 Bindings</h2>' + bindingItems + '</div>');

  // Bot API card
  const bot = data.botApi || {};
  let botHtml = '';
  if (bot.ok) {
    botHtml = '<div class="status-item"><span>بات</span><span class="ok">@' + bot.username + '</span></div>' +
              '<div class="status-item"><span>نام</span><span>' + bot.firstName + '</span></div>';
  } else {
    botHtml = '<div class="status-item"><span>Bot API</span><span class="err">✗ ' + (bot.error || 'failed') + '</span></div>';
  }
  cards.push('<div class="card"><h2>🤖 Bot API</h2>' + botHtml + '</div>');

  // Webhook card
  const wh = data.webhook || {};
  let whHtml = '';
  if (wh.ok) {
    whHtml = '<div class="status-item"><span>URL</span><span class="status-value" style="font-size:0.7rem;word-break:break-all">' + (wh.url || '(none)') + '</span></div>' +
             '<div class="status-item"><span>pending</span><span class="' + (wh.pendingUpdateCount > 0 ? 'warn' : 'ok') + '">' + wh.pendingUpdateCount + '</span></div>';
    if (wh.lastErrorMessage) {
      whHtml += '<div class="status-item"><span>خطای آخر</span><span class="err" style="font-size:0.7rem">' + wh.lastErrorMessage + '</span></div>';
    }
  } else {
    whHtml = '<div class="status-item"><span>Webhook</span><span class="err">✗</span></div>';
  }
  cards.push('<div class="card"><h2>📡 Webhook</h2>' + whHtml + '</div>');

  // D1 card
  const d1 = data.d1 || {};
  const d1Html = d1.ok
    ? '<div class="status-item"><span>وضعیت</span><span class="ok">✓ سالم</span></div><div class="status-item"><span>latency</span><span>' + d1.latencyMs + 'ms</span></div>'
    : '<div class="status-item"><span>وضعیت</span><span class="err">✗ خطا</span></div><div class="status-item"><span>خطا</span><span class="err" style="font-size:0.7rem">' + (d1.error || '') + '</span></div>';
  cards.push('<div class="card"><h2>🗄️ D1 Database</h2>' + d1Html + '</div>');

  // KV card
  const kv = data.kv || {};
  const kvHtml = kv.ok
    ? '<div class="status-item"><span>وضعیت</span><span class="ok">✓ سالم</span></div><div class="status-item"><span>latency</span><span>' + kv.latencyMs + 'ms</span></div>'
    : '<div class="status-item"><span>وضعیت</span><span class="err">✗ خطا</span></div>';
  cards.push('<div class="card"><h2>⚡ KV</h2>' + kvHtml + '</div>');

  // Config card
  const cfg = data.config || {};
  cards.push('<div class="card"><h2>⚙️ تنظیمات</h2>' +
    '<div class="status-item"><span>ADMIN_ID</span><span>' + (cfg.adminId || '(unset)') + '</span></div>' +
    '<div class="status-item"><span>TARGET_CHANNEL</span><span>' + (cfg.targetChannel || '(unset)') + '</span></div>' +
    '<div class="status-item"><span>FOOTER_TEXT</span><span style="font-size:0.75rem">' + (cfg.footerText || '') + '</span></div>' +
    '</div>');

  grid.innerHTML = cards.join('');
}

async function loadTables() {
  const data = await api('/Admi-bug/api/tables');
  const c = document.getElementById('tables-content');
  if (data.ok) {
    c.innerHTML = '<div class="alert alert-success">✓ همه ۸ جدول وجود دارند.</div>' +
      '<table><tr><th>جدول</th><th>وضعیت</th></tr>' +
      data.tables.map(t => '<tr><td><code>' + t.name + '</code></td><td><span class="pill pill-ok">✓ وجود دارد</span></td></tr>').join('') +
      '</table>';
  } else {
    c.innerHTML = '<div class="alert alert-error">✗ ' + data.missing.length + ' جدول گم شده. روی «ساخت جدول‌ها» کلیک کنید.</div>' +
      '<table><tr><th>جدول</th><th>وضعیت</th></tr>' +
      data.tables.map(t => '<tr><td><code>' + t.name + '</code></td><td>' + (t.exists ? '<span class="pill pill-ok">✓</span>' : '<span class="pill pill-err">✗ گم شده</span>') + '</td></tr>').join('') +
      '</table>';
  }
}

async function initSchema() {
  if (!confirm('جدول‌های D1 ساخته شوند؟ (ایمن — فقط CREATE TABLE IF NOT EXISTS)')) return;
  showAlert('warning', 'در حال ساخت جدول‌ها...');
  const data = await api('/Admi-bug/api/init-schema', 'POST');
  if (data.ok) {
    showAlert('success', '✓ جدول‌ها ساخته شدند!');
    loadTables();
  } else {
    showAlert('error', '✗ خطا: ' + (data.error || ''));
  }
}

async function testMessage() {
  showAlert('warning', 'در حال ارسال پیام تست...');
  const data = await api('/Admi-bug/api/test-message', 'POST');
  if (data.ok) {
    showAlert('success', '✓ پیام تست به ادمین ارسال شد. تلگرام را چک کنید.');
  }
}

async function runSelfTest() {
  showAlert('warning', 'در حال اجرای تست‌ها...');
  const data = await api('/Admi-bug/api/self-test', 'POST');
  if (data.ok) {
    if (data.failed === 0) {
      showAlert('success', '✓ همه ' + data.passed + ' تست پاس شدند.');
    } else {
      showAlert('error', data.passed + ' passed, ' + data.failed + ' failed.');
    }
    document.getElementById('raw-content').textContent = JSON.stringify(data, null, 2);
    switchTab('raw');
  }
}

async function ensureOwner() {
  showAlert('warning', 'در حال ثبت مالک...');
  const data = await api('/Admi-bug/api/ensure-owner', 'POST');
  if (data.ok) {
    showAlert('success', '✓ مالک با ID ' + data.ownerId + ' ثبت شد.');
  }
}

async function refreshHealth() {
  showAlert('warning', 'در حال بررسی مدل‌های AI (۱۰ ثانیه)...');
  const data = await api('/Admi-bug/api/refresh-health', 'POST');
  if (data.ok) {
    showAlert('success', '✓ سلامت مدل‌ها به‌روزرسانی شد.');
  }
}

async function loadEvents() {
  switchTab('events');
  const data = await api('/Admi-bug/api/events?limit=20');
  const c = document.getElementById('events-content');
  if (data.ok && data.events && data.events.length > 0) {
    c.innerHTML = '<table><tr><th>زمان</th><th>نوع</th><th>خلاصه</th></tr>' +
      data.events.map(e => '<tr><td style="font-size:0.7rem">' + new Date(e.created_at).toLocaleString('fa-IR') + '</td><td><code>' + e.kind + '</code></td><td>' + (e.summary || '') + '</td></tr>').join('') +
      '</table>';
  } else {
    c.innerHTML = '<p class="muted">هیچ رویدادی ثبت نشده.</p>';
  }
}

async function loadStats() {
  switchTab('stats');
  const data = await api('/Admi-bug/api/stats');
  const c = document.getElementById('stats-content');
  if (data.ok && data.stats) {
    const s = data.stats;
    c.innerHTML = '<table>' +
      '<tr><td>دریافتی</td><td>' + s.totalReceived + '</td></tr>' +
      '<tr><td>منتشرشده</td><td>' + s.totalPublished + '</td></tr>' +
      '<tr><td>بازنویسی‌شده</td><td>' + s.totalRewritten + '</td></tr>' +
      '<tr><td>ناموفق</td><td>' + s.totalFailed + '</td></tr>' +
      '<tr><td>تایید</td><td>' + s.totalApprovals + '</td></tr>' +
      '<tr><td>ردشده</td><td>' + s.totalRejected + '</td></tr>' +
      '<tr><td>زمان‌بندی‌شده</td><td>' + s.totalScheduled + '</td></tr>' +
      '<tr><td>AI calls</td><td>' + s.aiCalls + '</td></tr>' +
      '<tr><td>AI failures</td><td>' + s.aiFailures + '</td></tr>' +
      '</table>';
  } else {
    c.innerHTML = '<p class="muted">آمار در دسترس نیست (جدول stats وجود ندارد؟).</p>';
  }
}

function switchTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');
}

// Auto-load status on page open
loadStatus();
</script>
</body>
</html>`;
}
