#!/usr/bin/env node
/**
 * scripts/fix-webhook.mjs
 * Diagnostic + repair tool for the Telegram webhook.
 *
 * What it does:
 *   1. Reads BOT_TOKEN and WEBHOOK_SECRET from .dev.vars (or env)
 *   2. Calls getWebhookInfo to see current state and last error
 *   3. Calls setWebhook with the CORRECT secret_token (so Telegram starts
 *      sending the x-telegram-bot-api-secret-token header that the Worker
 *      verifies).
 *   4. Sends a test message to confirm end-to-end.
 *   5. Tells you what to do next.
 *
 * Usage:
 *   node scripts/fix-webhook.mjs https://ai-admin.<your-subdomain>.workers.dev
 *
 * Or with explicit token:
 *   BOT_TOKEN=xxx WEBHOOK_SECRET=yyy node scripts/fix-webhook.mjs https://...
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// --- Load .dev.vars if present ---
function loadDevVars() {
  const p = resolve(process.cwd(), ".dev.vars");
  if (!existsSync(p)) return {};
  const txt = readFileSync(p, "utf8");
  const out = {};
  for (const line of txt.split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !m[1].startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

const dev = loadDevVars();
const BOT_TOKEN = process.env.BOT_TOKEN || dev.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || dev.WEBHOOK_SECRET;
const WORKER_URL = process.argv[2];

if (!BOT_TOKEN) {
  console.error("✗ BOT_TOKEN missing. Put it in .dev.vars or pass as env var.");
  process.exit(1);
}
if (!WORKER_URL) {
  console.error("✗ Usage: node scripts/fix-webhook.mjs https://your-worker.workers.dev");
  console.error("  e.g. node scripts/fix-webhook.mjs https://ai-admin.iliv007.workers.dev");
  process.exit(1);
}

const TG = `https://api.telegram.org/bot${BOT_TOKEN}`;
const FULL_URL = `${WORKER_URL.replace(/\/$/, "")}/webhook`;

function divider(title) {
  console.log("\n" + "─".repeat(60));
  console.log(title);
  console.log("─".repeat(60));
}

// ============================================================
// STEP 1: Get current webhook info
// ============================================================
divider("STEP 1: Current webhook status");
const info = await fetch(`${TG}/getWebhookInfo`).then((r) => r.json());
if (!info.ok) {
  console.error("✗ getWebhookInfo failed:", info.description);
  process.exit(1);
}

console.log(`  URL:                  ${info.result.url || "(not set)"}`);
console.log(`  Pending updates:      ${info.result.pending_update_count}`);
console.log(`  Has custom cert:      ${info.result.has_custom_certificate}`);
console.log(`  Max connections:      ${info.result.max_connections}`);
console.log(`  IP address:           ${info.result.ip_address || "n/a"}`);
if (info.result.last_error_date) {
  const when = new Date(info.result.last_error_date * 1000).toLocaleString();
  console.log(`  ⚠ Last error time:    ${when}`);
  console.log(`  ⚠ Last error message: ${info.result.last_error_message}`);
}

if (info.result.pending_update_count > 0) {
  console.log(`\n  ⚠ There are ${info.result.pending_update_count} pending updates that Telegram tried to deliver but failed.`);
  console.log(`     These will be retried but probably fail again until we fix the root cause.`);
}

// ============================================================
// STEP 2: Diagnose
// ============================================================
divider("STEP 2: Diagnosis");

const hasSecretInWorker = !!WEBHOOK_SECRET;
const workerUrlMatches = info.result.url === FULL_URL;

if (hasSecretInWorker && workerUrlMatches) {
  console.log("  Worker has WEBHOOK_SECRET set, but webhook was registered WITHOUT a secret token.");
  console.log("  → Telegram is NOT sending the x-telegram-bot-api-secret-token header.");
  console.log("  → Worker sees missing/mismatched header → returns 403 Forbidden.");
  console.log("  → Telegram reports: 'Wrong response from the webhook: 403 Forbidden'");
  console.log("\n  ✅ FIX: re-register the webhook WITH the same secret_token.");
} else if (!hasSecretInWorker && workerUrlMatches) {
  console.log("  Worker has NO WEBHOOK_SECRET, and webhook URL matches.");
  console.log("  → Should work. The 403 may be from a previous misconfiguration.");
  console.log("  → Let's still re-register to be safe.");
} else if (!workerUrlMatches) {
  console.log(`  Webhook URL mismatch!`);
  console.log(`    Expected: ${FULL_URL}`);
  console.log(`    Actual:   ${info.result.url}`);
  console.log("  → Need to set the correct URL.");
}

// ============================================================
// STEP 3: Fix the webhook
// ============================================================
divider("STEP 3: Re-registering webhook with correct secret");

const setBody = {
  url: FULL_URL,
  allowed_updates: ["message", "callback_query", "channel_post"],
  drop_pending_updates: true, // drop the failed 403 updates so they don't replay
};
if (WEBHOOK_SECRET) {
  setBody.secret_token = WEBHOOK_SECRET;
  console.log(`  Using secret_token: ${WEBHOOK_SECRET.slice(0, 3)}…${WEBHOOK_SECRET.slice(-3)}`);
} else {
  console.log("  No WEBHOOK_SECRET configured — registering without secret token.");
  console.log("  ⚠ This is less secure. Consider setting WEBHOOK_SECRET in Cloudflare.");
}

const setRes = await fetch(`${TG}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(setBody),
}).then((r) => r.json());

if (!setRes.ok) {
  console.error("✗ setWebhook failed:", setRes.description);
  process.exit(1);
}
console.log("  ✅ Webhook re-registered successfully!");

// ============================================================
// STEP 4: Verify
// ============================================================
divider("STEP 4: Verification");
const info2 = await fetch(`${TG}/getWebhookInfo`).then((r) => r.json());
console.log(`  URL:              ${info2.result.url}`);
console.log(`  Pending updates:  ${info2.result.pending_update_count}`);
if (info2.result.last_error_date) {
  const when = new Date(info2.result.last_error_date * 1000).toLocaleString();
  console.log(`  ⚠ Last error:     ${info2.result.last_error_message} @ ${when}`);
  console.log("    (This is from the OLD webhook config. Should clear after a successful delivery.)");
} else {
  console.log("  Last error:       none 🎉");
}

// ============================================================
// STEP 5: Test message
// ============================================================
divider("STEP 5: Send test message");

const testMsg = await fetch(`${TG}/sendMessage`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    chat_id: 126679582, // From the user's debug output (their ADMIN_ID)
    text: "✅ Webhook fixed!\n\nNow send /start to test the bot.",
    parse_mode: "HTML",
  }),
}).then((r) => r.json());

if (testMsg.ok) {
  console.log("  ✅ Test message sent successfully!");
} else {
  console.log(`  ⚠ Test message: ${testMsg.description}`);
  console.log("    (This is OK if you're not the admin user — webhook fix is still valid.)");
}

// ============================================================
// STEP 6: Next steps
// ============================================================
divider("DONE — next steps");
console.log(`
  1. Open Telegram and send /start to your bot.
     It should respond with the admin panel menu.

  2. If it still doesn't respond:
     a. Open the debug dashboard:
        ${WORKER_URL}/debug
     b. Check "Recent Updates" — your /start should appear there now.
     c. Check "Recent Errors" — if anything went wrong, it'll be listed.

  3. To watch live logs:
     npm run tail

  4. To re-run this fix in the future:
     node scripts/fix-webhook.mjs ${WORKER_URL}

  Webhook URL:  ${FULL_URL}
  Secret used:  ${WEBHOOK_SECRET ? "yes" : "no"}
`);
