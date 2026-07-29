/**
 * src/ai/prompts.ts
 * System + user prompt builders.
 *
 * V2.4.0 changes:
 *   • Stronger link preservation (NEVER strip URLs)
 *   • Professional emoji usage (functional, not decorative at paragraph ends)
 *   • Visual symbols (→, ×, |, +, ▸, ◆) for structure
 *   • Post-process RTL fix in pipeline (not just AI instruction)
 *   • Mono copyability fix (separate <pre> and <code> nesting)
 */

import type {
  ChannelProfile,
  Classification,
  Settings,
} from "../types";

// ============================================================
// System prompt
// ============================================================

export function buildSystemPrompt(
  profile: ChannelProfile,
  settings: Settings,
  mode: "rewrite" | "summarize",
): string {
  const parts: string[] = [];

  // --- Profile identity ---
  parts.push(`# IDENTITY\n${profile.soul}`);
  parts.push(`# STYLE\n${profile.style}`);
  parts.push(`# RULES\n${profile.rules}`);

  // --- Hard output contract ---
  parts.push(
    `# OUTPUT CONTRACT (mandatory)\n` +
      `- Output MARKDOWN only, never raw HTML.\n` +
      `- CRITICAL: Preserve ALL links EXACTLY. [text](url) → output [text](url). Bare URLs → output as-is. NEVER remove, shorten, or reformat any URL. NEVER replace a link with just its text. The link MUST appear in your output.\n` +
      `- CRITICAL: Do NOT create NEW links. Only keep links that exist in the source. NEVER invent URLs or turn plain text into links.\n` +
      `- CRITICAL: Do NOT add "source:", "via", "credit", or attribution lines. But DO keep all existing links.\n` +
      `- Preserve ALL URLs, GitHub links, code blocks, commands, package names verbatim.\n` +
      `- CRITICAL: NEVER translate English technical terms to Persian. Keep AI, API, GPU, CPU, LLM, bot, cloud, framework as-is.\n` +
      `- CRITICAL: Do NOT add @channelName mentions or footers. The system adds them.\n` +
      `- CRITICAL: If source contains @channelName mentions, REMOVE them.\n` +
      `- Preserve content emojis (📦 in "📦 Installation"). Remove decorative spam (🔥🔥😍🎉).\n` +
      `- No greetings, closings, or meta-text. Output ONLY the processed text.\n` +
      `- BOLDING: Only key terms, tool names, warnings (max 2-6 per post). NEVER bold >10 words in a row. NEVER bold entire paragraphs.\n` +
      `- STRUCTURE: Use bullets (•), numbered lists, and visual symbols (→ × | + ▸ ◆) for structure.\n` +
      `- ORGANIZATION: Break long text into separate paragraphs. Each paragraph = one idea. Make posts readable, attractive, and well-structured.\n` +
      `- BLOCKQUOTE: Use > for explanatory text after ":", step-by-step instructions, guide text, bullet lists, and long URLs. At least 1 blockquote per post when applicable. NEVER quote the FIRST paragraph. Quote bullet lists and numbered steps. Be creative with quotes for long posts — use them to highlight important sections.\n` +
      `- CRITICAL RTL: If a paragraph is Persian, you MUST start it with a Persian word. NEVER start a Persian paragraph with an English word. Example: write "هوش مصنوعی (AI)" NOT "AI یک فناوری".\n` +
      `- Use Persian punctuation in Persian: comma (،), question mark (؟), semicolon (؛). Half-spaces (نیم‌فاصله) in compound words.\n` +
      `- CRITICAL: Write Persian correctly. Use half-spaces (نیم‌فاصله) in compound words like "می‌رود", "می‌تواند", "نیم‌فاصله". Do NOT double letters. Proofread your output.\n` +
      `- English words WITHIN Persian text are FINE and should be KEPT. Just ensure the FIRST word is Persian.\n` +
      `- EMOJI: NEVER put emojis at the END of sentences or paragraphs. NEVER use 🤖, ⚡, 🔥, 🚀 randomly. Only use emojis when they genuinely enhance content (📦 for releases, 🔒 for security). Max 1-2 per post.\n` +
      `- TONE: Write naturally, like a skilled human admin — NOT robotic. Vary sentence structure. Be conversational but professional.\n` +
      `- Keep the original meaning and tone. Improve readability and structure, but do NOT change the substance of the content.`,
  );

  // --- Mode-specific instructions ---
  if (mode === "summarize") {
    parts.push(
      `# TASK: SUMMARIZE\nCompress to ~40% of original length. Keep ALL technical references. Drop filler and redundancy. Preserve original language.`,
    );
  } else {
    const modeMap: Partial<Record<Settings["rewriteMode"], string>> = {
      none: `Do not rewrite meaning. Only apply formatting fixes.`,
      light: `LIGHT rewrite: minimal edits. Fix formatting only. Keep 95% of original text. Do not rephrase sentences.`,
      normal: `NORMAL rewrite: gentle polish. Fix formatting, remove obvious spam/hype, tighten slightly. Keep original structure and most wording. NOT a full rewrite.`,
      aggressive: `AGGRESSIVE rewrite: full rewrite preserving meaning. Restructure for clarity.`,
    };
    const modeDesc = modeMap[settings.rewriteMode] ?? modeMap.normal!;
    parts.push(`# TASK: REWRITE\n${modeDesc}\nRewrite mode: ${settings.rewriteMode}.`);
  }

  // --- Soft guidance ---
  const editHint = describeEditIntensity(settings.editIntensity);
  const emojiHint = describeEmojiLevel(settings.emojiLevel);
  parts.push(
    `# GUIDANCE\n- Edit intensity: ${settings.editIntensity}/100 — ${editHint}\n- Emoji: ${emojiHint}\n- Language: ${settings.languageMode}`,
  );

  if (settings.languageMode !== "auto") {
    parts.push(`# LANGUAGE\nOutput in ${settings.languageMode}. Translate non-technical content only. Keep technical terms in English.`);
  }

  return parts.join("\n\n");
}

