/**
 * src/debug.js
 * Debug dashboard and logging utilities for AI Admin.
 *
 * Endpoints (routed from src/index.js):
 *   GET  /debug                    → HTML dashboard (self-contained, no deps)
 *   GET  /debug/api/status         → JSON: env check, KV check, bot info, webhook info, recent logs
 *   POST /debug/api/test/message   → Send a test message to ADMIN_ID
 *   POST /debug/api/test/kv        → Test KV read/write
 *   POST /debug/api/test/ai        → Test AI provider (Gemini/OpenRouter)
 *   POST /debug/api/test/pipeline  → Run the full pipeline on sample text
 *   POST /debug/api/clear          → Clear debug logs
 *
 * Security:
 *   If DEBUG_TOKEN env var is set, all /debug/* requests require ?token=XXX to match.
 *   If not set, the dashboard is open (fine for debugging, lock it down for production).
 *
 * Logging:
 *   Updates and errors are stored in KV (last 30 each) so the dashboard can show
 *   them even after the worker has finished processing.
 */

const DEBUG_MAX_ENTRIES = 30;
const KEY_DEBUG_UPDATES = "debug:updates";
const KEY_DEBUG_ERRORS = "debug:errors";

// ============================================================
// LOGGING — store in KV for the dashboard
// ============================================================

