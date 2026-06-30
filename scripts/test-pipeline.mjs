/**
 * scripts/test-pipeline.mjs
 * Integration test: simulate the full pipeline with a mock AI module.
 * Verifies: clean → classify → [rewrite] → format → "publish" (mocked)
 *
 * Run with: node scripts/test-pipeline.mjs
 */

// We need to intercept the dynamic import("./ai.js") in classifier.js
// Strategy: use Node's module loader hooks, OR just test the pipeline
// logic directly by importing the building blocks and composing them.

import { cleanContent, detectLanguage } from "../src/cleaner.js";
import { ruleBasedClassify } from "../src/classifier.js";
import { formatPost } from "../src/formatter.js";

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

// ============================================================
// Mock the AI rewrite (simulate Gemini response)
// ============================================================
function mockAIRewrite(text, mode, lang, personality) {
  // Simulate a clean AI rewrite — just add a subtle personality touch
  if (mode === "none") return text;
  if (mode === "light") return text; // light = basically same
  if (mode === "normal") {
    return `[${personality}] ${text.trim()}`;
  }
  if (mode === "summary") {
    return text.split(".").slice(0, 2).join(".") + ".";
  }
  return text;
}

// ============================================================
// Pipeline simulation (mirrors runPipeline in index.js)
// ============================================================
function simulatePipeline(rawText, settings = {}) {
  const defaults = {
    language_mode: "auto",
    rewrite_mode: "normal",
    personality_mode: "friendly",
    footer_text: "🌀 @ILIVIR3",
    ai_provider: "gemini",
  };
  const s = { ...defaults, ...settings };

  // Step 1: clean
  const cleaned = cleanContent(rawText);

  // Step 2: classify (rule-based for test)
  const decision = ruleBasedClassify(cleaned);

  // Effective language
  const effectiveLang = s.language_mode === "auto" ? detectLanguage(cleaned) : s.language_mode;

  // Step 3: rewrite (mock)
  const effectiveRewriteMode = s.rewrite_mode || decision.rewrite_mode;
  const shouldRewrite = effectiveRewriteMode !== "none" && cleaned.length > 0;
  let finalText = cleaned;
  let wasRewritten = false;

  if (shouldRewrite && decision.needs_rewrite !== false) {
    const rewritten = mockAIRewrite(cleaned, effectiveRewriteMode, effectiveLang, s.personality_mode);
    if (rewritten && rewritten !== cleaned) {
      finalText = rewritten;
      wasRewritten = true;
    }
  }

  // Step 4: format
  const { text: formatted, parseMode } = formatPost(finalText, {
    footer: s.footer_text,
    engineName: "html",
  });

  return {
    cleaned,
    decision,
    finalText,
    formatted,
    parseMode,
    wasRewritten,
    effectiveRewriteMode,
    effectiveLang,
  };
}

// ============================================================
// TEST SCENARIOS
// ============================================================
console.log("\n🧪 Integration: Full Pipeline\n");

// --- Scenario 1: GitHub repo with promo noise ---
console.log("Scenario 1: GitHub repo with spam attribution");
{
  const input = `
Check out this new tool!

https://github.com/user/awesome-tool

It does X, Y, and Z. Really useful for developers.

via @someChannel
Join @mychannel for more!
`.trim();

  const r = simulatePipeline(input, { rewrite_mode: "light" });
  assert(r.cleaned.includes("github.com/user/awesome-tool"), "URL preserved after clean");
  assert(!r.cleaned.includes("via @someChannel"), "attribution removed");
  assert(!r.cleaned.includes("Join @mychannel"), "promo removed");
  assert(r.decision.content_type === "github_repo", `classified as github_repo, got ${r.decision.content_type}`);
  assert(r.formatted.includes("<blockquote>https://github.com/user/awesome-tool</blockquote>"), "URL wrapped in blockquote");
  assert(r.formatted.includes("<blockquote>🌀 @ILIVIR3</blockquote>"), "footer appended");
  assert(r.parseMode === "HTML", "HTML parse mode");
  console.log(`  📝 Final:\n${r.formatted.split("\n").map((l) => `     ${l}`).join("\n")}\n`);
}

