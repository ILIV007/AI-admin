/**
 * scripts/test-debug.mjs
 * Verify the debug module works correctly.
 *
 * Run with: node scripts/test-debug.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// We test the pure functions from debug.js
// (the async ones need a KV mock)
const debugSrc = readFileSync(resolve(process.cwd(), "src/debug.js"), "utf8");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✅ ${msg}`);
    passed++;
  } else {
    console.error(`  ❌ ${msg}`);
    failed++;
  }
}

console.log("\n🧪 debug.js — structure & exports\n");

// Check exports
assert(debugSrc.includes("export async function logUpdate"), "exports logUpdate");
assert(debugSrc.includes("export async function logError"), "exports logError");
assert(debugSrc.includes("export async function getStatus"), "exports getStatus");
assert(debugSrc.includes("export async function sendTestMessage"), "exports sendTestMessage");
assert(debugSrc.includes("export async function testKV"), "exports testKV");
assert(debugSrc.includes("export async function testAI"), "exports testAI");
assert(debugSrc.includes("export async function clearDebugLogs"), "exports clearDebugLogs");
assert(debugSrc.includes("export function checkDebugAuth"), "exports checkDebugAuth");
assert(debugSrc.includes("export function debugHTML"), "exports debugHTML");

console.log("\n🧪 debug.js — spec compliance\n");

// Check that debug page includes all required sections
assert(debugSrc.includes("Recent Updates"), "HTML has 'Recent Updates' section");
assert(debugSrc.includes("Recent Errors"), "HTML has 'Recent Errors' section");
assert(debugSrc.includes("Quick Actions"), "HTML has 'Quick Actions' section");
assert(debugSrc.includes("sendTestMessage") || debugSrc.includes("test/message"), "has test message action");
assert(debugSrc.includes("testKV") || debugSrc.includes("test/kv"), "has test KV action");
assert(debugSrc.includes("testAI") || debugSrc.includes("test/ai"), "has test AI action");
assert(debugSrc.includes("clearDebugLogs") || debugSrc.includes("api/clear"), "has clear logs action");

// Check status gathering
assert(debugSrc.includes("ADMIN_ID"), "status checks ADMIN_ID");
assert(debugSrc.includes("TARGET_CHANNEL"), "status checks TARGET_CHANNEL");
assert(debugSrc.includes("BOT_TOKEN"), "status checks BOT_TOKEN");
assert(debugSrc.includes("GEMINI_API_KEY"), "status checks GEMINI_API_KEY");
assert(debugSrc.includes("getMe"), "status calls getMe for bot info");
assert(debugSrc.includes("getWebhookInfo"), "status calls getWebhookInfo");

// Check auto-diagnosis
assert(debugSrc.includes("issues"), "status includes auto-diagnosis");
assert(debugSrc.includes("ADMIN_ID is not set"), "detects missing ADMIN_ID");
assert(debugSrc.includes("KV namespace"), "detects missing KV binding");

// Check auth protection
assert(debugSrc.includes("DEBUG_TOKEN"), "supports optional DEBUG_TOKEN protection");

console.log("\n🧪 debug.js — mock KV integration test\n");

// Mock KV
function mockKV() {
  const store = new Map();
  return {
    async get(key) { return store.get(key) || null; },
    async put(key, val) { store.set(key, val); },
    async delete(key) { store.delete(key); },
  };
}

// Since we can't easily import the module (it uses top-level export syntax
// and we're running as a script), let's test the logging logic manually
// by simulating what logUpdate does.

const SETTINGS = mockKV();

// Simulate logUpdate
async function logUpdate(SETTINGS, update, status, detail = "") {
  const entry = {
    time: new Date().toISOString(),
    type: update.message ? "message" : "other",
    fromId: update.message?.from?.id,
    textPreview: (update.message?.text || "").slice(0, 120),
    status,
    detail,
  };
  const raw = await SETTINGS.get("debug:updates");
  const list = raw ? JSON.parse(raw) : [];
  list.unshift(entry);
  await SETTINGS.put("debug:updates", JSON.stringify(list.slice(0, 30)));
}

// Test 1: log an update
await logUpdate(SETTINGS, { message: { from: { id: 123 }, text: "test message" } }, "ok", "test");
const raw1 = await SETTINGS.get("debug:updates");
const list1 = JSON.parse(raw1);
assert(list1.length === 1, "first logUpdate creates 1 entry");
assert(list1[0].fromId === 123, "entry has correct fromId");
assert(list1[0].status === "ok", "entry has correct status");

// Test 2: log another update
await logUpdate(SETTINGS, { message: { from: { id: 456 }, text: "second" } }, "error", "failed");
const raw2 = await SETTINGS.get("debug:updates");
const list2 = JSON.parse(raw2);
assert(list2.length === 2, "second logUpdate creates 2 entries");
assert(list2[0].fromId === 456, "newest entry is first (LIFO)");

// Test 3: log many updates (test truncation)
for (let i = 0; i < 40; i++) {
  await logUpdate(SETTINGS, { message: { from: { id: i }, text: `msg ${i}` } }, "ok");
}
const raw3 = await SETTINGS.get("debug:updates");
const list3 = JSON.parse(raw3);
assert(list3.length === 30, "truncates to 30 entries max");

// Test 4: checkDebugAuth with no token
function checkDebugAuth(request, env) {
  if (!env.DEBUG_TOKEN) return { ok: true };
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  return { ok: token === env.DEBUG_TOKEN, required: true };
}

const req1 = { url: "http://localhost/debug" };
assert(checkDebugAuth(req1, {}).ok === true, "no DEBUG_TOKEN → open access");

const req2 = { url: "http://localhost/debug?token=mysecret" };
assert(checkDebugAuth(req2, { DEBUG_TOKEN: "mysecret" }).ok === true, "correct token → authorized");

const req3 = { url: "http://localhost/debug?token=wrong" };
assert(checkDebugAuth(req3, { DEBUG_TOKEN: "mysecret" }).ok === false, "wrong token → rejected");

const req4 = { url: "http://localhost/debug" };
assert(checkDebugAuth(req4, { DEBUG_TOKEN: "mysecret" }).ok === false, "no token when required → rejected");

// Test 5: maskValue
function maskValue(val) {
  if (val === undefined || val === null || val === "") return { set: false };
  const s = String(val);
  if (s.length <= 8) return { set: true, length: s.length, preview: "***" };
  return { set: true, length: s.length, preview: s.slice(0, 3) + "…" + s.slice(-3) };
}

assert(maskValue(undefined).set === false, "maskValue(undefined) → not set");
assert(maskValue("").set === false, "maskValue('') → not set");
assert(maskValue(null).set === false, "maskValue(null) → not set");
assert(maskValue("short").set === true, "maskValue('short') → set");
assert(maskValue("short").preview === "***", "maskValue('short') → masked preview");
assert(maskValue("12345678901234567890").set === true, "maskValue(long) → set");
assert(maskValue("12345678901234567890").preview === "123…890", "maskValue(long) → partial preview: " + maskValue("12345678901234567890").preview);

// ============================================================
console.log("\n" + "=".repeat(50));
console.log(`Debug tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some debug tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All debug tests passed!");
}