export async function logUpdate(SETTINGS, update, status, detail = "") {
  if (!SETTINGS) return;
  try {
    const entry = {
      time: new Date().toISOString(),
      type: update.callback_query
        ? "callback_query"
        : update.message
        ? "message"
        : update.channel_post
        ? "channel_post"
        : "other",
      fromId:
        update.callback_query?.from?.id ||
        update.message?.from?.id ||
        update.channel_post?.from?.id ||
        null,
      chatId:
        update.callback_query?.message?.chat?.id ||
        update.message?.chat?.id ||
        update.channel_post?.chat?.id ||
        null,
      chatType:
        update.callback_query?.message?.chat?.type ||
        update.message?.chat?.type ||
        update.channel_post?.chat?.type ||
        null,
      textPreview: (
        update.callback_query?.data ||
        update.message?.text ||
        update.channel_post?.text ||
        update.message?.caption ||
        update.channel_post?.caption ||
        ""
      ).slice(0, 120),
      status, // "ok" | "error" | "ignored" | "unauthorized"
      detail,
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

export async function getRecentUpdates(SETTINGS) {
  if (!SETTINGS) return [];
  try {
    const raw = await SETTINGS.get(KEY_DEBUG_UPDATES);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function getRecentErrors(SETTINGS) {
  if (!SETTINGS) return [];
  try {
    const raw = await SETTINGS.get(KEY_DEBUG_ERRORS);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function clearDebugLogs(SETTINGS) {
  if (!SETTINGS) return;
  await SETTINGS.put(KEY_DEBUG_UPDATES, JSON.stringify([]));
  await SETTINGS.put(KEY_DEBUG_ERRORS, JSON.stringify([]));
}

// ============================================================
// AUTH — optional token-based protection
// ============================================================

export function checkDebugAuth(request, env) {
  if (!env.DEBUG_TOKEN) return { ok: true }; // No token set → open access
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || url.searchParams.get("t");
  return { ok: token === env.DEBUG_TOKEN, required: true };
}

// ============================================================
// STATUS GATHERER
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

  // KV binding check
  const kvStatus = { bound: !!SETTINGS, readable: false, writable: false, error: null };
  if (SETTINGS) {
    try {
      await SETTINGS.get("__debug_kv_test__");
      kvStatus.readable = true;
    } catch (e) {
      kvStatus.error = `read: ${e.message}`;
    }
    try {
      await SETTINGS.put("__debug_kv_test__", String(Date.now()));
      kvStatus.writable = true;
    } catch (e) {
      kvStatus.error = (kvStatus.error ? kvStatus.error + " | " : "") + `write: ${e.message}`;
    }
  }

  // Bot info
  let botInfo = null;
  if (env.BOT_TOKEN) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getMe`);
      botInfo = await res.json();
    } catch (e) {
      botInfo = { ok: false, error: e.message };
    }
  } else {
    botInfo = { ok: false, error: "BOT_TOKEN not set" };
  }

  // Webhook info
  let webhookInfo = null;
  if (env.BOT_TOKEN) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getWebhookInfo`);
      webhookInfo = await res.json();
    } catch (e) {
      webhookInfo = { ok: false, error: e.message };
    }
  }

  // Recent logs
  const recentUpdates = await getRecentUpdates(SETTINGS);
  const recentErrors = await getRecentErrors(SETTINGS);

  // Diagnosis — auto-detect common issues
  const issues = [];
  if (!env.ADMIN_ID) issues.push({ severity: "critical", msg: "ADMIN_ID is not set. Bot will ignore all messages." });
  else if (botInfo.ok && String(env.ADMIN_ID) === String(botInfo.result.id))
    issues.push({ severity: "warning", msg: "ADMIN_ID is set to the BOT's own ID. It should be YOUR personal Telegram user ID." });
  if (!env.TARGET_CHANNEL) issues.push({ severity: "warning", msg: "TARGET_CHANNEL is not set. Publishing will fail." });
  if (!SETTINGS) issues.push({ severity: "critical", msg: "KV namespace 'SETTINGS' is not bound. Settings cannot be read/written." });
  else if (!kvStatus.readable || !kvStatus.writable)
    issues.push({ severity: "critical", msg: `KV read/write failed: ${kvStatus.error}` });

  // === WEBHOOK 403 DIAGNOSIS (most common silent failure cause) ===
  if (webhookInfo?.ok && webhookInfo.result.last_error_message) {
    const errMsg = webhookInfo.result.last_error_message;
    const is403 = /403|forbidden/i.test(errMsg);

    if (is403 && env.WEBHOOK_SECRET) {
      // Worker has WEBHOOK_SECRET set, but Telegram is getting 403.
      // This happens when setWebhook was called WITHOUT the secret_token parameter,
      // so Telegram doesn't send the x-telegram-bot-api-secret-token header.
      issues.push({
        severity: "critical",
        msg: `Webhook returns 403 Forbidden. The Worker has WEBHOOK_SECRET set, but Telegram was NOT configured to send the secret_token header. Run: node scripts/fix-webhook.mjs https://your-worker.workers.dev (the script reads WEBHOOK_SECRET from .dev.vars and re-registers the webhook with the correct secret_token).`,
      });
    } else if (is403 && !env.WEBHOOK_SECRET) {
      issues.push({
        severity: "critical",
        msg: `Webhook returns 403 Forbidden but WEBHOOK_SECRET is NOT set in the Worker. This may indicate a deployment issue. Try: npm run deploy && node scripts/fix-webhook.mjs https://your-worker.workers.dev`,
      });
    } else {
      issues.push({ severity: "warning", msg: `Telegram reports webhook error: ${errMsg}` });
    }
  }

  // Pending updates = telegram is retrying but failing
  if (webhookInfo?.ok && webhookInfo.result.pending_update_count > 0) {
    issues.push({
      severity: "warning",
      msg: `${webhookInfo.result.pending_update_count} pending updates queued in Telegram. These will keep retrying (and failing) until the webhook is fixed. The fix-webhook.mjs script drops them.`,
    });
  }

  if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY)
    issues.push({ severity: "warning", msg: "No AI API keys set. Only FORMAT_ONLY mode will work." });

  return {
    time: new Date().toISOString(),
    envVars,
    secrets,
    kv: kvStatus,
    botInfo,
    webhookInfo,
    recentUpdates,
    recentErrors,
    issues,
  };
}

// ============================================================
// TEST ACTIONS
// ============================================================

export async function sendTestMessage(env) {
  if (!env.ADMIN_ID) return { ok: false, error: "ADMIN_ID is not set" };
  if (!env.BOT_TOKEN) return { ok: false, error: "BOT_TOKEN is not set" };
  const res = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.ADMIN_ID,
      text: "🧪 <b>Debug Test from AI Admin</b>\n\nIf you received this message, then:\n✅ <code>BOT_TOKEN</code> is correct\n✅ <code>ADMIN_ID</code> matches your Telegram ID\n✅ Bot can send messages to you",
      parse_mode: "HTML",
    }),
  });
  return res.json();
}

