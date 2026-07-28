/**
 * src/ai/prompts.ts
 * System + user prompt builders.
 *
 * The system prompt combines the channel profile (soul/style/rules/formatting)
 * with mode-specific instructions and soft hints from per-user settings.
 * The user prompt wraps the source text with classification context so the
 * model knows what kind of content it is dealing with (code? github? fa?).
 *
 * All AI output is MARKDOWN. The formatting layer (src/format/) later converts
 * Markdown → Telegram HTML. NEVER let the model emit raw HTML — Telegram will
 * reject it or render it as text.
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
  parts.push(`# FORMATTING\n${profile.formatting}`);

  // --- Hard output contract (always present) ---
  parts.push(
    `# OUTPUT CONTRACT (mandatory)\n` +
      `- You output MARKDOWN only, never raw HTML.\n` +
      `- Preserve all URLs, GitHub links, code blocks, commands, package names verbatim.\n` +
      `- Never translate unless an explicit language mode forces it.\n` +
      `- Preserve the author's emotional tone.\n` +
      `- Do not add greetings or closings.\n` +
      `- Do not invent facts, links, or quotes that were not in the source.\n` +
      `- Do not wrap the whole response in a code fence.\n` +
      `- CRITICAL: Do NOT add any channel mentions like @ILIVIR3 or channel handles. The system adds the footer automatically. Never output @ followed by a channel name.\n` +
      `- CRITICAL: Do NOT add any footer, signature, or attribution line. The system handles this.\n` +
      `- CRITICAL: If the source contains @channelName mentions, REMOVE them from your output. They are promotional and will be added by the system footer.`,
  );

  // --- Mode-specific instructions ---
  if (mode === "summarize") {
    parts.push(
      `# TASK: SUMMARIZE\n` +
        `Summarize the source to approximately 40% of its length.\n` +
        `Keep ALL technical references: links, code, commands, package names, version numbers.\n` +
        `Drop filler, hype, and redundant phrasing.\n` +
        `Preserve the original language (Persian stays Persian, English stays English).`,
    );
  } else {
    // rewrite
    const modeMap: Record<Settings["rewriteMode"], string> = {
      none: `Do not rewrite the meaning. Only apply light formatting fixes (whitespace, bullet structure, code fences).`,
      light: `LIGHT rewrite: minimal edits. Fix formatting only (code fences, bullets, links). Do not rephrase sentences.`,
      normal: `NORMAL rewrite: improve readability and remove hype. Tighten sentences. Keep meaning and language.`,
      aggressive: `AGGRESSIVE rewrite: full rewrite preserving meaning. Restructure for clarity. Keep all technical references and language.`,
    };
    parts.push(
      `# TASK: REWRITE\n` +
        `${modeMap[settings.rewriteMode]}\n` +
        `Rewrite mode selected: ${settings.rewriteMode}.`,
    );
  }

  // --- Soft guidance from per-user settings ---
  const editHint = describeEditIntensity(settings.editIntensity);
  const emojiHint = describeEmojiLevel(settings.emojiLevel);
  parts.push(
    `# SOFT GUIDANCE\n` +
      `- Edit intensity: ${settings.editIntensity}/100 — ${editHint}\n` +
      `- Emoji level: ${settings.emojiLevel}/100 — ${emojiHint}\n` +
      `- Personality: ${settings.personalityMode}\n` +
      `- Language mode: ${settings.languageMode}`,
  );

  if (settings.languageMode !== "auto") {
    parts.push(
      `# LANGUAGE\n` +
        `The user explicitly requested language: ${settings.languageMode}. ` +
        `If this differs from the source language, translate the content to ${settings.languageMode}. ` +
        `Otherwise preserve the source language.`,
    );
  }

  return parts.join("\n\n");
}

function describeEditIntensity(level: number): string {
  if (level <= 25) return "touch as little as possible";
  if (level <= 50) return "light touches";
  if (level <= 75) return "moderate edits";
  return "thorough edits";
}

function describeEmojiLevel(level: number): string {
  if (level <= 10) return "no emojis";
  if (level <= 30) return "very few functional emojis only";
  if (level <= 60) return "occasional functional emojis";
  return "generous (but still functional) emojis";
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
  lines.push(`- Detected category: ${classification.category}`);
  lines.push(`- Detected language: ${classification.language}`);
  lines.push(`- Contains code: ${classification.hasCode ? "yes" : "no"}`);
  if (classification.hasGithubLink) {
    lines.push(`- Contains GitHub link: yes (preserve verbatim)`);
  }
  if (classification.hasLongText) {
    lines.push(`- Long text (>800 chars): yes`);
  }

  lines.push("");
  lines.push(`# INSTRUCTION`);
  if (mode === "summarize") {
    lines.push(`Summarize the SOURCE below per the system contract.`);
  } else {
    lines.push(`Rewrite the SOURCE below per the system contract.`);
  }
  lines.push(
    `Return ONLY the processed markdown. No preamble, no explanations, no comments.`,
  );

  lines.push("");
  lines.push(`# SOURCE`);
  lines.push(text);

  return lines.join("\n");
}
