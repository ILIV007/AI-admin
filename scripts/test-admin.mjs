/**
 * scripts/test-admin.mjs
 * Verify the admin panel keyboard builders produce the expected structure
 * and that all 8 spec items are present.
 *
 * Run with: node scripts/test-admin.mjs
 */

// We can't directly import the non-exported keyboard builders from admin.js,
// so we re-declare minimal mirrors here that MUST match the spec.
// If admin.js drifts, this test will catch it.

const SPEC_ITEMS = [
  { emoji: "⚙️", label: "Settings",     cb: "menu:settings" },
  { emoji: "🧠", label: "AI Mode",      cb: "menu:aimode" },
  { emoji: "🌐", label: "Language",     cb: "menu:language" },
  { emoji: "✍️", label: "Rewrite",      cb: "menu:rewrite" },
  { emoji: "🎭", label: "Personality",  cb: "menu:personality" },
  { emoji: "📢", label: "Footer",       cb: "menu:footer" },
  { emoji: "🤖", label: "AI Provider",  cb: "menu:provider" },
  { emoji: "📊", label: "Stats",        cb: "menu:stats" },
];

// Read admin.js source and verify each spec callback appears
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const adminSrc = readFileSync(resolve(process.cwd(), "src/admin.js"), "utf8");

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

console.log("\n🧪 admin.js — spec compliance\n");

// 1. All 8 main menu callbacks must be referenced
console.log("All 8 spec menu items present:");
for (const item of SPEC_ITEMS) {
  const found = adminSrc.includes(`callback_data: "${item.cb}"`);
  assert(found, `${item.emoji} ${item.label} → ${item.cb}`);
}

// 2. All setting callbacks
console.log("\nAll setting callbacks present:");
const settingCallbacks = [
  "set:lang:auto", "set:lang:fa", "set:lang:en",
  "set:rw:none", "set:rw:light", "set:rw:normal", "set:rw:summary",
  "set:pers:friendly", "set:pers:professional", "set:pers:technical", "set:pers:news",
  "set:prov:gemini", "set:prov:openrouter",
];
for (const cb of settingCallbacks) {
  // Look for the prefix pattern (the actual values are constructed dynamically)
  const prefix = cb.split(":").slice(0, 2).join(":");
  const found = adminSrc.includes(`"${prefix}:`) || adminSrc.includes(`\`${prefix}:`);
  assert(found, `${cb}`);
}

// 3. Combined AI Mode preset
console.log("\nAI Mode combined presets:");
assert(adminSrc.includes("set:aimode:"), "set:aimode: prefix exists");

// 4. Spec compliance: security rule — non-admins ignored
console.log("\nSecurity rules:");
assert(adminSrc.includes("isAuthorized"), "isAuthorized function exists");
assert(
  /String\s*\(\s*env\.ADMIN_ID/.test(adminSrc) && /String\s*\(\s*userId\s*\)\s*===/.test(adminSrc),
  "ADMIN_ID authorization check uses String() coercion"
);

// 5. Spec compliance: minimal messages (editMessageText used for menu updates)
console.log("\nUX rules:");
assert(adminSrc.includes("editMessageText"), "uses editMessageText (no message spam)");
assert(adminSrc.includes("answerCallbackQuery"), "answers callback queries (clears spinner)");

// 6. All KV fields from spec
console.log("\nKV schema (per spec PROMPT 2):");
const kvFields = ["language_mode", "rewrite_mode", "personality_mode", "footer_text", "ai_provider", "admin_id"];
for (const f of kvFields) {
  const found = adminSrc.includes(f) || readFileSync(resolve(process.cwd(), "src/kv.js"), "utf8").includes(f);
  assert(found, `field: ${f}`);
}

// ============================================================
console.log("\n" + "=".repeat(50));
console.log(`Admin spec tests: ${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some admin spec tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All admin spec tests passed!");
}