export async function testKV(SETTINGS) {
  if (!SETTINGS) return { ok: false, error: "KV not bound" };
  const testKey = `__kv_test_${Date.now()}__`;
  const testValue = `hello-${Date.now()}`;
  try {
    await SETTINGS.put(testKey, testValue);
    const readBack = await SETTINGS.get(testKey);
    await SETTINGS.delete(testKey);
    if (readBack === testValue) {
      return { ok: true, msg: "KV read/write/delete all succeeded" };
    }
    return { ok: false, error: `Value mismatch: wrote "${testValue}", read "${readBack}"` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function testAI(env) {
  const provider = env.DEFAULT_AI_PROVIDER || "gemini";
  const model = provider === "openrouter" ? (env.OPENROUTER_MODEL || "google/gemini-2.0-flash-exp:free") : (env.GEMINI_MODEL || "gemini-2.0-flash");
  const apiKey = provider === "openrouter" ? env.OPENROUTER_API_KEY : env.GEMINI_API_KEY;

  if (!apiKey) return { ok: false, error: `${provider} API key is not set` };

  const userMsg = "Reply with exactly: AI_OK";
  const systemMsg = "You are a test endpoint. Reply with exactly: AI_OK";

  try {
    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemMsg }] },
          contents: [{ role: "user", parts: [{ text: userMsg }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 50 },
        }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: `Gemini ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}` };
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      return { ok: true, provider, model, response: text.trim().slice(0, 200) };
    } else {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ai-admin.workers.dev",
          "X-Title": "AI Admin Debug",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: systemMsg }, { role: "user", content: userMsg }],
          temperature: 0,
          max_tokens: 50,
        }),
      });
      const data = await res.json();
      if (!res.ok) return { ok: false, error: `OpenRouter ${res.status}: ${JSON.stringify(data.error || data).slice(0, 300)}` };
      const text = data?.choices?.[0]?.message?.content ?? "";
      return { ok: true, provider, model, response: text.trim().slice(0, 200) };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ============================================================
// HTML DASHBOARD (self-contained, no external deps)
// ============================================================

