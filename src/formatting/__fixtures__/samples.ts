/**
 * src/formatting/__fixtures__/samples.ts
 * -----------------------------------------------------------------------------
 * Test fixtures for the formatter pipeline + cleaner.
 *
 * Used by `src/formatting/self-test.ts` (the `/test` command) to verify that
 * the markdown→blocks→HTML rendering and the content cleaner behave the way
 * the rest of the codebase expects. These are PURE DATA — no I/O, no env, so
 * the self-test can run anywhere (Worker, local node, CI) without booting a
 * real D1/KV/Telegram stack.
 *
 * Each fixture is intentionally small and focused on ONE feature so a
 * regression points straight at the broken rule.
 * -----------------------------------------------------------------------------
 */

// ============================================================
// Formatter samples — run markdownToBlocks → blocksToTelegramHtml
// ============================================================

export interface FormatterSample {
  name: string;
  input: string;
  expectedContains: string[];
  expectedNotContains: string[];
}

export const FORMATTER_SAMPLES: FormatterSample[] = [
  {
    name: "basic-bold",
    input: "**hello**",
    expectedContains: ["<b>hello</b>"],
    expectedNotContains: ["**hello**"],
  },
  {
    name: "nested-bold-italic",
    input: "**bold *and italic***",
    expectedContains: ["<b>bold <i>and italic</i></b>"],
    expectedNotContains: ["**", "*and italic***"],
  },
  {
    name: "code-block",
    input: "```ts\nconst x = 1;\n```",
    expectedContains: ['<pre><code class="language-ts">const x = 1;</code></pre>'],
    expectedNotContains: ["```ts"],
  },
  {
    name: "link",
    input: "[text](https://x.com)",
    expectedContains: ['<a href="https://x.com">text</a>'],
    expectedNotContains: ["[text]"],
  },
  {
    name: "spoiler",
    input: "||secret||",
    expectedContains: ['<span class="tg-spoiler">secret</span>'],
    expectedNotContains: ["||secret||"],
  },
  {
    name: "strikethrough",
    input: "~~old~~",
    expectedContains: ["<s>old</s>"],
    expectedNotContains: ["~~old~~"],
  },
  {
    name: "underline",
    input: "__under__",
    expectedContains: ["<u>under</u>"],
    expectedNotContains: ["__under__"],
  },
  {
    name: "mention",
    input: "Ping @ILIVIR3 please",
    expectedContains: ['<a href="t.me/ILIVIR3">@ILIVIR3</a>'],
    expectedNotContains: [],
  },
  {
    name: "persian-with-emoji",
    input: "📦 نصب",
    expectedContains: ["📦 نصب"],
    expectedNotContains: [],
  },
  {
    name: "mixed-all",
    input:
      "📦 **نصب** سریع با `npm i` و [مستندات](https://x.com) — ||اختصاصی||",
    expectedContains: [
      "<b>نصب</b>",
      "<code>npm i</code>",
      '<a href="https://x.com">مستندات</a>',
      '<span class="tg-spoiler">اختصاصی</span>',
      "📦",
    ],
    expectedNotContains: ["**", "||", "[مستندات]"],
  },
];

// ============================================================
// Cleaner samples — run cleanContent
// ============================================================

export interface CleanerSample {
  name: string;
  input: string;
  expectedContains: string[];
  expectedNotContains: string[];
  /** Optional custom predicate for cases where string checks aren't enough. */
  check?: (output: string) => string | null; // returns reason on failure, null on pass
}

export const CLEANER_SAMPLES: CleanerSample[] = [
  {
    name: "promo-link-removed",
    input: "Check this out https://t.me/joinchat/xxx and more text",
    expectedContains: ["Check this out", "and more text"],
    expectedNotContains: ["t.me/joinchat/xxx", "joinchat"],
  },
  {
    name: "github-preserved",
    input: "See https://github.com/owner/repo for details",
    expectedContains: ["https://github.com/owner/repo"],
    expectedNotContains: [],
  },
  {
    name: "attribution-removed",
    input: "Awesome post via @spam_user",
    expectedContains: ["Awesome post"],
    expectedNotContains: ["via @spam_user", "spam_user"],
  },
  {
    name: "spam-hashtag-collapse",
    input: "#a #b #c #d #e #f #g content here",
    expectedContains: [],
    expectedNotContains: [],
    check: (output) => {
      const tags = output.match(/#[A-Za-z0-9_]+/g) || [];
      if (tags.length > 2) {
        return `expected ≤ 2 hashtags, got ${tags.length}: ${tags.join(" ")}`;
      }
      if (!output.includes("content here")) {
        return `expected content to survive; got: ${output}`;
      }
      return null;
    },
  },
  {
    name: "code-block-preserved",
    input: "Intro\n```\ncode line\n```\nOutro",
    expectedContains: ["```\ncode line\n```", "Intro", "Outro"],
    expectedNotContains: [],
  },
];
