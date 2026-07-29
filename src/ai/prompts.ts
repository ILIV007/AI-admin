/**
 * src/ai/prompts.ts
 * System + user prompt builders.
 *
 * V2.5.1 changes (from code-review report):
 *   • P1-1: personalityMode is now WIRED UP (friendly/professional/neutral)
 *   • P1-2: RTL rule softened — English technical terms (Python, React) may
 *     start a paragraph naturally; no artificial Persian prefixes.
 *   • P1-3: "No pagination" instruction added (system handles splitting).
 *   • P2-2: "No HTML tags / entities" instruction added.
 *   • P2-3: "No markdown tables" instruction added.
 *   • P2-4: "Only ## and ### headings" restriction added.
 *   • P2-5: fixRtlParagraphs reimplemented as a real RLM-mark post-processor.
 *   • F: "Preserve original paragraph structure" for light/normal modes.
 *   • G: Blockquote instructions simplified — AI only uses > for genuine
 *     quotes/side-notes; the deterministic parser handles auto-quoting.
 *   • Prompt compressed to reduce attention dilution (~40% shorter).
 */

import type {
  ChannelProfile,
  Classification,
  Settings,
} from "../types";

// ============================================================
// Personality hints (P1-1 fix)
// ============================================================

const PERSONALITY_HINTS: Record<Settings["personalityMode"], string> = {
  friendly:
    "Tone: warm, conversational, approachable. Use casual transitions. Like a knowledgeable friend explaining to a peer.",
  professional:
    "Tone: formal, authoritative, concise. Like a senior engineer documenting for peers. Avoid filler.",
  neutral:
    "Tone: balanced, factual, straightforward. Prioritize clarity over style.",
};

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

  // --- Personality override (P1-1 fix: was dead code, now wired up) ---
  const personality = PERSONALITY_HINTS[settings.personalityMode];
  if (personality) {
    parts.push(`# TONE\n${personality}`);
  }

  // --- Hard output contract (compressed P2-1) ---
  parts.push(
    `# OUTPUT CONTRACT (mandatory)\n` +
      `- Output MARKDOWN only. NEVER use HTML tags (<br>, <b>, <i>, <a>) or HTML entities (&nbsp;). (P2-2)\n` +
      `- NEVER use markdown tables (| col | col |). Use bullet/numbered lists instead. (P2-3)\n` +
      `- Use ONLY ## (H2) and ### (H3) for headings. NEVER use # (H1) or ####+. (P2-4)\n` +
      `- CRITICAL: NEVER add pagination ("Part 1/2", "Page 1", "1/N"). The system handles splitting. (P1-3)\n` +
      `- CRITICAL: Preserve ALL links EXACTLY. [text](url) stays [text](url). Bare URLs stay as-is. NEVER remove/shorten/reformat any URL.\n` +
      `- CRITICAL: Do NOT create NEW links. Only keep links that exist in the source.\n` +
      `- CRITICAL: Do NOT add "source:", "via", "credit" lines. Do NOT add "مخزن گیت‌هاب:" before links.\n` +
      `- CRITICAL: NEVER translate. Preserve the original language exactly. English stays English, Persian stays Persian. Keep technical terms (AI, API, GPU, LLM) as-is.\n` +
      `- Do NOT add @channelName mentions or footers — the system adds them. If source contains them, REMOVE.\n` +
      `- Preserve code blocks, commands, package names, GitHub links verbatim.\n` +
      `- Preserve content emojis (📦 in "📦 Installation"). Remove decorative spam (🔥🔥😍🎉).\n` +
      `- No greetings, closings, or meta-text. Output ONLY the processed text.\n` +
      `- BOLDING: Only key terms/tool names/warnings (max 2-6 per post). NEVER bold >10 words in a row. NEVER bold entire paragraphs.\n` +
      `- HEADINGS: Use 📦/⚡/💡/🔒/🌐/🐞/🧩 as functional emoji prefixes for section headers.\n` +
      `- STRUCTURE: Use bullets (•/-), numbered lists, and visual symbols (→ × | + ▸ ◆).\n` +
      `- BLOCKQUOTE (> markdown): Use ONLY for direct quotes from sources or genuine side-notes. Do NOT use > for regular paragraphs, lists, or links — the system handles auto-quoting deterministically. (G)\n` +
      `- RTL: Persian paragraphs should begin with Persian text when natural. If the subject is an English technical term (e.g. Python, React, API), starting with the English term is ACCEPTABLE and natural. Do NOT force artificial Persian prefixes like "زبان Python" or "فریم‌ورک React". (P1-2)\n` +
      `- Persian punctuation: comma (،), question mark (؟), semicolon (؛). Half-spaces (نیم‌فاصله) in compound words (می‌رود, می‌تواند).\n` +
      `- EMOJI: NEVER at the END of sentences/paragraphs. NEVER 🤖⚡🔥🚀 randomly. Max 1-2 per post, only when genuinely enhances content.\n` +
      `- Keep the original meaning and tone. Improve readability and structure, do NOT change the substance.`,
  );

  // --- Mode-specific instructions ---
  if (mode === "summarize") {
    parts.push(
      `# TASK: SUMMARIZE\nCompress to ~40% of original length. Keep ALL technical references, links, code, --parameters. Drop filler and redundancy. Preserve original language and structure.`,
    );
  } else {
    const modeMap: Partial<Record<Settings["rewriteMode"], string>> = {
      none: `Do not rewrite meaning. Only apply formatting fixes.`,
      light: `LIGHT rewrite: minimal edits. Fix formatting only. Keep 95% of original text. Do not rephrase sentences.`,
      normal: `NORMAL rewrite: gentle polish. Fix formatting, remove obvious spam/hype, tighten slightly. Keep original structure and most wording. NOT a full rewrite. Preserve the original paragraph breaks — do not merge or split paragraphs unless necessary for clarity. (F)`,
      aggressive: `AGGRESSIVE rewrite: full rewrite preserving meaning. Restructure for clarity.`,
    };
    const modeDesc = modeMap[settings.rewriteMode] ?? modeMap.normal!;
    parts.push(`# TASK: REWRITE\n${modeDesc}\nRewrite mode: ${settings.rewriteMode}.`);
  }

  // --- Soft guidance ---
  const editHint = describeEditIntensity(settings.editIntensity);
  const emojiHint = describeEmojiLevel(settings.emojiLevel);
  parts.push(
    `# GUIDANCE\n- Edit intensity: ${settings.editIntensity}/100 — ${editHint}\n- Emoji: ${emojiHint}\n- Language mode: ${settings.languageMode} (auto = preserve source language, do NOT translate)`,
  );

  if (settings.languageMode !== "auto") {
    parts.push(`# LANGUAGE\nOutput in ${settings.languageMode}. Translate non-technical content only. Keep technical terms in English.`);
  } else {
    parts.push(`# LANGUAGE\nAUTO mode: Preserve the original language. Do NOT translate. English stays English, Persian stays Persian.`);
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
  instructionOverride?: string,
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
  // An override instruction (e.g. ultra-compress) goes BEFORE # SOURCE so the
  // model treats it as a directive, not as part of the source to summarize.
  if (instructionOverride) {
    lines.push(`# OVERRIDE INSTRUCTION`);
    lines.push(instructionOverride);
    lines.push("");
  }
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

// ============================================================
// fixRtlParagraphs — real RLM post-processor (P2-5 fix)
// ============================================================

/**
 * Fix Persian paragraphs that start with an English/ASCII word.
 *
 * Telegram's RTL rendering can misplace a leading ASCII token in a Persian
 * paragraph (e.g. "Python یک زبان است" may render with "Python" on the wrong
 * side). Prepending a Right-to-Left Mark (RLM, U+200F) nudges the bidi
 * algorithm to keep the line right-aligned.
 *
 * The AI is also instructed (P1-2) that starting with English technical
 * terms is acceptable — this is a defense-in-depth fallback for when the
 * AI's output still leads with ASCII.
 *
 * This function is idempotent: a line already starting with U+200F is left
 * alone (no double-prefix).
 */
export function fixRtlParagraphs(text: string): string {
  if (!text) return text;
  const persianChar = /[\u0600-\u06FF]/;
  const RLM = "\u200F";
  const lines = text.split("\n");
  return lines
    .map((line) => {
      const trimmed = line.trimStart();
      if (!trimmed) return line;
      // Skip lines that are already RLM-prefixed (idempotent).
      if (line.startsWith(RLM)) return line;
      // Skip code fence lines and list items — don't touch their structure.
      if (/^(```|~~~|>\s|[-*]\s|\d+\.\s|#{2,3}\s)/.test(trimmed)) return line;
      // Only act on lines that contain Persian AND start with an ASCII word.
      if (persianChar.test(trimmed) && /^[A-Za-z][A-Za-z0-9]*\s/.test(trimmed)) {
        return RLM + line;
      }
      return line;
    })
    .join("\n");
}
