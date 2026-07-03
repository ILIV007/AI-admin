/**
 * scripts/test-raw-logging.mjs
 * Verify raw request logging works for the new diagnostic dashboard section.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const debugSrc = readFileSync(resolve(process.cwd(), "src/debug.js"), "utf8");
const indexSrc = readFileSync(resolve(process.cwd(), "src/index.js"), "utf8");
const telegramSrc = readFileSync(resolve(process.cwd(), "src/telegram.js"), "utf8");

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

console.log("\n🧪 Raw Request Logging — Spec Compliance\n");

// debug.js
console.log("debug.js:");
assert(debugSrc.includes("logRawRequest"), "logRawRequest function exists");
assert(debugSrc.includes("getRecentRawRequests"), "getRecentRawRequests function exists");
assert(debugSrc.includes("KEY_DEBUG_RAW"), "has KEY_DEBUG_RAW constant");
assert(debugSrc.includes("recentRawRequests"), "getStatus includes recentRawRequests");
assert(debugSrc.includes("Recent Raw Requests"), "HTML has 'Recent Raw Requests' section");
assert(debugSrc.includes("rejected_403"), "HTML shows 403 status badge");
assert(debugSrc.includes("raw-table"), "HTML has raw-table container");
assert(debugSrc.includes("rejected_400"), "logs 400 status");
assert(debugSrc.includes("secretMatch"), "tracks secretMatch status");
assert(debugSrc.includes("secret"), "tracks secret presence");

// index.js
console.log("\nindex.js:");
assert(indexSrc.includes("logRawRequest"), "imports logRawRequest");
assert(indexSrc.includes("extractUpdateInfoForLog"), "has extractUpdateInfoForLog helper");
assert(indexSrc.includes("rejected_403"), "logs 403 with status 'rejected_403'");
assert(indexSrc.includes("rejected_400"), "logs 400 with status 'rejected_400'");
assert(indexSrc.includes('status: "ok"'), "logs successful requests with status 'ok'");
assert(indexSrc.includes("secretMatches"), "computes secretMatches");
assert(indexSrc.includes("bodySize"), "logs body size");

// telegram.js
console.log("\ntelegram.js:");
assert(telegramSrc.includes("sendChatAction"), "sendChatAction exists");
assert(telegramSrc.includes("export async function sendChatAction"), "sendChatAction is exported");

// index.js typing
console.log("\nTyping indicator:");
assert(indexSrc.includes('sendChatAction'), "index uses sendChatAction");
assert(indexSrc.includes('"typing"'), "sends 'typing' action");
assert(indexSrc.includes("IMMEDIATELY"), "comment marks it as immediate");

// Diagnosis in debug.js
console.log("\nAuto-diagnosis:");
assert(debugSrc.includes("No raw requests logged yet"), "diagnoses empty raw log");
assert(debugSrc.includes("REJECTED"), "diagnoses rejected requests");

console.log("\n" + "=".repeat(50));
console.log(`Raw logging tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some raw logging tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All raw logging tests passed!");
}
