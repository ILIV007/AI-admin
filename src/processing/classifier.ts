/**
 * src/processing/classifier.ts
 * -----------------------------------------------------------------------------
 * Deterministic, RULE-BASED content classifier.
 *
 * V1's classifier was broken — `aiClassify` was never exported and the code
 * always fell back to a half-implemented ruleset. V2 makes the ruleset the
 * ONLY path: no AI calls, no quotas burned, no race conditions. The AI is
 * invoked later in the pipeline (after classification) for rewriting, not for
 * categorization.
 *
 * Category priority (highest → lowest):
 *   github → code → cybersecurity → ai → tool → tutorial → hardware → news → general
 *
 * Rewrite recommendations:
 *   • hasCode && !hasLongText         → "light"   (preserve code, light polish)
 *   • hasLongText                     → "normal"  (condense / restructure)
 *   • short news                      → "light"   (just clean + format)
 *   • otherwise                       → "normal"
 *
 * recommendedNeedsRewrite = length > 60 OR promotional patterns detected.
 * -----------------------------------------------------------------------------
 */

import type {
  Classification,
  ContentCategory,
  RewriteMode,
} from "../types";
import { detectLanguage } from "./cleaner";

// ---------------------------------------------------------------------------
// Detection regexes (all case-insensitive, word-boundary guarded)
// ---------------------------------------------------------------------------

const GITHUB_LINK_RE =
  /(?:github\.com|gist\.github\.com|raw\.githubusercontent\.com)/i;

const CODE_FENCE_RE = /```/;
const INLINE_CODE_RE = /`[^`\n]+`/;

const CYBER_RE =
  /\b(?:CVE-\d{2,4}-\d+|vulnerabilit(?:y|ies)|exploit|securit(?:y|ies)|0-day|zero-day|malware|ransomware|penetration|pentest|backdoor|botnet|rootkit|payload)\b/i;

const AI_RE =
  /\b(?:AI|LLM|GPT|Gemini|Claude|Llama|Mistral|neural|transformer|machine\s+learning|deep\s+learning|inference|fine-?tuning|RAG|embedding|tokenizer)\b/i;

const TOOL_RE =
  /\b(?:tool|CLI|command-?line|library|framework|SDK|package|utility|runner|builder|compiler|interpreter)\b/i;

const TUTORIAL_RE =
  /\b(?:tutorial|how\s+to|guide|install(?:ation)?|setup|walkthrough|step-?by-?step|getting\s+started|quick\s*start)\b/i;

const HARDWARE_RE =
  /\b(?:CPU|GPU|RAM|SSD|HDD|NVMe|processor|motherboard|power\s+supply|heatsink|overclock|benchmark)\b/i;

const NEWS_RE =
  /\b(?:released?|release|update|updated|announce|announcement|version|launch|launches|launched|out\s+now|new\s+release|just\s+dropped|now\s+available|GA\b)\b/i;

// Promotional patterns — trigger recommendedNeedsRewrite so we clean them up.
const PROMO_RE =
  /\b(?:via\s+@|source\s*[:：]\s*@|join|follow|subscribe)\b/i;

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

export function classify(text: string): Classification {
  const hasCode = CODE_FENCE_RE.test(text) || INLINE_CODE_RE.test(text);
  const hasGithubLink = GITHUB_LINK_RE.test(text);
  const length = text.length;
  const hasLongText = length > 800;
  const wordCount = (text.match(/\S+/g) || []).length;

  const category = detectCategory(text, hasCode, hasGithubLink);
  const language = detectLanguage(text);
  const recommendedRewrite = recommendRewrite(hasCode, hasLongText, category);
  const recommendedNeedsRewrite = length > 60 || PROMO_RE.test(text);

  return {
    category,
    language,
    hasCode,
    hasGithubLink,
    hasLongText,
    wordCount,
    recommendedRewrite,
    recommendedNeedsRewrite,
  };
}

// ---------------------------------------------------------------------------
// Category detection — priority order matters
// ---------------------------------------------------------------------------

function detectCategory(
  text: string,
  hasCode: boolean,
  hasGithubLink: boolean,
): ContentCategory {
  if (hasGithubLink) return "github";
  if (hasCode) return "code";
  if (CYBER_RE.test(text)) return "cybersecurity";
  if (AI_RE.test(text)) return "ai";
  if (TOOL_RE.test(text)) return "tool";
  if (TUTORIAL_RE.test(text)) return "tutorial";
  if (HARDWARE_RE.test(text)) return "hardware";
  if (NEWS_RE.test(text)) return "news";
  return "general";
}

// ---------------------------------------------------------------------------
// Rewrite recommendation
// ---------------------------------------------------------------------------

function recommendRewrite(
  hasCode: boolean,
  hasLongText: boolean,
  category: ContentCategory,
): RewriteMode {
  // Code-heavy short post: light polish, preserve code.
  if (hasCode && !hasLongText) return "light";
  // Long post: normal rewrite to condense / restructure.
  if (hasLongText) return "normal";
  // Short news: light clean-up.
  if (category === "news") return "light";
  return "normal";
}