export function debugHTML(baseUrl = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Admin — Debug Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0d1117; color: #c9d1d9; line-height: 1.6; padding: 20px;
  }
  .container { max-width: 1100px; margin: 0 auto; }
  h1 { color: #58a6ff; margin-bottom: 8px; font-size: 1.8em; }
  .subtitle { color: #8b949e; margin-bottom: 24px; font-size: 0.9em; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
  .refresh-btn {
    background: #238636; color: white; border: none; padding: 8px 16px;
    border-radius: 6px; cursor: pointer; font-size: 0.9em;
  }
  .refresh-btn:hover { background: #2ea043; }
  .section {
    background: #161b22; border: 1px solid #30363d; border-radius: 8px;
    padding: 16px; margin-bottom: 16px;
  }
  .section h2 { color: #58a6ff; font-size: 1.1em; margin-bottom: 12px; border-bottom: 1px solid #30363d; padding-bottom: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 12px; }
  .card {
    background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 12px;
  }
  .card-label { color: #8b949e; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
  .card-value { font-family: 'SF Mono', Consolas, monospace; font-size: 0.9em; word-break: break-all; }
  .status-ok { color: #3fb950; }
  .status-fail { color: #f85149; }
  .status-warn { color: #d29922; }
  .issues { list-style: none; }
  .issues li { padding: 8px 12px; margin-bottom: 6px; border-radius: 4px; font-size: 0.9em; }
  .issue-critical { background: rgba(248,81,73,0.15); border-left: 3px solid #f85149; }
  .issue-warning { background: rgba(210,153,34,0.15); border-left: 3px solid #d29922; }
  .actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .btn {
    background: #21262d; color: #c9d1d9; border: 1px solid #30363d; padding: 8px 14px;
    border-radius: 6px; cursor: pointer; font-size: 0.85em; font-family: inherit;
  }
  .btn:hover { background: #30363d; border-color: #8b949e; }
  .btn-primary { background: #1f6feb; border-color: #1f6feb; color: white; }
  .btn-primary:hover { background: #388bfd; }
  .btn-danger { background: #da3633; border-color: #da3633; color: white; }
  .btn-danger:hover { background: #f85149; }
  .result {
    margin-top: 10px; padding: 10px; background: #0d1117; border: 1px solid #30363d;
    border-radius: 4px; font-family: 'SF Mono', Consolas, monospace; font-size: 0.85em;
    white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto;
    display: none;
  }
  .result.show { display: block; }
  table { width: 100%; border-collapse: collapse; font-size: 0.85em; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #30363d; vertical-align: top; }
  th { color: #8b949e; font-weight: 600; text-transform: uppercase; font-size: 0.8em; }
  tr:hover { background: rgba(88,166,255,0.05); }
  .badge {
    display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.75em;
    font-weight: 600;
  }
  .badge-ok { background: rgba(63,185,80,0.2); color: #3fb950; }
  .badge-error { background: rgba(248,81,73,0.2); color: #f85149; }
  .badge-ignored { background: rgba(139,148,158,0.2); color: #8b949e; }
  .badge-unauthorized { background: rgba(248,81,73,0.2); color: #f85149; }
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .empty { color: #8b949e; font-style: italic; text-align: center; padding: 20px; }
  .timestamp { color: #8b949e; font-size: 0.8em; font-family: monospace; }
  details { margin-top: 8px; }
  summary { cursor: pointer; color: #58a6ff; font-size: 0.85em; }
  details pre { margin-top: 8px; font-size: 0.8em; color: #8b949e; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <div>
      <h1>🔧 AI Admin — Debug Dashboard</h1>
      <div class="subtitle">v0.1.1 · Live diagnostics for your Telegram bot</div>
    </div>
    <button class="refresh-btn" onclick="loadStatus()">↻ Refresh</button>
  </div>

  <div id="issues" class="section" style="display:none;">
    <h2>⚠️ Detected Issues</h2>
    <ul class="issues" id="issues-list"></ul>
  </div>

  <div class="section">
    <h2>📊 Status Overview</h2>
    <div class="grid" id="status-grid">
      <div class="card"><div class="card-label">Loading...</div></div>
    </div>
  </div>

  <div class="section">
    <h2>🧪 Quick Actions</h2>
    <div class="actions">
      <button class="btn btn-primary" onclick="runTest('message')">📤 Send Test Message</button>
      <button class="btn" onclick="runTest('kv')">💾 Test KV</button>
      <button class="btn" onclick="runTest('ai')">🤖 Test AI</button>
      <button class="btn btn-danger" onclick="clearLogs()">🗑️ Clear Logs</button>
    </div>
    <div id="action-result" class="result"></div>
  </div>

  <div class="section">
    <h2>📜 Recent Updates (last 30)</h2>
    <div id="updates-table"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <h2>❌ Recent Errors (last 30)</h2>
    <div id="errors-table"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <h2>🔧 Bot Info</h2>
    <div id="bot-info"><div class="empty">Loading...</div></div>
  </div>

  <div class="section">
    <h2>🔗 Webhook Info</h2>
    <div id="webhook-info"><div class="empty">Loading...</div></div>
  </div>
</div>

<script>
const BASE = "";
let lastStatus = null;

async function loadStatus() {
  try {
    const res = await fetch(BASE + "/debug/api/status");
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    const data = await res.json();
    lastStatus = data;
    renderStatus(data);
  } catch (e) {
    document.getElementById("status-grid").innerHTML =
      '<div class="card"><div class="card-label">Error</div><div class="card-value status-fail">' + e.message + '</div></div>';
  }
}

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function fmtTime(ts) {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch { return ts; }
}

function badge(status) {
  const cls = status === "ok" ? "badge-ok" : (status === "error" ? "badge-error" : (status === "unauthorized" ? "badge-unauthorized" : "badge-ignored"));
  return '<span class="badge ' + cls + '">' + esc(status) + '</span>';
}

function renderStatus(data) {
  // Issues
  const issuesEl = document.getElementById("issues");
  const issuesList = document.getElementById("issues-list");
  if (data.issues && data.issues.length > 0) {
    issuesEl.style.display = "block";
    issuesList.innerHTML = data.issues.map(i =>
      '<li class="issue-' + i.severity + '"><strong>' + i.severity.toUpperCase() + ':</strong> ' + esc(i.msg) + '</li>'
    ).join("");
  } else {
    issuesEl.style.display = "none";
  }

  // Status grid
  const cards = [];

  // ADMIN_ID
  const adminId = data.envVars.ADMIN_ID;
  cards.push(card("ADMIN_ID",
    adminId.set
      ? '<span class="status-ok">✓ Set</span> → <code>' + esc(adminId.value) + '</code>'
      : '<span class="status-fail">✗ NOT SET</span>'
  ));

  // TARGET_CHANNEL
  const ch = data.envVars.TARGET_CHANNEL;
  cards.push(card("TARGET_CHANNEL",
    ch.set
      ? '<span class="status-ok">✓ Set</span> → <code>' + esc(ch.value) + '</code>'
      : '<span class="status-warn">⚠ Not set</span>'
  ));

  // KV
  const kv = data.kv;
  if (kv.bound) {
    const rOk = kv.readable ? '<span class="status-ok">read ✓</span>' : '<span class="status-fail">read ✗</span>';
    const wOk = kv.writable ? '<span class="status-ok">write ✓</span>' : '<span class="status-fail">write ✗</span>';
    cards.push(card("KV (SETTINGS)", rOk + " " + wOk + (kv.error ? '<br><small class="status-fail">' + esc(kv.error) + '</small>' : "")));
  } else {
    cards.push(card("KV (SETTINGS)", '<span class="status-fail">✗ NOT BOUND</span><br><small>Bind a KV namespace with variable name <code>SETTINGS</code></small>'));
  }

  // Secrets
  for (const [name, info] of Object.entries(data.secrets)) {
    if (name === "DEBUG_TOKEN" && !info.set) continue;
    cards.push(card(name,
      info.set
        ? '<span class="status-ok">✓ Set</span> <small>(' + info.length + ' chars, ' + esc(info.preview) + ')</small>'
        : '<span class="status-fail">✗ Not set</span>'
    ));
  }

  document.getElementById("status-grid").innerHTML = cards.join("");

  // Updates table
  const updates = data.recentUpdates || [];
  if (updates.length === 0) {
    document.getElementById("updates-table").innerHTML = '<div class="empty">No updates received yet. Send a message to your bot to see it here.</div>';
  } else {
    document.getElementById("updates-table").innerHTML =
      '<table><thead><tr><th>Time</th><th>Type</th><th>From</th><th>Chat</th><th>Preview</th><th>Status</th></tr></thead><tbody>' +
      updates.map(u =>
        '<tr><td class="timestamp">' + esc(fmtTime(u.time)) + '</td><td>' + esc(u.type) + '</td><td>' + esc(u.fromId) + '</td><td>' + esc(u.chatType) + ' ' + esc(u.chatId) + '</td><td>' + esc(u.textPreview) + (u.detail ? '<br><small>' + esc(u.detail) + '</small>' : '') + '</td><td>' + badge(u.status) + '</td></tr>'
      ).join("") + '</tbody></table>';
  }

  // Errors table
  const errors = data.recentErrors || [];
  if (errors.length === 0) {
    document.getElementById("errors-table").innerHTML = '<div class="empty">No errors recorded. 🎉</div>';
  } else {
    document.getElementById("errors-table").innerHTML =
      '<table><thead><tr><th>Time</th><th>Error</th><th>Context</th></tr></thead><tbody>' +
      errors.map(e =>
        '<tr><td class="timestamp">' + esc(fmtTime(e.time)) + '</td><td><strong>' + esc(e.error) + '</strong>' + (e.stack ? '<details><summary>stack</summary><pre>' + esc(e.stack) + '</pre></details>' : '') + '</td><td>' + esc(e.context) + '</td></tr>'
      ).join("") + '</tbody></table>';
  }

  // Bot info
  if (data.botInfo && data.botInfo.ok) {
    const b = data.botInfo.result;
    document.getElementById("bot-info").innerHTML =
      '<div class="grid">' +
      card("Bot ID", '<code>' + esc(b.id) + '</code>') +
      card("Username", '@' + esc(b.username)) +
      card("First Name", esc(b.first_name)) +
      card("Can Join Groups", b.can_join_groups ? '<span class="status-ok">yes</span>' : '<span class="status-fail">no</span>') +
      card("Can Read All Group Msgs", b.can_read_all_group_messages ? '<span class="status-ok">yes</span>' : '<span class="status-fail">no</span>') +
      '</div>';
  } else {
    document.getElementById("bot-info").innerHTML = '<div class="status-fail">Bot info unavailable: ' + esc(data.botInfo?.error || "unknown") + '</div>';
  }

  // Webhook info
  if (data.webhookInfo && data.webhookInfo.ok) {
    const w = data.webhookInfo.result;
    const lastErr = w.last_error_message;
    const lastErrDate = w.last_error_date ? new Date(w.last_error_date * 1000).toLocaleString() : null;
    document.getElementById("webhook-info").innerHTML =
      '<div class="grid">' +
      card("URL", '<code>' + esc(w.url) + '</code>') +
      card("Pending Updates", '<code>' + esc(w.pending_update_count) + '</code>') +
      card("Max Connections", '<code>' + esc(w.max_connections) + '</code>') +
      card("Custom Cert", w.has_custom_certificate ? 'yes' : 'no') +
      card("IP Address", '<code>' + esc(w.ip_address || 'n/a') + '</code>') +
      (lastErr ? card("Last Error", '<span class="status-fail">' + esc(lastErr) + '</span><br><small>' + esc(lastErrDate) + '</small>') : card("Last Error", '<span class="status-ok">none 🎉</span>')) +
      '</div>';
  } else {
    document.getElementById("webhook-info").innerHTML = '<div class="status-fail">Webhook info unavailable: ' + esc(data.webhookInfo?.error || "unknown") + '</div>';
  }
}

function card(label, valueHtml) {
  return '<div class="card"><div class="card-label">' + label + '</div><div class="card-value">' + valueHtml + '</div></div>';
}

async function runTest(type) {
  const resultEl = document.getElementById("action-result");
  resultEl.classList.add("show");
  resultEl.innerHTML = '<span class="spinner"></span> Running test...';
  try {
    const res = await fetch(BASE + "/debug/api/test/" + type, { method: "POST" });
    const data = await res.json();
    resultEl.innerHTML = JSON.stringify(data, null, 2);
  } catch (e) {
    resultEl.innerHTML = '<span class="status-fail">Error: ' + esc(e.message) + '</span>';
  }
  // Refresh status after test
  setTimeout(loadStatus, 500);
}

async function clearLogs() {
  if (!confirm("Clear all debug logs?")) return;
  const resultEl = document.getElementById("action-result");
  resultEl.classList.add("show");
  resultEl.innerHTML = '<span class="spinner"></span> Clearing...';
  try {
    const res = await fetch(BASE + "/debug/api/clear", { method: "POST" });
    const data = await res.json();
    resultEl.innerHTML = JSON.stringify(data, null, 2);
  } catch (e) {
    resultEl.innerHTML = '<span class="status-fail">Error: ' + esc(e.message) + '</span>';
  }
  setTimeout(loadStatus, 500);
}

// Auto-load on page open
loadStatus();
// Auto-refresh every 15 seconds
setInterval(loadStatus, 15000);
</script>
</body>
</html>`;
}
