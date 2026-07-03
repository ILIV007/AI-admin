/**
 * scripts/test-media-group.mjs
 * Verify media group handling, reply chain context, and AI integration.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const indexSrc = readFileSync(resolve(process.cwd(), "src/index.js"), "utf8");
const kvSrc = readFileSync(resolve(process.cwd(), "src/kv.js"), "utf8");
const tgSrc = readFileSync(resolve(process.cwd(), "src/telegram.js"), "utf8");
const aiSrc = readFileSync(resolve(process.cwd(), "src/ai.js"), "utf8");
const wranglerSrc = readFileSync(resolve(process.cwd(), "wrangler.toml"), "utf8");

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

console.log("\n🧪 Media Group + AI + Reply Chain\n");

// 1. wrangler.toml has models
console.log("wrangler.toml models:");
assert(wranglerSrc.includes("GEMINI_MODEL"), "GEMINI_MODEL in wrangler.toml");
assert(wranglerSrc.includes("OPENROUTER_MODEL"), "OPENROUTER_MODEL in wrangler.toml");
assert(wranglerSrc.includes("gemini-2.0-flash"), "GEMINI_MODEL defaults to gemini-2.0-flash");
assert(wranglerSrc.includes("nvidia/nemotron-3-ultra-550b-a55b:free"), "OPENROUTER_MODEL is nvidia/nemotron");
assert(wranglerSrc.includes("DEFAULT_AI_PROVIDER"), "DEFAULT_AI_PROVIDER in wrangler.toml");
assert(wranglerSrc.includes('"openrouter"'), "DEFAULT_AI_PROVIDER is openrouter");

// 2. KV defaults
console.log("\nKV defaults:");
assert(kvSrc.includes('ai_provider: "openrouter"'), "default ai_provider is openrouter");

// 3. KV media group helpers (v0.1.9: per-item keys + list())
console.log("\nKV media group helpers:");
assert(kvSrc.includes("saveMediaGroupItem"), "saveMediaGroupItem function exists (per-item key)");
assert(kvSrc.includes("listMediaGroupItems"), "listMediaGroupItems function exists (prefix scan)");
assert(kvSrc.includes("deleteMediaGroup"), "deleteMediaGroup function exists");
assert(kvSrc.includes("MG_PREFIX"), "MG_PREFIX constant exists");
assert(kvSrc.includes("MG_KEY"), "MG_KEY constant exists");
assert(kvSrc.includes("expirationTtl: 120"), "media group entries have 120s TTL");
assert(kvSrc.includes("RACE CONDITION FIX"), "has comment about race condition fix");
assert(!kvSrc.includes("getMediaGroup("), "old getMediaGroup (single-key) removed");

// 4. Telegram sendMediaGroup
console.log("\nTelegram sendMediaGroup:");
assert(tgSrc.includes("export async function sendMediaGroup"), "sendMediaGroup exported");
assert(tgSrc.includes("sendMediaGroup"), "sendMediaGroup function exists");

// 5. extractContent has mediaGroupId and replyToMessage
console.log("\nextractContent fields:");
assert(tgSrc.includes("mediaGroupId"), "extractContent captures mediaGroupId");
assert(tgSrc.includes("replyToMessage"), "extractContent captures replyToMessage");

// 6. AI defaults
console.log("\nAI defaults:");
assert(aiSrc.includes("nvidia/nemotron-3-ultra-550b-a55b:free"), "OpenRouter default model is nvidia/nemotron");

// 7. Media group handler in index.js (v0.1.9: leader election)
console.log("\nMedia group handler (leader election):");
assert(indexSrc.includes("handleMediaGroupUpdate"), "handleMediaGroupUpdate function exists");
assert(indexSrc.includes("runMediaGroupPipeline"), "runMediaGroupPipeline function exists");
assert(indexSrc.includes("MEDIA_GROUP_WAIT_MS"), "MEDIA_GROUP_WAIT_MS constant exists");
assert(indexSrc.includes("2_500") || indexSrc.includes("2500"), "wait time is 2.5s (increased from 1.5s)");
assert(indexSrc.includes("LEADER ELECTION"), "has leader election comment");
assert(indexSrc.includes("leader.messageId !== content.messageId"), "defers to leader");
assert(indexSrc.includes("I am the LEADER"), "leader processes the group");
assert(indexSrc.includes("saveMediaGroupItem"), "saves per-item to KV");
assert(indexSrc.includes("listMediaGroupItems"), "lists all items via prefix scan");

// 9. Reply chain handling
console.log("\nReply chain handling:");
assert(indexSrc.includes("replyToMessage"), "checks replyToMessage");
assert(indexSrc.includes("replyContext"), "builds replyContext");
assert(indexSrc.includes("Original message being replied to"), "includes original message context");
assert(indexSrc.includes("textForAI"), "passes reply context to AI");
assert(indexSrc.includes("reply_context"), "traces reply_context step");

// 10. Media group dispatch in handleUpdate
console.log("\nMedia group dispatch:");
assert(indexSrc.includes("if (content.mediaGroupId)"), "checks mediaGroupId in handleUpdate");
assert(indexSrc.includes("handleMediaGroupUpdate(env, content, update)"), "dispatches to media group handler");

console.log("\n" + "=".repeat(50));
console.log(`Media group tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some media group tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All media group tests passed!");
}
