/**
 * ai/index.js
 * AI Knowledge Base loader.
 *
 * Per V2 architecture, all AI rules are organized in a structured knowledge base.
 * This module loads all rules and examples, and provides a function to build
 * the full system prompt for any AI stage.
 *
 * Structure:
 *   ai/
 *     index.js          ← this file (loader + orchestrator)
 *     readme.js         ← project overview
 *     orchestrator.js   ← stage coordination rules
 *     pipeline.js       ← pipeline definition
 *     soul.js           ← personality (added in v0.3.3)
 *     channel_identity.js
 *     ui_rules.js
 *     rewrite_rules.js
 *     formatting_levels.js
 *     attribution_rules.js
 *     language_rules.js
 *     html_rules.js
 *     decision_tree.js
 *     confidence.js
 *     vocabulary.js
 *     style.js
 *     providers.js
 *     fallback.js
 *     output_schema.js
 *     mistakes.js       ← common mistakes to avoid
 *     examples/
 *       github.js
 *       news.js
 *       tutorials.js
 *       tools.js
 *       hardware.js
 *       cybersecurity.js
 *       ai.js
 *       long_posts.js
 *       mixed.js
 */

import { README } from "./readme.js";
import { ORCHESTRATOR } from "./orchestrator.js";
import { PIPELINE } from "./pipeline.js";
import { CHANNEL_IDENTITY } from "./channel_identity.js";
import { UI_RULES } from "./ui_rules.js";
import { REWRITE_RULES } from "./rewrite_rules.js";
import { FORMATTING_LEVELS } from "./formatting_levels.js";
import { ATTRIBUTION_RULES } from "./attribution_rules.js";
import { LANGUAGE_RULES } from "./language_rules.js";
import { HTML_RULES } from "./html_rules.js";
import { DECISION_TREE } from "./decision_tree.js";
import { CONFIDENCE } from "./confidence.js";
import { VOCABULARY } from "./vocabulary.js";
import { STYLE } from "./style.js";
import { PROVIDERS } from "./providers.js";
import { FALLBACK } from "./fallback.js";
import { OUTPUT_SCHEMA } from "./output_schema.js";
import { MISTAKES } from "./mistakes.js";
import { RTL_RULES } from "./rtl_rules.js";
import { EMOJI_RULES } from "./emoji_rules.js";
import { SEMANTIC_FORMATTER } from "./semantic_formatter.js";

// Examples
import { EXAMPLES_GITHUB } from "./examples/github.js";
import { EXAMPLES_NEWS } from "./examples/news.js";
import { EXAMPLES_TUTORIALS } from "./examples/tutorials.js";
import { EXAMPLES_TOOLS } from "./examples/tools.js";
import { EXAMPLES_HARDWARE } from "./examples/hardware.js";
import { EXAMPLES_CYBERSECURITY } from "./examples/cybersecurity.js";
import { EXAMPLES_AI } from "./examples/ai.js";
import { EXAMPLES_LONG_POSTS } from "./examples/long_posts.js";
import { EXAMPLES_MIXED } from "./examples/mixed.js";

/**
 * Build the full system prompt for the Editor stage.
 * OPTIMIZED (v0.3.6): Includes essential rules + key examples + RTL + emoji rules.
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
 * v0.3.6: Includes semantic formatter + RTL + emoji + UI rules.
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
 * Get all knowledge base content (for debugging).
 */
export function getAllKnowledge() {
  return {
    readme: README,
    orchestrator: ORCHESTRATOR,
    pipeline: PIPELINE,
    channelIdentity: CHANNEL_IDENTITY,
    uiRules: UI_RULES,
    rewriteRules: REWRITE_RULES,
    formattingLevels: FORMATTING_LEVELS,
    attributionRules: ATTRIBUTION_RULES,
    languageRules: LANGUAGE_RULES,
    htmlRules: HTML_RULES,
    decisionTree: DECISION_TREE,
    confidence: CONFIDENCE,
    vocabulary: VOCABULARY,
    style: STYLE,
    providers: PROVIDERS,
    fallback: FALLBACK,
    outputSchema: OUTPUT_SCHEMA,
    mistakes: MISTAKES,
    examples: {
      github: EXAMPLES_GITHUB,
      news: EXAMPLES_NEWS,
      tutorials: EXAMPLES_TUTORIALS,
      tools: EXAMPLES_TOOLS,
      hardware: EXAMPLES_HARDWARE,
      cybersecurity: EXAMPLES_CYBERSECURITY,
      ai: EXAMPLES_AI,
      longPosts: EXAMPLES_LONG_POSTS,
      mixed: EXAMPLES_MIXED,
    },
  };
}
