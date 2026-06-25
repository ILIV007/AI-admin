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

// 3. KV media group helpers
console.log("\nKV media group helpers:");
assert(kvSrc.includes("getMediaGroup"), "getMediaGroup function exists");
assert(kvSrc.includes("saveMediaGroup"), "saveMediaGroup function exists");
assert(kvSrc.includes("deleteMediaGroup"), "deleteMediaGroup function exists");
assert(kvSrc.includes("KEY_MEDIA_GROUP"), "KEY_MEDIA_GROUP constant exists");
assert(kvSrc.includes("expirationTtl: 60"), "media group entries have 60s TTL");

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

// 7. Media group handler in index.js
console.log("\nMedia group handler:");
assert(indexSrc.includes("handleMediaGroupUpdate"), "handleMediaGroupUpdate function exists");
assert(indexSrc.includes("runMediaGroupPipeline"), "runMediaGroupPipeline function exists");
assert(indexSrc.includes("MEDIA_GROUP_WAIT_MS"), "MEDIA_GROUP_WAIT_MS constant exists");
assert(indexSrc.includes("setTimeout(r, MEDIA_GROUP_WAIT_MS)"), "waits for group items to arrive");
assert(indexSrc.includes("media group detected"), "logs media group detection");

// 8. Media group processing
console.log("\nMedia group processing:");
assert(indexSrc.includes("combinedText"), "combines captions from all items");
assert(indexSrc.includes("[Photo"), "labels photos when multiple");
assert(indexSrc.includes("sendMediaGroup(env.BOT_TOKEN"), "uses sendMediaGroup for publishing");
assert(indexSrc.includes("caption: i === 0"), "only first item gets caption");

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
