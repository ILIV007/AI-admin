/**
 * scripts/test-units.mjs
 * Quick unit tests for cleaner, classifier, formatter.
 * Run with: node scripts/test-units.mjs
 *
 * No external deps — just Node 18+ built-ins.
 */

import { cleanContent, detectLanguage, contentStats } from "../src/cleaner.js";
import { ruleBasedClassify } from "../src/classifier.js";
import { formatPost, extractUrls, getEngine } from "../src/formatter.js";

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
// TEST: cleaner
// ============================================================
console.log("\n🧪 cleaner.js");

{
  const input = "Check this out!\n\nvia @someChannel\nJoin @mychannel for more!";
  const out = cleanContent(input);
  assert(!out.includes("via @someChannel"), "removes 'via @channel' attribution");
  assert(!out.toLowerCase().includes("join @mychannel"), "removes 'join @channel' promo");
  assert(out.includes("Check this out!"), "preserves real content");
}

{
  const input = "Great repo: https://github.com/user/repo\n\n#ai #ml #news #tech #python #coding #dev";
  const out = cleanContent(input);
  assert(out.includes("github.com/user/repo"), "preserves GitHub URL");
  assert(!out.includes("#dev"), "removes spam hashtags beyond 2");
}

{
  const input = "Tutorial:\n```\nconst x = 1;\n```\n@DevTwitter | John Doe";
  const out = cleanContent(input);
  assert(out.includes("const x = 1;"), "preserves code block");
  assert(!out.toLowerCase().includes("devtwitter"), "removes attribution signature");
}

{
  const input = "Normal post without any spam. Just text.";
  const out = cleanContent(input);
  assert(out === input, "idempotent on clean text");
}

{
  // Regression: hashtag block must NOT eat the trailing newline
  // (otherwise the next line gets glued onto the hashtags)
  const input = "JOIN NOW!!!\n#ai #ml #news #tech #python #coding #dev\nBuy now";
  const out = cleanContent(input);
  assert(!out.includes("#ai #mlBuy now"), "hashtag block preserves trailing newline");
  assert(out.includes("Buy now"), "next line is preserved");
}

{
  // CRITICAL regression: attribution line mid-text must NOT delete content after it
  // (previous regex [^]*$ would consume Everything to end of string — data loss bug)
  const input = "Important intro\n@DevTwitter | John Doe\nThis content must survive!";
  const out = cleanContent(input);
  assert(out.includes("This content must survive!"), "content after attribution line is preserved (no data loss)");
  assert(out.includes("Important intro"), "content before attribution is preserved");
  assert(!out.toLowerCase().includes("devtwitter"), "attribution itself is removed");
}

{
  // Regression: dash-style attribution "@user — Author" also removed
  const input = "News content here\n@someuser — John Doe\nMore content";
  const out = cleanContent(input);
  assert(out.includes("More content"), "content after dash-attribution preserved");
  assert(out.includes("News content here"), "content before dash-attribution preserved");
}

// ============================================================
// TEST: classifier
// ============================================================
console.log("\n🧪 classifier.js (rule-based)");

{
  const text = "https://github.com/user/repo\nhttps://github.com/user/repo2\nhttps://github.com/user/repo3";
  const d = ruleBasedClassify(text);
  assert(d.content_type === "list_resources", "list of links → list_resources");
  assert(d.rewrite_mode === "none", "list of links → no rewrite");
  assert(d.needs_rewrite === false, "list of links → needs_rewrite=false");
}

{
  const text = "Check out this new GitHub repo: https://github.com/user/repo It does X, Y, Z.";
  const d = ruleBasedClassify(text);
  assert(d.content_type === "github_repo", "github link → github_repo");
  assert(d.rewrite_mode === "light", "github_repo → light edit");
}

{
  // ~600 words = "long article" territory (>500 words threshold)
  const longText = "This is a long-form news article about something interesting. ".repeat(120);
  const d = ruleBasedClassify(longText);
  assert(d.rewrite_mode === "summary", `long text (>${longText.split(/\s+/).length} words) → summary, got ${d.rewrite_mode}`);
}

// ============================================================
// TEST: formatter
// ============================================================
console.log("\n🧪 formatter.js");

{
  const input = "Check this repo:\nhttps://github.com/user/repo";
  const { text, parseMode } = formatPost(input, { footer: "🌀 @ILIVIR3" });
  assert(parseMode === "HTML", "default engine is HTML");
  // URLs should be clickable links with shortened labels (not blockquoted)
  assert(text.includes('<a href="https://github.com/user/repo">github.com/user/repo</a>'), "wraps URL in <a> tag with shortened label");
  assert(text.includes("<blockquote>🌀 @ILIVIR3</blockquote>"), "appends footer as blockquote");
}

{
  const input = "Multi link post\nhttps://a.com\nhttps://b.com";
  const { text } = formatPost(input, { footer: "🌀 @ILIVIR3" });
  // Both URLs should be clickable links, footer should be blockquote
  const linkCount = (text.match(/<a href=/g) || []).length;
  const blockquoteCount = (text.match(/<blockquote>/g) || []).length;
  assert(linkCount === 2, `2 links expected, got ${linkCount}`);
  assert(blockquoteCount === 1, `1 blockquote expected (footer only), got ${blockquoteCount}`);
}

{
  const input = "Code: `const x = 1;`";
  const { text } = formatPost(input, {});
  assert(text.includes("<code>const x = 1;</code>"), "inline code → <code>");
}

{
  const input = "Bold: **important**";
  const { text } = formatPost(input, {});
  assert(text.includes("<b>important</b>"), "double asterisk → <b>");
}

{
  const input = "URL with params: https://example.com/path?a=1&b=2";
  const urls = extractUrls(input);
  assert(urls.length === 1, "extractUrls finds 1 URL");
  assert(urls[0] === "https://example.com/path?a=1&b=2", "extracts full URL with query");
}

{
  // Test plain engine
  const { text, parseMode } = formatPost("hello https://x.com", { footer: "F", engineName: "plain" });
  assert(parseMode === null, "plain engine → null parseMode");
  assert(!text.includes("<blockquote>"), "plain engine → no blockquote tags");
}

{
  // Test richmarkdown engine (placeholder — uses <a> tags for links, blockquote for footer)
  const { text, parseMode } = formatPost("hello https://x.com", { footer: "F", engineName: "richmarkdown" });
  assert(parseMode === "HTML", "richmarkdown engine uses HTML parseMode (placeholder)");
  assert(text.includes('<a href="https://x.com">x.com</a>'), "richmarkdown engine uses <a> tag for URL");
  assert(text.includes("<blockquote>F</blockquote>"), "richmarkdown engine wraps footer in blockquote");
}

// ============================================================
// TEST: language detection
// ============================================================
console.log("\n🧪 language detection");

assert(detectLanguage("سلام این یک متن فارسی است") === "fa", "detects Persian");
assert(detectLanguage("Hello this is an English text") === "en", "detects English");
assert(detectLanguage("") === "en", "empty → default en");

// ============================================================
// SUMMARY
// ============================================================
console.log("\n" + "=".repeat(50));
console.log(`Passed: ${passed} | Failed: ${failed}`);
console.log("=".repeat(50));

if (failed > 0) {
  console.error("\n❌ Some tests failed!");
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
}
