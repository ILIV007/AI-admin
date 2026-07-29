/**
 * src/formatting/self-test.ts
 * -----------------------------------------------------------------------------
 * In-process self-tests for the formatter + cleaner pipelines.
 *
 * Pure functions only — no env, no D1, no KV, no Telegram. This module is
 * importable from anywhere (Worker fetch handler, queue consumer, local node
 * script, CI) without booting a real stack.
 *
 * The `/test` admin command (see `src/admin/commands.ts`) calls
 * `runFormatterSelfTests()` and replies with a Persian summary.
 *
 * Design:
 *   • Each sample runs through the same render path the bot actually uses:
 *         markdownToBlocks(md) → blocksToTelegramHtml(blocks, "")
 *     The footer is "" so we don't drag a footer block into every assertion.
 *   • Failures are recorded, never thrown — the caller always gets a summary.
 *   • Reasons are concrete ("expected to contain X, got Y") so a regression
 *     is debuggable from the bot reply alone.
 * -----------------------------------------------------------------------------
 */

import { cleanContent, protectPrompts, restorePrompts } from "../processing/cleaner";
import { markdownToBlocks } from "./blocks";
import { blocksToTelegramHtml } from "./telegram-html";
import {
  CLEANER_SAMPLES,
  FORMATTER_SAMPLES,
  PROMPT_SAMPLES,
} from "./__fixtures__/samples";

// ============================================================
// Public types
// ============================================================

export interface SelfTestFailure {
  name: string;
  reason: string;
}

export interface SelfTestSummary {
  passed: number;
  failed: number;
  failures: SelfTestFailure[];
}

// ============================================================
// runFormatterSelfTests
// ============================================================

/**
 * Run every FORMATTER_SAMPLES + CLEANER_SAMPLES case and return a summary.
 *
 * NEVER throws — every per-test error is caught and recorded as a failure.
 */
export function runFormatterSelfTests(): SelfTestSummary {
  const failures: SelfTestFailure[] = [];
  let passed = 0;
  let failed = 0;

  // --- Formatter samples ---
  for (const sample of FORMATTER_SAMPLES) {
    try {
      const blocks = markdownToBlocks(sample.input);
      const html = blocksToTelegramHtml(blocks, "");

      let reason: string | null = null;
      for (const needle of sample.expectedContains) {
        if (!html.includes(needle)) {
          reason =
            `expected to contain ${JSON.stringify(needle)}; got: ${truncate(html)}`;
          break;
        }
      }
      if (!reason) {
        for (const banned of sample.expectedNotContains) {
          if (html.includes(banned)) {
            reason =
              `expected NOT to contain ${JSON.stringify(banned)}; got: ${truncate(html)}`;
            break;
          }
        }
      }

      if (reason) {
        failed++;
        failures.push({ name: `formatter:${sample.name}`, reason });
      } else {
        passed++;
      }
    } catch (e) {
      failed++;
      failures.push({
        name: `formatter:${sample.name}`,
        reason: `threw: ${(e as Error).message ?? String(e)}`,
      });
    }
  }

  // --- Cleaner samples ---
  for (const sample of CLEANER_SAMPLES) {
    try {
      const output = cleanContent(sample.input);

      let reason: string | null = null;
      for (const needle of sample.expectedContains) {
        if (!output.includes(needle)) {
          reason =
            `expected to contain ${JSON.stringify(needle)}; got: ${truncate(output)}`;
          break;
        }
      }
      if (!reason) {
        for (const banned of sample.expectedNotContains) {
          if (output.includes(banned)) {
            reason =
              `expected NOT to contain ${JSON.stringify(banned)}; got: ${truncate(output)}`;
            break;
          }
        }
      }
      if (!reason && sample.check) {
        reason = sample.check(output);
      }

      if (reason) {
        failed++;
        failures.push({ name: `cleaner:${sample.name}`, reason });
      } else {
        passed++;
      }
    } catch (e) {
      failed++;
      failures.push({
        name: `cleaner:${sample.name}`,
        reason: `threw: ${(e as Error).message ?? String(e)}`,
      });
    }
  }

  // --- Prompt protection samples (protectPrompts → restorePrompts) ---
  for (const sample of PROMPT_SAMPLES) {
    try {
      const { text: protectedText, prompts } = protectPrompts(sample.input);
      const restored = restorePrompts(protectedText, prompts);

      let reason: string | null = null;
      for (const needle of sample.expectedContains) {
        if (!restored.includes(needle)) {
          reason =
            `expected to contain ${JSON.stringify(needle)}; got: ${truncate(restored)}`;
          break;
        }
      }
      if (!reason) {
        for (const banned of sample.expectedNotContains) {
          if (restored.includes(banned)) {
            reason =
              `expected NOT to contain ${JSON.stringify(banned)}; got: ${truncate(restored)}`;
            break;
          }
        }
      }

      if (reason) {
        failed++;
        failures.push({ name: `prompt:${sample.name}`, reason });
      } else {
        passed++;
      }
    } catch (e) {
      failed++;
      failures.push({
        name: `prompt:${sample.name}`,
        reason: `threw: ${(e as Error).message ?? String(e)}`,
      });
    }
  }

  return { passed, failed, failures };
}

// ============================================================
// Helpers
// ============================================================

/** Cap a string at 200 chars so failure reasons stay readable in Telegram. */
function truncate(s: string): string {
  const MAX = 200;
  if (s.length <= MAX) return s;
  return s.slice(0, MAX) + `…(${s.length} chars)`;
}
