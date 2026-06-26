/**
 * src/debug.js
 * Debug dashboard + logging utilities for AI Admin.
 */

const DEBUG_MAX_ENTRIES = 30;
const KEY_DEBUG_UPDATES = "debug:updates";
const KEY_DEBUG_ERRORS = "debug:errors";
const KEY_DEBUG_RAW = "debug:raw_requests";

// ============================================================
// LOGGING
// ============================================================
export async function logUpdate(SETTINGS, update, status, detail = "") {
  if (!SETTINGS) return;
  try {
    const entry = {
      time: new Date().toISOString(),
      type: update.callback_query ? "callback_query" : update.message ? "message" : update.channel_post ? "channel_post" : "other",
      fromId: update.callback_query?.from?.id || update.message?.from?.id || update.channel_post?.from?.id || null,
      chatId: update.callback_query?.message?.chat?.id || update.message?.chat?.id || update.channel_post?.chat?.id || null,
      chatType: update.callback_query?.message?.chat?.type || update.message?.chat?.type || update.channel_post?.chat?.type || null,
      textPreview: (update.callback_query?.data || update.message?.text || update.channel_post?.text || update.message?.caption || update.channel_post?.caption || "").slice(0, 120),
      status, detail,
    };
    const raw = await SETTINGS.get(KEY_DEBUG_UPDATES);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    await SETTINGS.put(KEY_DEBUG_UPDATES, JSON.stringify(list.slice(0, DEBUG_MAX_ENTRIES)));
  } catch (e) {
    console.error("[debug] logUpdate failed:", e.message);
  }
}

export async function logError(SETTINGS, error, context = "") {
  if (!SETTINGS) return;
  try {
    const entry = {
      time: new Date().toISOString(),
      error: error.message || String(error),
      stack: error.stack?.split("\n").slice(0, 6).join("\n"),
      context,
    };
    const raw = await SETTINGS.get(KEY_DEBUG_ERRORS);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    await SETTINGS.put(KEY_DEBUG_ERRORS, JSON.stringify(list.slice(0, DEBUG_MAX_ENTRIES)));
  } catch (e) {
    console.error("[debug] logError failed:", e.message);
  }
}

export async function logRawRequest(SETTINGS, info) {
  if (!SETTINGS) return;
  try {
    const entry = {
      time: new Date().toISOString(),
      method: info.method, path: info.path,
      hasSecret: info.hasSecret, secretMatch: info.secretMatch,
      bodySize: info.bodySize, updateType: info.updateType,
      fromId: info.fromId, chatId: info.chatId,
      textPreview: (info.textPreview || "").slice(0, 80),
      status: info.status, detail: info.detail,
    };
    const raw = await SETTINGS.get(KEY_DEBUG_RAW);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(entry);
    await SETTINGS.put(KEY_DEBUG_RAW, JSON.stringify(list.slice(0, DEBUG_MAX_ENTRIES)));
  } catch (e) {
    console.error("[debug] logRawRequest failed:", e.message);
  }
}