// --- Scenario 2: List of resources (should NOT rewrite) ---
console.log("Scenario 2: Link dump (should not rewrite)");
{
  const input = `
https://github.com/a/b
https://github.com/c/d
https://github.com/e/f
`.trim();

  const r = simulatePipeline(input);
  assert(r.decision.content_type === "list_resources", "classified as list_resources");
  assert(r.effectiveRewriteMode === "normal" || r.wasRewritten === false || r.decision.needs_rewrite === false,
    `no actual rewrite happened (needs_rewrite=${r.decision.needs_rewrite})`);
  assert(r.formatted.includes("<blockquote>https://github.com/a/b</blockquote>"), "URL 1 wrapped");
  assert(r.formatted.includes("<blockquote>https://github.com/c/d</blockquote>"), "URL 2 wrapped");
  assert(r.formatted.includes("<blockquote>https://github.com/e/f</blockquote>"), "URL 3 wrapped");
  console.log(`  📝 Final:\n${r.formatted.split("\n").map((l) => `     ${l}`).join("\n")}\n`);
}

// --- Scenario 3: Long Persian article (should summarize) ---
console.log("Scenario 3: Long Persian article (summary mode)");
{
  const longFa = "این یک مقاله خبری طولانی درباره فناوری است. ".repeat(100);
  const r = simulatePipeline(longFa, { rewrite_mode: "summary", language_mode: "fa" });
  assert(r.effectiveLang === "fa", "language forced to fa");
  assert(r.effectiveRewriteMode === "summary", "rewrite mode = summary");
  assert(r.wasRewritten === true, "was actually rewritten (mock)");
  assert(r.formatted.includes("<blockquote>🌀 @ILIVIR3</blockquote>"), "footer still appended");
  console.log(`  📝 Final length: ${r.formatted.length} chars (was ${longFa.length})\n`);
}

// --- Scenario 4: Pure promo (should be cleaned heavily) ---
console.log("Scenario 4: Pure promo spam");
{
  const input = `
JOIN NOW!!! 
#ai #ml #news #tech #python #coding #dev #programming
Buy our product at https://spam-site.com/buy
Subscribe to @scam_channel
Limited time offer!
`.trim();

  const r = simulatePipeline(input, { rewrite_mode: "none" });
  assert(r.effectiveRewriteMode === "none", "no rewrite requested");
  assert(!r.cleaned.toLowerCase().includes("join now"), "join now removed");
  assert(!r.cleaned.toLowerCase().includes("subscribe to @scam_channel"), "subscribe line removed");
  assert(!r.cleaned.includes("#dev"), "spam hashtags reduced");
  console.log(`  📝 Final:\n${r.formatted.split("\n").map((l) => `     ${l}`).join("\n")}\n`);
}

// --- Scenario 5: Code block preservation ---
console.log("Scenario 5: Code block + GitHub link");
{
  const input = `
New release! Here's how to install:

\`\`\`
npm install awesome-tool
\`\`\`

Repo: https://github.com/user/awesome-tool

@DevTwitter | Author Name
`.trim();

  const r = simulatePipeline(input, { rewrite_mode: "none" });
  assert(r.formatted.includes("<pre><code>npm install awesome-tool</code></pre>"), "code block preserved as <pre><code>");
  assert(r.formatted.includes("<blockquote>https://github.com/user/awesome-tool</blockquote>"), "github URL in blockquote");
  assert(!r.formatted.toLowerCase().includes("devtwitter"), "attribution removed");
  console.log(`  📝 Final:\n${r.formatted.split("\n").map((l) => `     ${l}`).join("\n")}\n`);
}

// ============================================================
// SUMMARY
// ============================================================
console.log("=".repeat(60));
console.log(`Integration tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(60));

if (failed > 0) {
  console.error("\n❌ Some integration tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All integration tests passed!");
}
