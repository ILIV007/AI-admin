/**
 * scripts/test-debug-html.mjs
 * Verify the debugHTML() function returns valid, complete HTML.
 * Run with: node scripts/test-debug-html.mjs
 */

import { debugHTML } from "../src/debug.js";

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

console.log("\n🧪 debugHTML() — output validation\n");

const html = debugHTML();

// Basic structure
assert(typeof html === "string", "returns a string");
assert(html.length > 5000, `HTML is substantial (${html.length} chars)`);
assert(html.startsWith("<!DOCTYPE html>"), "starts with DOCTYPE");
assert(html.includes("</html>"), "ends with </html>");

// Required sections
assert(html.includes("AI Admin"), "contains project name");
assert(html.includes("Debug Dashboard"), "contains 'Debug Dashboard' title");
assert(html.includes("Status Overview"), "has Status Overview section");
assert(html.includes("Quick Actions"), "has Quick Actions section");
assert(html.includes("Recent Updates"), "has Recent Updates section");
assert(html.includes("Recent Errors"), "has Recent Errors section");
assert(html.includes("Bot Info"), "has Bot Info section");
assert(html.includes("Webhook Info"), "has Webhook Info section");

// API endpoints referenced
assert(html.includes("/debug/api/status"), "calls /debug/api/status");
assert(html.includes("/debug/api/test/"), "references test API endpoint");
assert(html.includes("/debug/api/clear"), "calls /debug/api/clear");

// JavaScript functionality
assert(html.includes("loadStatus()"), "has loadStatus function");
assert(html.includes("runTest("), "has runTest function");
assert(html.includes("clearLogs()"), "has clearLogs function");
assert(html.includes("setInterval(loadStatus"), "auto-refreshs status");

// CSS styling (dark theme)
assert(html.includes("<style>"), "has inline CSS");
assert(html.includes("background: #0d1117") || html.includes("#0d1117"), "has dark theme background");
assert(html.includes(".card"), "has card class");

// Responsive design
assert(html.includes("viewport"), "has viewport meta tag");
assert(html.includes("grid-template-columns"), "uses CSS grid");

// Security note
assert(html.includes("status-fail") || html.includes("status-ok"), "has status indicators");

// No broken template literals
const backtickCount = (html.match(/`/g) || []).length;
assert(backtickCount === 0, `no stray backticks in output (found ${backtickCount})`);

// ============================================================
console.log("\n" + "=".repeat(50));
console.log(`HTML tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some HTML tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All HTML tests passed!");
}
