/**
 * src/ai/prompts.ts
 * System + user prompt builders.
 *
 * V2.3.1 changes:
 *   • NO translation of English technical terms (AI, API, GPU stay as-is)
 *   • Preserve content emojis (don't remove emojis that are part of the content)
 *   • First paragraph NEVER quoted; selective quoting only
 *   • At least 1 blockquote per post
 *   • Token optimization via shorter system prompt (not lower maxOutputTokens)
 *   • Organization: break long text into separate paragraphs, don't stuff
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

  // --- Profile identity (shortened for token efficiency) ---
  parts.push(`# IDENTITY\n${profile.soul}`);
  parts.push(`# STYLE\n${profile.style}`);
  parts.push(`# RULES\n${profile.rules}`);

  // --- Hard output contract (always present) ---
  parts.push(
    `# OUTPUT CONTRACT (mandatory)\n` +
      `- Output MARKDOWN only, never raw HTML.\n` +
      `- CRITICAL: Preserve ALL links EXACTLY as they appear. If source has [text](url), output [text](url). If source has bare URLs like https://github.com/owner/repo, output them as-is. NEVER remove, shorten, or reformat any URL. NEVER replace a link with just its text. The link MUST appear in your output.\n` +
      `- CRITICAL: Do NOT add "source:", "via", "credit", or any attribution lines. But DO keep all existing links in the output.\n` +
      `- Preserve ALL URLs, GitHub links, code blocks, commands, package names verbatim.\n` +
      `- CRITICAL: NEVER translate English technical terms to Persian. Keep "AI", "API", "GPU", "CPU", "LLM", "bot", "cloud", "framework" etc. as-is in English. Do NOT replace them with Persian equivalents.\n` +
      `- CRITICAL: Do NOT add @channelName mentions or footers. The system adds them.\n` +
      `- CRITICAL: If source contains @channelName mentions, REMOVE them from your output.\n` +
      `- Preserve content emojis: If the source has emojis that are part of the content (e.g. 📦 in "📦 Installation"), KEEP them. Only remove decorative/spam emojis (🔥🔥🔥😍🎉).\n` +
      `- Do not add greetings, closings, or meta-text. Output ONLY the processed text.\n` +
      `- BOLDING: Only bold key terms, tool names, or important warnings (max 2-6 per post). NEVER bold >10 words in a row. NEVER bold entire paragraphs.\n` +
      `- STRUCTURE: Use bullet points (•) and numbered lists for lists. Use Unicode symbols (▸ ◆ ─) for visual structure.\n` +
      `- ORGANIZATION: Break long text into separate paragraphs. Each paragraph = one idea. Make posts readable and attractive.\n` +
      `- BLOCKQUOTE: Use > (markdown blockquote) for explanatory text after ":", step-by-step instructions, guide text, and long URLs. At least 1 blockquote per post when applicable. NEVER quote the FIRST paragraph. Don't quote everything — only selective important parts.\n` +
      `- CRITICAL RTL: If a paragraph is Persian, NEVER start it with an English word or acronym. Put English terms AFTER a Persian word or in parentheses. Example: "هوش مصنوعی (AI)" not "AI یک فناوری".\n` +
      `- Use Persian punctuation in Persian paragraphs: comma (،), question mark (؟), semicolon (؛). Use half-spaces (نیم‌فاصله) in compound words.\n` +
      `- English words WITHIN Persian text are FINE and should be KEPT. Do NOT remove them. Mixed-language paragraphs are normal. Just ensure the paragraph STARTS with a Persian word.\n` +
      `- Keep the original meaning and tone. Improve readability and structure, but do NOT change the substance of the content.`,
  );

  // --- Mode-specific instructions ---
  if (mode === "summarize") {
    parts.push(
      `# TASK: SUMMARIZE\n` +
        `Compress to ~40% of original length.\n` +
        `Keep ALL technical references. Drop filler and redundancy.\n` +
        `Preserve original language.`,
    );
  } else {
    const modeMap: Partial<Record<Settings["rewriteMode"], string>> = {
      none: `Do not rewrite meaning. Only apply formatting fixes.`,
      light: `LIGHT rewrite: minimal edits. Fix formatting only. Keep 95% of original text. Do not rephrase sentences.`,
      normal: `NORMAL rewrite: gentle polish. Fix formatting, remove obvious spam/hype, tighten slightly. Keep original structure and most wording. NOT a full rewrite.`,
      aggressive: `AGGRESSIVE rewrite: full rewrite preserving meaning. Restructure for clarity.`,
    };
    const modeDesc = modeMap[settings.rewriteMode] ?? modeMap.normal!;
    parts.push(
      `# TASK: REWRITE\n${modeDesc}\nRewrite mode: ${settings.rewriteMode}.`,
    );
  }

  // --- Soft guidance (shortened) ---
  const editHint = describeEditIntensity(settings.editIntensity);
  const emojiHint = describeEmojiLevel(settings.emojiLevel);
  parts.push(
    `# GUIDANCE\n` +
      `- Edit intensity: ${settings.editIntensity}/100 — ${editHint}\n` +
      `- Emoji: ${emojiHint}\n` +
      `- Language: ${settings.languageMode}`,
  );

  if (settings.languageMode !== "auto") {
    parts.push(
      `# LANGUAGE\nOutput in ${settings.languageMode}. Translate non-technical content only. Keep technical terms in English.`,
    );
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
    return (
      "Level LOW (1-3 per post). Functional only (📦⚡💡🔒, 1️⃣2️⃣3️⃣). " +
      "No decorative (😍😂🔥🎉). Preserve content emojis. Max 1 per paragraph."
    );
  }
  if (level <= 60) return "occasional functional emojis";
  return "generous functional emojis";
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
