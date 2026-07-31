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
  {
    // Regression test for DEBUG-A Bug 1: a markdown link whose URL contains a
    // literal `%` followed by non-hex chars (e.g. `50%off`) must NOT crash
    // decodeURIComponent. The link should render as a normal <a> tag.
    name: "link-with-percent-in-url",
    input: "[50% off](https://shop.example.com/50%off)",
    expectedContains: ['<a href="https://shop.example.com/50%off">50% off</a>'],
    expectedNotContains: [],
  },
  {
    // Regression test for DEBUG-A Bug 7: mention href must include the
    // https:// protocol so Telegram renders it as a clickable link.
    name: "mention-with-protocol",
    input: "Ping @ILIVIR3 please",
    expectedContains: ['<a href="https://t.me/ILIVIR3">@ILIVIR3</a>'],
    expectedNotContains: ['href="t.me/'],
  },
  {
    // Regression test: prompt blocks use <blockquote expandable><code>
    // (collapsible + monospace, NO <pre> — user requested mono only).
    name: "prompt-block-mono",
    input: "```prompt\nline one\nline two\n```",
    expectedContains: ["<blockquote expandable><code>"],
    expectedNotContains: ["<pre>"],
  },
  {
    // Regression test for P2-6: backslash escape renders literal chars.
    name: "backslash-escape",
    input: "\\*not italic\\*",
    expectedContains: ["*not italic*"],
    expectedNotContains: ["<i>"],
  },
  {
    // Regression test: colon→blockquote now ONLY fires for URLs and markdown
    // links, NOT for regular prose. Regular text after ":" should NOT be quoted
    // (the AI should use explicit > markdown for genuine quotes).
    name: "colon-autoquote-prose",
    input: "Here are the steps:\n\nFirst, clone the repository.",
    expectedContains: ["First, clone"],
    expectedNotContains: ["<blockquote>First, clone"],
  },
  {
    // Regression test for P1-4: colon→blockquote DOES fire for bare URLs.
    name: "colon-autoquote-url",
    input: "See the docs:\n\nhttps://example.com/docs",
    expectedContains: ["<blockquote>"],
    expectedNotContains: [],
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

// ============================================================
// Prompt protection samples — run protectPrompts → restorePrompts
// (imported lazily by self-test to avoid a circular dep in this file)
// ============================================================

export interface PromptSample {
  name: string;
  input: string;
  expectedContains: string[];
  expectedNotContains: string[];
}

export const PROMPT_SAMPLES: PromptSample[] = [
  {
    name: "prompt-label-preserved",
    // A paragraph starting with "prompt:" must be detected as a prompt,
    // wrapped in a ```prompt fence, and the "prompt:" label MUST be kept
    // (not stripped) in the restored output.
    input:
      "Here is a nice image prompt:\n\n" +
      "prompt: a beautiful mountain landscape, cinematic lighting, highly detailed, 8k, --ar 16:9 --v 6",
    expectedContains: [
      "```prompt",
      "prompt: a beautiful mountain landscape",
      "--ar 16:9",
      "--v 6",
    ],
    expectedNotContains: [],
  },
  {
    name: "negative-prompt-label-preserved",
    input:
      "Negative prompt: blurry, low quality, distorted face, extra fingers\n\n" +
      "prompt: portrait of a woman, photorealistic, soft lighting",
    expectedContains: [
      "```prompt",
      "Negative prompt: blurry, low quality, distorted face",
      "prompt: portrait of a woman",
    ],
    expectedNotContains: [],
  },
];
