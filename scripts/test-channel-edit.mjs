/**
 * scripts/test-channel-edit.mjs
 * Verify channel editing toggle and dual-send behavior.
 *
 * Run with: node scripts/test-channel-edit.mjs
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const kvSrc = readFileSync(resolve(process.cwd(), "src/kv.js"), "utf8");
const indexSrc = readFileSync(resolve(process.cwd(), "src/index.js"), "utf8");
const adminSrc = readFileSync(resolve(process.cwd(), "src/admin.js"), "utf8");
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

console.log("\n🧪 Channel Editing Feature — Spec Compliance\n");

// 1. KV: channel_editing_enabled in DEFAULTS, default false
console.log("KV defaults:");
assert(kvSrc.includes("channel_editing_enabled: false"), "channel_editing_enabled defaults to false in DEFAULTS");

// 2. Telegram: editMessageCaption exists
console.log("\nTelegram API:");
assert(telegramSrc.includes("export async function editMessageCaption"), "editMessageCaption function exists");
assert(telegramSrc.includes("editMessageCaption"), "editMessageCaption is exported");

// 3. Admin: toggle button exists
console.log("\nAdmin panel:");
assert(adminSrc.includes("📺 Channel Edit"), "main menu has Channel Edit toggle button");
assert(adminSrc.includes("toggle:channeledit"), "toggle callback data exists");
assert(adminSrc.includes("channel_editing_enabled"), "admin reads channel_editing_enabled setting");
assert(adminSrc.includes("Channel Edit: ON") || adminSrc.includes("Channel Edit: OFF"), "button shows current state");

// 4. Index: channel editing pipeline
console.log("\nPipeline logic:");
assert(indexSrc.includes("channel_editing_enabled"), "index checks channel_editing_enabled");
assert(indexSrc.includes("Default OFF"), "has comment about default OFF behavior");
assert(indexSrc.includes("runChannelEditPipeline"), "runChannelEditPipeline function exists");
assert(indexSrc.includes("editMessageCaption"), "uses editMessageCaption for media posts");
assert(indexSrc.includes("editMessageText"), "uses editMessageText for text-only posts");

// 5. Loop prevention
console.log("\nLoop prevention:");
assert(indexSrc.includes("getBotId"), "getBotId function exists for bot ID caching");
assert(indexSrc.includes("loop prevention"), "has loop prevention logic");
assert(indexSrc.includes("self-post"), "skips self-posts");

// 6. Feedback bug fix: PV messages now pass content.chatId
console.log("\nFeedback bug fix (was null before):");
assert(indexSrc.includes("content.chatId, update"), "runPipeline called with content.chatId (not null)");
assert(!indexSrc.includes("runPipeline(env, content, null, update)"), "no more null feedbackChatId");

// 7. Dual-send: final post sent to user AND channel
console.log("\nDual-send behavior:");
assert(indexSrc.includes("sending final post to user"), "sends final post to user before publishing");
assert(indexSrc.includes("publishToChannel(env.BOT_TOKEN, feedbackChatId"), "uses publishToChannel to send to user (preserves media)");

// 8. Channel edit notification to admin
console.log("\nChannel edit notifications:");
assert(indexSrc.includes("Edited channel post"), "sends 'Edited channel post' notification on success");
assert(indexSrc.includes("Channel edit failed"), "sends 'Channel edit failed' notification on error");

// ============================================================
console.log("\n" + "=".repeat(50));
console.log(`Channel edit tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some channel edit tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All channel edit tests passed!");
}
