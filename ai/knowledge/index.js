/**
 * ai/knowledge/index.js
 * AI Knowledge Base loader — v0.5.0
 *
 * Refactored:
 *   - Dynamic prompt builder (only includes relevant sections)
 *   - Reduced token waste
 *   - Profile-aware prompt construction
 */

import { DECISION_TREE } from "./decision_tree.js";
import { CONFIDENCE } from "./confidence.js";
import { CHANNEL_IDENTITY } from "./channel_identity.js";
import { REWRITE_RULES } from "./rewrite_rules.js";
import { LANGUAGE_RULES } from "./language_rules.js";
import { RTL_RULES } from "./rtl_rules.js";
import { EMOJI_RULES } from "./emoji_rules.js";
import { VOCABULARY } from "./vocabulary.js";
import { MISTAKES } from "./mistakes.js";
import { UI_RULES } from "./ui_rules.js";
import { FORMATTING_LEVELS } from "./formatting_levels.js";
import { HTML_RULES } from "./html_rules.js";
import { SEMANTIC_FORMATTER } from "./semantic_formatter.js";
import { ATTRIBUTION_RULES } from "./attribution_rules.js";

// Examples (selectively loaded)
import { EXAMPLES_GITHUB } from "../examples/github.js";
import { EXAMPLES_NEWS } from "../examples/news.js";
import { EXAMPLES_MIXED } from "../examples/mixed.js";

/**
 * Build the full system prompt for the Editor stage.
 * v0.5.0: Optimized — only includes essential rules + key examples.
 */
export function buildEditorPrompt(basePrompt) {
  return [
    basePrompt,
    "",
    "=== KEY RULES ===",
    "",
    DECISION_TREE,
    "",
    CONFIDENCE,
    "",
    CHANNEL_IDENTITY,
    "",
    REWRITE_RULES,
    "",
    LANGUAGE_RULES,
    "",
    RTL_RULES,
    "",
    EMOJI_RULES,
    "",
    VOCABULARY,
    "",
    MISTAKES,
    "",
    "=== KEY EXAMPLES (learn from these patterns) ===",
    "",
    EXAMPLES_GITHUB,
    "",
    EXAMPLES_NEWS,
    "",
    EXAMPLES_MIXED,
    "",
    "=== END ===",
  ].join("\n");
}

/**
 * Build the full system prompt for the Formatter stage.
 * v0.5.0: Includes semantic formatter + RTL + emoji + UI rules.
 */
export function buildFormatterPrompt(basePrompt) {
  return [
    basePrompt,
    "",
    "=== FORMATTER KNOWLEDGE BASE ===",
    "",
    UI_RULES,
    "",
    FORMATTING_LEVELS,
    "",
    HTML_RULES,
    "",
    SEMANTIC_FORMATTER,
    "",
    RTL_RULES,
    "",
    EMOJI_RULES,
    "",
    MISTAKES,
    "",
    "=== END KNOWLEDGE BASE ===",
  ].join("\n");
}

/**
 * Dynamic prompt builder — v0.5.0
 * Only includes relevant sections based on content context.
 */
export function buildDynamicPrompt(basePrompt, context = {}) {
  const sections = [basePrompt];

  // Always include core rules
  sections.push("", "=== CORE RULES ===", "", DECISION_TREE, "", CONFIDENCE);

  // Content-type specific rules
  if (context.contentType === "github_repo") {
    sections.push("", "=== GITHUB RULES ===", "", "Preserve all repository links. Keep technical descriptions. Remove hype.");
  } else if (context.contentType === "tutorial") {
    sections.push("", "=== TUTORIAL RULES ===", "", "Preserve all steps and commands. Keep code blocks intact.");
  } else if (context.contentType === "news") {
    sections.push("", "=== NEWS RULES ===", "", "Keep facts straight. Remove emotional language.");
  }

  // Language-specific rules
  if (context.language === "fa") {
    sections.push("", "=== PERSIAN RULES ===", "", RTL_RULES);
  }

  // Always include mistakes to avoid
  sections.push("", "=== MISTAKES TO AVOID ===", "", MISTAKES);

  // Include relevant examples
  sections.push("", "=== EXAMPLES ===");
  if (context.contentType === "github_repo") {
    sections.push("", EXAMPLES_GITHUB);
  } else if (context.contentType === "news") {
    sections.push("", EXAMPLES_NEWS);
  } else {
    sections.push("", EXAMPLES_MIXED);
  }

  return sections.join("\n");
}

/**
 * Get all knowledge base content (for debugging).
 */
export function getAllKnowledge() {
  return {
    decisionTree: DECISION_TREE,
    confidence: CONFIDENCE,
    channelIdentity: CHANNEL_IDENTITY,
    rewriteRules: REWRITE_RULES,
    languageRules: LANGUAGE_RULES,
    rtlRules: RTL_RULES,
    emojiRules: EMOJI_RULES,
    vocabulary: VOCABULARY,
    mistakes: MISTAKES,
    uiRules: UI_RULES,
    formattingLevels: FORMATTING_LEVELS,
    htmlRules: HTML_RULES,
    semanticFormatter: SEMANTIC_FORMATTER,
    attributionRules: ATTRIBUTION_RULES,
    examples: {
      github: EXAMPLES_GITHUB,
      news: EXAMPLES_NEWS,
      mixed: EXAMPLES_MIXED,
    },
  };
}
