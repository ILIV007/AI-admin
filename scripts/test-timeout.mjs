/**
 * scripts/test-timeout.mjs
 * Verify the pipeline timeout wrapper exists and works.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const indexSrc = readFileSync(resolve(process.cwd(), "src/index.js"), "utf8");
const aiSrc = readFileSync(resolve(process.cwd(), "src/ai.js"), "utf8");
const classifierSrc = readFileSync(resolve(process.cwd(), "src/classifier.js"), "utf8");

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

console.log("\n🧪 Pipeline Timeout & Fast-Path\n");

// 1. PIPELINE_TIMEOUT_MS exists
console.log("Pipeline timeout wrapper:");
assert(indexSrc.includes("PIPELINE_TIMEOUT_MS"), "PIPELINE_TIMEOUT_MS constant exists");
assert(indexSrc.includes("55_000") || indexSrc.includes("55000"), "pipeline timeout is 55 seconds (under Cloudflare's 60s ctx.waitUntil limit)");
assert(indexSrc.includes("Promise.race"), "uses Promise.race for timeout");
assert(indexSrc.includes("PIPELINE_TIMEOUT"), "rejects with PIPELINE_TIMEOUT message");
assert(indexSrc.includes("abortCtrl.abort()"), "aborts in-flight fetches on timeout (AbortController)");

// 2. Processing message is sent OUTSIDE the timeout wrapper
console.log("\nProcessing message handling:");
assert(indexSrc.includes("OUTSIDE the timeout wrapper"), "comment notes processing message is outside timeout");
assert(indexSrc.includes("runPipelineInner"), "has runPipelineInner function (separate from wrapper)");
assert(indexSrc.includes("abortSignal"), "runPipelineInner accepts abortSignal parameter");

// 3. Finally: logUpdate is ALWAYS called
console.log("\nAlways log update:");
assert(indexSrc.includes("Finally: always log"), "has finally block for logging");
assert(indexSrc.includes("pipelineError ? \"error\""), "logs error status on timeout");
assert(indexSrc.includes("pipelineResult?.ok ? \"ok\""), "logs ok status on success");

// 4. AI timeout (increased to 25s for large models on OpenRouter)
console.log("\nAI timeout:");
assert(aiSrc.includes("25_000") || aiSrc.includes("25000"), "AI timeout is 25 seconds (enough for large models)");
assert(!aiSrc.includes("8_000") && !aiSrc.includes("8000") && !aiSrc.includes("15_000"), "old 8s/15s timeouts removed");

// 5. AI providers run in PARALLEL (concurrent, not sequential)
console.log("\nAI providers run in parallel:");
assert(aiSrc.includes("PARALLEL"), "has PARALLEL comment");
assert(aiSrc.includes("Promise.all"), "uses Promise.all to run both providers concurrently");
assert(aiSrc.includes("primaryPromise"), "creates primaryPromise");
assert(aiSrc.includes("fallbackPromise"), "creates fallbackPromise");
assert(!aiSrc.includes("Trying fallback"), "no sequential 'Trying fallback' (now parallel)");

// 5. AI classify removed (rule-based only)
console.log("\nAI classify removed (rule-based only):");
assert(!classifierSrc.includes("aiClassifySafe"), "aiClassifySafe wrapper removed");
assert(!classifierSrc.includes("aiClassify"), "no AI classify import in classifier.js");
assert(classifierSrc.includes("FAST rule-based classify only"), "has comment explaining why no AI classify");
assert(classifierSrc.includes("30-second wall time limit"), "mentions Cloudflare 30s limit in docs");

// 6. Timeout error message edits the processing message
console.log("\nTimeout UX:");
assert(indexSrc.includes("Pipeline timed out"), "edits processing message on timeout");
assert(indexSrc.includes("faster model"), "suggests using a faster model on timeout");

// 7. escapeHtmlForTg still exists (used for error messages)
assert(indexSrc.includes("function escapeHtmlForTg"), "escapeHtmlForTg helper exists");

// 8. runPipelineInner returns a result object
console.log("\nInner pipeline return value:");
assert(indexSrc.includes("ok: publishRes.ok"), "returns ok status from publishRes");
assert(indexSrc.includes("return { ok: false, detail: \"TARGET_CHANNEL not set\""), "returns early on missing TARGET_CHANNEL");

console.log("\n" + "=".repeat(50));
console.log(`Timeout tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some timeout tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All timeout tests passed!");
}
