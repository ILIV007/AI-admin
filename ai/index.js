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
 * Includes: rules + examples + stage-specific prompt
 */
export function buildEditorPrompt(basePrompt) {
  return [
    basePrompt,
    "",
    "=== AI KNOWLEDGE BASE ===",
    "",
    README,
    "",
    DECISION_TREE,
    "",
    CONFIDENCE,
    "",
    CHANNEL_IDENTITY,
    "",
    REWRITE_RULES,
    "",
    ATTRIBUTION_RULES,
    "",
    LANGUAGE_RULES,
    "",
    VOCABULARY,
    "",
    STYLE,
    "",
    MISTAKES,
    "",
    "=== EXAMPLES (learn from these) ===",
    "",
    "--- GitHub Examples ---",
    EXAMPLES_GITHUB,
    "",
    "--- News Examples ---",
    EXAMPLES_NEWS,
    "",
    "--- Tutorial Examples ---",
    EXAMPLES_TUTORIALS,
    "",
    "--- Tools Examples ---",
    EXAMPLES_TOOLS,
    "",
    "--- AI Examples ---",
    EXAMPLES_AI,
    "",
    "--- Hardware Examples ---",
    EXAMPLES_HARDWARE,
    "",
    "--- Cybersecurity Examples ---",
    EXAMPLES_CYBERSECURITY,
    "",
    "--- Long Post Examples ---",
    EXAMPLES_LONG_POSTS,
    "",
    "--- Mixed Examples ---",
    EXAMPLES_MIXED,
    "",
    "=== END KNOWLEDGE BASE ===",
  ].join("\n");
}

/**
 * Build the full system prompt for the Formatter stage (when AI is used for formatting).
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