function describeEditIntensity(level: number): string {
  if (level <= 25) return "minimal touch";
  if (level <= 50) return "light touches";
  if (level <= 75) return "moderate edits";
  return "thorough edits";
}

function describeEmojiLevel(level: number): string {
  if (level <= 10) return "no emojis";
  if (level <= 30) {
    return "LOW (max 1-2 per post). Only when genuinely enhances. NEVER at end of sentences. NEVER 🤖⚡🔥🚀.";
  }
  if (level <= 60) return "moderate — use creatively, never at end of sentences";
  return "generous — use freely but professionally, never at end of sentences";
}

// ============================================================
// User prompt
// ============================================================

export function buildUserPrompt(
  text: string,
  classification: Classification,
  mode: "rewrite" | "summarize",
): string {
  const lines: string[] = [];
  lines.push(`# CONTEXT`);
  lines.push(`- Category: ${classification.category}`);
  lines.push(`- Language: ${classification.language}`);
  lines.push(`- Has code: ${classification.hasCode ? "yes" : "no"}`);
  if (classification.hasGithubLink) {
    lines.push(`- Has GitHub link: yes (preserve verbatim)`);
  }
  lines.push("");
  lines.push(`# INSTRUCTION`);
  if (mode === "summarize") {
    lines.push(`Summarize the SOURCE per the system contract.`);
  } else {
    lines.push(`Rewrite the SOURCE per the system contract.`);
  }
  lines.push(`Return ONLY the processed markdown.`);
  lines.push("");
  lines.push(`# SOURCE`);
  lines.push(text);
  return lines.join("\n");
}

/**
 * RTL fix is NO LONGER done via post-processing.
 * The AI is instructed in the system prompt to NEVER start Persian paragraphs
 * with English words. This function is kept as a no-op for backward compat
 * with pipeline.ts which imports it.
 */
export function fixRtlParagraphs(text: string): string {
  return text; // no-op — AI handles RTL via prompt instructions
}
