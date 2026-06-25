/**
 * scripts/test-pipeline-trace.mjs
 * Verify the pipeline trace logging works (each step records ok/fail + timing).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const indexSrc = readFileSync(resolve(process.cwd(), "src/index.js"), "utf8");

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

console.log("\n🧪 Pipeline Trace Logging\n");

// Check traceStep exists and is called for every pipeline stage
assert(indexSrc.includes("traceStep = (step, ok, detail"), "traceStep arrow function defined");
assert(indexSrc.includes("const trace = []"), "trace array initialized");

// Every pipeline stage should have a traceStep call
const stages = [
  "getSettings",
  "classify",
  "clean",
  "ai_summarize",
  "ai_rewrite",
  "ai_skip",
  "ai_exception",
  "format",
  "publish",
  "send_to_user",
  "send_to_user_retry",
  "publish_to_channel",
];
for (const stage of stages) {
  assert(indexSrc.includes(`traceStep("${stage}"`), `traceStep called for "${stage}" stage`);
}

// Trace summary is logged
assert(indexSrc.includes("trace.map"), "trace summary is computed");
assert(indexSrc.includes("[pipeline trace summary]"), "trace summary is console.logged");

// AI error tracking
assert(indexSrc.includes("aiError"), "tracks aiError variable");
assert(indexSrc.includes("aiProvider"), "tracks aiProvider variable");
assert(indexSrc.includes("AI failed"), "status message shows AI failure");
assert(indexSrc.includes("format-only fallback"), "mentions format-only fallback when AI fails");

// Processing message gets EDITED (not a new message) on success
assert(indexSrc.includes("editMessageText(env.BOT_TOKEN, feedbackChatId, processingMsgId"), "edits processing message with final status");
assert(indexSrc.includes("processingMsgId"), "tracks processingMsgId");

// Plain-text retry on HTML parse error
assert(indexSrc.includes("HTML parse error"), "detects HTML parse errors");
assert(indexSrc.includes("retrying user send with plain text"), "retries with plain text on parse failure");
assert(indexSrc.includes("escapeHtmlForTg"), "has escapeHtmlForTg helper for safe error display");

// Processing message UI uses blockquotes
assert(indexSrc.includes("<blockquote>🔄 Analyzing"), "processing UI uses blockquotes for steps");
assert(indexSrc.includes("<blockquote>🧹 Cleaning"), "processing UI shows cleaning step");
assert(indexSrc.includes("<blockquote>✍️ AI rewrite"), "processing UI shows AI rewrite step");
assert(indexSrc.includes("<blockquote>📝 Formatting"), "processing UI shows formatting step");

// Stats are bumped
assert(indexSrc.includes('bumpStats(SETTINGS, adminId, "processed")'), "bumps processed stats on success");
assert(indexSrc.includes('bumpStats(SETTINGS, adminId, "failed")'), "bumps failed stats on failure");

console.log("\n" + "=".repeat(50));
console.log(`Pipeline trace tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some pipeline trace tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All pipeline trace tests passed!");
}