export async function getRecentUpdates(SETTINGS) {
  if (!SETTINGS) return [];
  try {
    const raw = await SETTINGS.get(KEY_DEBUG_UPDATES);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function getRecentErrors(SETTINGS) {
  if (!SETTINGS) return [];
  try {
    const raw = await SETTINGS.get(KEY_DEBUG_ERRORS);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function getRecentRawRequests(SETTINGS) {
  if (!SETTINGS) return [];
  try {
    const raw = await SETTINGS.get(KEY_DEBUG_RAW);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

export async function clearDebugLogs(SETTINGS) {
  if (!SETTINGS) return;
  await SETTINGS.put(KEY_DEBUG_UPDATES, JSON.stringify([]));
  await SETTINGS.put(KEY_DEBUG_ERRORS, JSON.stringify([]));
  await SETTINGS.put(KEY_DEBUG_RAW, JSON.stringify([]));
}

// ============================================================
// AUTH
// ============================================================
export function checkDebugAuth(request, env) {
  if (!env.DEBUG_TOKEN) return { ok: true };
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || url.searchParams.get("t");
  return { ok: token === env.DEBUG_TOKEN, required: true };
}

// ============================================================
// STATUS GATHERER (parallel)
// ============================================================
function maskValue(val) {
  if (val === undefined || val === null || val === "") return { set: false };
  const s = String(val);
  if (s.length <= 8) return { set: true, length: s.length, preview: "***" };
  return { set: true, length: s.length, preview: s.slice(0, 3) + "…" + s.slice(-3) };
}

export async function getStatus(env, SETTINGS) {
  const envVars = {
    ADMIN_ID: env.ADMIN_ID ? { set: true, value: String(env.ADMIN_ID) } : { set: false },
    TARGET_CHANNEL: env.TARGET_CHANNEL ? { set: true, value: env.TARGET_CHANNEL } : { set: false },
    FOOTER_TEXT: env.FOOTER_TEXT ? { set: true, value: env.FOOTER_TEXT } : { set: false },
    DEFAULT_AI_PROVIDER: env.DEFAULT_AI_PROVIDER ? { set: true, value: env.DEFAULT_AI_PROVIDER } : { set: false },
    GEMINI_MODEL: env.GEMINI_MODEL ? { set: true, value: env.GEMINI_MODEL } : { set: false },
    OPENROUTER_MODEL: env.OPENROUTER_MODEL ? { set: true, value: env.OPENROUTER_MODEL } : { set: false },
  };

  const secrets = {
    BOT_TOKEN: maskValue(env.BOT_TOKEN),
    GEMINI_API_KEY: maskValue(env.GEMINI_API_KEY),
    OPENROUTER_API_KEY: maskValue(env.OPENROUTER_API_KEY),
    WEBHOOK_SECRET: maskValue(env.WEBHOOK_SECRET),
    DEBUG_TOKEN: maskValue(env.DEBUG_TOKEN),
  };

  const fetchWithTimeout = (url, ms = 8000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
  };

  const [kvStatus, botInfo, webhookInfo, recentUpdates, recentErrors, recentRawRequests] = await Promise.all([
    (async () => {
      const s = { bound: !!SETTINGS, readable: false, writable: false, error: null };
      if (!SETTINGS) return s;
      try { await SETTINGS.get("__debug_kv_test__"); s.readable = true; } catch (e) { s.error = `read: ${e.message}`; }
      try { await SETTINGS.put("__debug_kv_test__", String(Date.now())); s.writable = true; } catch (e) { s.error = (s.error ? s.error + " | " : "") + `write: ${e.message}`; }
      return s;
    })(),
    (async () => {
      if (!env.BOT_TOKEN) return { ok: false, error: "BOT_TOKEN not set" };
      try { const r = await fetchWithTimeout(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`); return await r.json(); }
      catch (e) { return { ok: false, error: e.message }; }
    })(),
    (async () => {
      if (!env.BOT_TOKEN) return { ok: false, error: "BOT_TOKEN not set" };
      try { const r = await fetchWithTimeout(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`); return await r.json(); }
      catch (e) { return { ok: false, error: e.message }; }
    })(),
    getRecentUpdates(SETTINGS),
    getRecentErrors(SETTINGS),
    getRecentRawRequests(SETTINGS),
  ]);

  const issues = [];
  if (!env.ADMIN_ID) issues.push({ severity: "critical", msg: "ADMIN_ID is not set." });
  if (!env.TARGET_CHANNEL) issues.push({ severity: "warning", msg: "TARGET_CHANNEL is not set." });
  if (!SETTINGS) issues.push({ severity: "critical", msg: "KV 'SETTINGS' not bound." });
  else if (!kvStatus.readable || !kvStatus.writable) issues.push({ severity: "critical", msg: `KV failed: ${kvStatus.error}` });
  if (webhookInfo?.ok && webhookInfo.result.last_error_message) {
    issues.push({ severity: "warning", msg: `Webhook error: ${webhookInfo.result.last_error_message}` });
  }
  if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) issues.push({ severity: "warning", msg: "No AI keys set." });

  return {
    time: new Date().toISOString(), envVars, secrets, kv: kvStatus,
    botInfo, webhookInfo, recentUpdates, recentErrors, recentRawRequests, issues,
  };
}

// ============================================================
// TEST ACTIONS
// ============================================================
export async function sendTestMessage(env) {
  if (!env.ADMIN_ID) return { ok: false, error: "ADMIN_ID not set" };
  if (!env.BOT_TOKEN) return { ok: false, error: "BOT_TOKEN not set" };
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.ADMIN_ID,
      text: "🧪 <b>Debug Test</b>\n\nIf you got this, BOT_TOKEN + ADMIN_ID are correct.",
      parse_mode: "HTML",
    }),
  });
  return res.json();
}

export async function testKV(SETTINGS) {
  if (!SETTINGS) return { ok: false, error: "KV not bound" };
  const k = `__kv_test_${Date.now()}__`;
  const v = `hello-${Date.now()}`;
  try {
    await SETTINGS.put(k, v);
    const r = await SETTINGS.get(k);
    await SETTINGS.delete(k);
    return r === v ? { ok: true, msg: "KV read/write/delete OK" } : { ok: false, error: "Value mismatch" };
  } catch (e) { return { ok: false, error: e.message }; }
}

export async function testAI(env) {
  const userMsg = "Reply with exactly: AI_OK";
  const systemMsg = "You are a test endpoint. Reply with exactly: AI_OK";

  // Build list of all models to test
  const tests = [];

  // 1. Gemini
  if (env.GEMINI_API_KEY) {
    const geminiModel = env.GEMINI_MODEL || "gemini-2.0-flash";
    tests.push({
      name: "gemini/" + geminiModel,
      run: async () => {
        const start = Date.now();
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 25000);
          const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${env.GEMINI_API_KEY}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: systemMsg }] },
              contents: [{ role: "user", parts: [{ text: userMsg }] }],
              generationConfig: { temperature: 0, maxOutputTokens: 50 },
            }), signal: ctrl.signal,
          }).catch((e) => { if (e.name === "AbortError") throw new Error("TIMEOUT 25s"); throw e; }).finally(() => clearTimeout(t));
          const data = await res.json();
          const ms = Date.now() - start;
          if (!res.ok) return { ok: false, error: `${res.status}: ${JSON.stringify(data.error || data).slice(0, 150)}`, ms };
          const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
          return { ok: true, response: text.trim().slice(0, 100), ms };
        } catch (e) { return { ok: false, error: e.message, ms: Date.now() - start }; }
      },
    });
  }

  // 2. ALL OpenRouter models
  if (env.OPENROUTER_API_KEY) {
    let models = [];
    if (env.OPENROUTER_FALLBACK_MODELS) {
      models = env.OPENROUTER_FALLBACK_MODELS.split(",").map((m) => m.trim()).filter(Boolean);
    } else {
      models = [env.OPENROUTER_MODEL || "google/gemini-2.0-flash-exp:free"];
    }

    for (const model of models) {
      tests.push({
        name: "openrouter/" + model,
        run: async () => {
          const start = Date.now();
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 25000);
            const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "HTTP-Referer": "https://ai-admin.workers.dev", "X-Title": "AI Admin" },
              body: JSON.stringify({ model, messages: [{ role: "system", content: systemMsg }, { role: "user", content: userMsg }], temperature: 0, max_tokens: 50 }),
              signal: ctrl.signal,
            }).catch((e) => { if (e.name === "AbortError") throw new Error("TIMEOUT 25s"); throw e; }).finally(() => clearTimeout(t));
            const data = await res.json();
            const ms = Date.now() - start;
            if (!res.ok) return { ok: false, error: `${res.status}: ${JSON.stringify(data.error || data).slice(0, 150)}`, ms };
            const text = data?.choices?.[0]?.message?.content ?? "";
            return { ok: true, response: text.trim().slice(0, 100), ms };
          } catch (e) { return { ok: false, error: e.message, ms: Date.now() - start }; }
        },
      });
    }
  }

  if (tests.length === 0) {
    return { ok: false, error: "No AI keys configured (need GEMINI_API_KEY or OPENROUTER_API_KEY)" };
  }

  // Run ALL tests in parallel
  console.log(`[debug] testing ${tests.length} AI models in parallel`);
  const results = await Promise.all(
    tests.map(async (t) => {
      const result = await t.run();
      return { name: t.name, ...result };
    })
  );

  // Summarize
  const working = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const fastest = working.length > 0 ? working.reduce((a, b) => (a.ms < b.ms ? a : b)) : null;

  return {
    ok: working.length > 0,
    total: results.length,
    working: working.length,
    failed: failed.length,
    results: results,
    fastest: fastest ? fastest.name : null,
    recommendation: working.length === 0
      ? "ALL models failed. Check API keys and quotas."
      : `${working.length}/${results.length} models work. Fastest: ${fastest.name} (${fastest.ms}ms)`,
  };
}

// ============================================================
// HTML DASHBOARD
// ============================================================
export function debugHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Admin — Debug</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; line-height: 1.6; }
.container { max-width: 1100px; margin: 0 auto; }
h1 { color: #58a6ff; margin-bottom: 8px; }
.subtitle { color: #8b949e; margin-bottom: 24px; }
.header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
.refresh-btn { background: #238636; color: white; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; }
.section { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.section h2 { color: #58a6ff; font-size: 1.1em; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
.card { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px; }
.card-label { color: #8b949e; font-size: 0.8em; text-transform: uppercase; margin-bottom: 4px; }
.card-value { font-family: monospace; font-size: 0.9em; word-break: break-all; }
.status-ok { color: #3fb950; } .status-fail { color: #f85149; } .status-warn { color: #d29922; }
.issues li { padding: 8px 12px; margin-bottom: 6px; border-radius: 4px; list-style: none; }
.issue-critical { background: rgba(248,81,73,0.15); border-left: 3px solid #f85149; }
.issue-warning { background: rgba(210,153,34,0.15); border-left: 3px solid #d29922; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; }
.btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 14px; border-radius: 6px; cursor: pointer; font-size: 0.85em; }
.btn:hover { background: #30363d; }
.btn-primary { background: #1f6feb; border-color: #1f6feb; color: white; }
.btn-danger { background: #da3633; border-color: #da3633; color: white; }
.result { margin-top: 10px; padding: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; font-family: monospace; font-size: 0.85em; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; display: none; }
.result.show { display: block; }
table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #30363d; vertical-align: top; }
th { color: #8b949e; text-transform: uppercase; font-size: 0.8em; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75em; }
.badge-ok { background: rgba(63,185,80,0.2); color: #3fb950; }
.badge-error { background: rgba(248,81,73,0.2); color: #f85149; }
.badge-ignored { background: rgba(139,148,158,0.2); color: #8b949e; }
.empty { color: #8b949e; font-style: italic; text-align: center; padding: 20px; }
.timestamp { color: #8b949e; font-size: 0.8em; font-family: monospace; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div><h1>🔧 AI Admin — Debug</h1><div class="subtitle">v0.2.1</div></div>
    <button class="refresh-btn" onclick="loadStatus()">↻ Refresh</button>
  </div>
  <div id="issues" class="section" style="display:none;"><h2>⚠️ Issues</h2><ul class="issues" id="issues-list"></ul></div>
  <div class="section"><h2>📊 Status</h2><div class="grid" id="status-grid"><div class="card"><div class="card-label">Loading...</div></div></div></div>
  <div class="section"><h2>🧪 Actions</h2><div class="actions">
    <button class="btn btn-primary" onclick="runTest('message')">📤 Test Message</button>
    <button class="btn" onclick="runTest('kv')">💾 Test KV</button>
    <button class="btn" onclick="runTest('ai')">🤖 Test AI</button>
    <button class="btn btn-danger" onclick="clearLogs()">🗑️ Clear Logs</button>
  </div><div id="action-result" class="result"></div></div>
  <div class="section"><h2>📡 Raw Requests</h2><div id="raw-table"><div class="empty">Loading...</div></div></div>
  <div class="section"><h2>📜 Recent Updates</h2><div id="updates-table"><div class="empty">Loading...</div></div></div>
  <div class="section"><h2>❌ Recent Errors</h2><div id="errors-table"><div class="empty">Loading...</div></div></div>
  <div class="section"><h2>🔧 Bot Info</h2><div id="bot-info"><div class="empty">Loading...</div></div></div>
  <div class="section"><h2>🔗 Webhook</h2><div id="webhook-info"><div class="empty">Loading...</div></div></div>
</div>
<script>
const urlParams = new URLSearchParams(window.location.search);
const TOKEN = urlParams.get("token") || urlParams.get("t");
const QS = TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "";
const BASE = "";
let lastStatus = null;
async function loadStatus() {
  try {
    const res = await fetch(BASE + "/debug/api/status" + QS);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    lastStatus = data;
    renderStatus(data);
  } catch (e) {
    document.getElementById("status-grid").innerHTML = '<div class="card"><div class="card-label">Error</div><div class="card-value status-fail">' + e.message + '</div></div>';
  }
}
function esc(s) { if (s === null || s === undefined) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function fmtTime(ts) { if (!ts) return ""; try { return new Date(ts).toLocaleString(); } catch { return ts; } }
function badge(s) { const cls = s === "ok" ? "badge-ok" : (s === "error" || s.startsWith("rejected") ? "badge-error" : "badge-ignored"); return '<span class="badge ' + cls + '">' + esc(s) + '</span>'; }
function card(label, value) { return '<div class="card"><div class="card-label">' + label + '</div><div class="card-value">' + value + '</div></div>'; }
function renderStatus(data) {
  const issuesEl = document.getElementById("issues");
  const issuesList = document.getElementById("issues-list");
  if (data.issues && data.issues.length > 0) {
    issuesEl.style.display = "block";
    issuesList.innerHTML = data.issues.map(i => '<li class="issue-' + i.severity + '"><strong>' + i.severity.toUpperCase() + ':</strong> ' + esc(i.msg) + '</li>').join("");
  } else { issuesEl.style.display = "none"; }
  const cards = [];
  const a = data.envVars.ADMIN_ID; cards.push(card("ADMIN_ID", a.set ? '<span class="status-ok">✓</span> <code>' + esc(a.value) + '</code>' : '<span class="status-fail">✗ NOT SET</span>'));
  const c = data.envVars.TARGET_CHANNEL; cards.push(card("TARGET_CHANNEL", c.set ? '<span class="status-ok">✓</span> <code>' + esc(c.value) + '</code>' : '<span class="status-warn">⚠ Not set</span>'));
  const kv = data.kv;
  if (kv.bound) { cards.push(card("KV", (kv.readable ? '<span class="status-ok">read ✓</span>' : '<span class="status-fail">read ✗</span>') + " " + (kv.writable ? '<span class="status-ok">write ✓</span>' : '<span class="status-fail">write ✗</span>'))); }
  else { cards.push(card("KV", '<span class="status-fail">✗ NOT BOUND</span>')); }
  for (const [name, info] of Object.entries(data.secrets)) { if (name === "DEBUG_TOKEN" && !info.set) continue; cards.push(card(name, info.set ? '<span class="status-ok">✓</span> <small>(' + info.length + ' chars)</small>' : '<span class="status-fail">✗</span>')); }
  document.getElementById("status-grid").innerHTML = cards.join("");
  const raws = data.recentRawRequests || [];
  if (raws.length === 0) { document.getElementById("raw-table").innerHTML = '<div class="empty">No raw requests yet. Send a message to your bot.</div>'; }
  else { document.getElementById("raw-table").innerHTML = '<table><thead><tr><th>Time</th><th>Type</th><th>From</th><th>Secret</th><th>Preview</th><th>Status</th></tr></thead><tbody>' + raws.map(r => '<tr><td class="timestamp">' + esc(fmtTime(r.time)) + '</td><td>' + esc(r.updateType) + '</td><td>' + esc(r.fromId) + '</td><td>' + (r.secretMatch ? '<span class="status-ok">✓</span>' : '<span class="status-fail">✗</span>') + '</td><td>' + esc(r.textPreview) + '</td><td>' + badge(r.status) + '</td></tr>').join("") + '</tbody></table>'; }
  const ups = data.recentUpdates || [];
  if (ups.length === 0) { document.getElementById("updates-table").innerHTML = '<div class="empty">No updates yet.</div>'; }
  else { document.getElementById("updates-table").innerHTML = '<table><thead><tr><th>Time</th><th>Type</th><th>From</th><th>Preview</th><th>Status</th></tr></thead><tbody>' + ups.map(u => '<tr><td class="timestamp">' + esc(fmtTime(u.time)) + '</td><td>' + esc(u.type) + '</td><td>' + esc(u.fromId) + '</td><td>' + esc(u.textPreview) + (u.detail ? '<br><small>' + esc(u.detail) + '</small>' : '') + '</td><td>' + badge(u.status) + '</td></tr>').join("") + '</tbody></table>'; }
  const errs = data.recentErrors || [];
  if (errs.length === 0) { document.getElementById("errors-table").innerHTML = '<div class="empty">No errors. 🎉</div>'; }
  else { document.getElementById("errors-table").innerHTML = '<table><thead><tr><th>Time</th><th>Error</th><th>Context</th></tr></thead><tbody>' + errs.map(e => '<tr><td class="timestamp">' + esc(fmtTime(e.time)) + '</td><td><strong>' + esc(e.error) + '</strong></td><td>' + esc(e.context) + '</td></tr>').join("") + '</tbody></table>'; }
  if (data.botInfo && data.botInfo.ok) { const b = data.botInfo.result; document.getElementById("bot-info").innerHTML = '<div class="grid">' + card("Bot ID", '<code>' + esc(b.id) + '</code>') + card("Username", '@' + esc(b.username)) + '</div>'; }
  else { document.getElementById("bot-info").innerHTML = '<div class="status-fail">Unavailable</div>'; }
  if (data.webhookInfo && data.webhookInfo.ok) { const w = data.webhookInfo.result; document.getElementById("webhook-info").innerHTML = '<div class="grid">' + card("URL", '<code>' + esc(w.url) + '</code>') + card("Pending", '<code>' + esc(w.pending_update_count) + '</code>') + (w.last_error_message ? card("Last Error", '<span class="status-fail">' + esc(w.last_error_message) + '</span>') : card("Last Error", '<span class="status-ok">none 🎉</span>')) + '</div>'; }
  else { document.getElementById("webhook-info").innerHTML = '<div class="status-fail">Unavailable</div>'; }
}
async function runTest(type) {
  const r = document.getElementById("action-result");
  r.classList.add("show");
  r.innerHTML = '<span class="spinner"></span> Running...';
  try { const res = await fetch(BASE + "/debug/api/test/" + type + QS, { method: "POST" }); const data = await res.json(); r.innerHTML = JSON.stringify(data, null, 2); }
  catch (e) { r.innerHTML = '<span class="status-fail">Error: ' + esc(e.message) + '</span>'; }
  setTimeout(loadStatus, 500);
}
async function clearLogs() {
  if (!confirm("Clear all logs?")) return;
  const r = document.getElementById("action-result");
  r.classList.add("show");
  r.innerHTML = 'Clearing...';
  try { const res = await fetch(BASE + "/debug/api/clear" + QS, { method: "POST" }); const data = await res.json(); r.innerHTML = JSON.stringify(data, null, 2); }
  catch (e) { r.innerHTML = '<span class="status-fail">Error: ' + esc(e.message) + '</span>'; }
  setTimeout(loadStatus, 500);
}
loadStatus();
setInterval(loadStatus, 15000);
</script>
</body>
</html>`;
}
