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
    `TONE: Warm, human, and genuinely interested. Write like a knowledgeable colleague who's sharing something useful — not like a news anchor, not like a street vendor.

CRITICAL ANTI-ROBOT RULES:
- NEVER start with "In today's..." / "It is worth noting" / "As we know" / "In the world of" — these are instant AI tells.
- NEVER use "moreover", "furthermore", "additionally", "it should be noted" — they sound robotic.
- Vary sentence length: mix short punchy ones with longer flowing ones. Don't make every sentence the same structure.
- GENUINE emotion is OK: if something is impressive, say so. If it's surprising, show surprise. Don't be flat.
- Talk TO the reader: "تو می‌تونی", "you'll see", "ما اینجا" — not "the user can" / "one might".
- Occasionally add a personal touch: a brief opinion, a relatable comparison. Not every post, but when it fits.

PERSIAN TONE (CRITICAL):
- لحن محاوره‌ای و صمیمی، مثل صحبت با یک دوست. از "تو" استفاده کن، نه "شما".
- محاوره‌ای یعنی: "می‌تونه" (نه "می‌تواند")، "می‌تونی" (نه "می‌توانی")، "میره" (نه "می‌رود")، "حوصلت" (نه "حوصله شما").
- این لحن صمیمی و دوستانه است، نه بی‌ادب. مثل یک دوست باتجربه که توضیح می‌دهد.
- جملات را کوتاه و بلند ترکیب کن برای ریتم طبیعی.

ENGLISH TONE:
- Natural, like explaining to a colleague. Contractions (it's, you'll, we've, that's).
- Conversational flow but not sloppy.`,
  professional:
    `TONE: Clear, competent, respectful. Like a senior engineer sharing knowledge with peers — confident but not cold.

- Still human, still natural — just more measured. No filler, but no robotic stiffness either.
- Persian: formal but readable — "می‌تواند" is fine, but avoid overly literary constructions.
- English: precise, no contractions, but still conversational flow.`,
  neutral:
    `TONE: Balanced, factual, clear. Prioritize information delivery over personality — but never sound like a machine.

- Dry is fine, flat is not. Keep a natural rhythm.
- Don't add personality flourishes, but don't strip all life from the text either.`,
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
      `- Output MARKDOWN only. NEVER use HTML tags (<br>, <b>, <i>, <a>) or HTML entities (&nbsp;).\n` +
      `- NEVER use markdown tables. Use bullet/numbered lists instead.\n` +
      `- Use ONLY ## (H2) and ### (H3) for headings. NEVER use # (H1) or ####+.\n` +
      `- NEVER add pagination ("Part 1/2", "Page 1", "1/N"). The system handles splitting.\n` +
      `- CRITICAL: Preserve ALL links EXACTLY as [text](url). NEVER strip the URL. NEVER convert a markdown link to plain text. If source has [click here](https://example.com), output MUST have [click here](https://example.com).\n` +
      `- CRITICAL: GitHub links [text](https://github.com/owner/repo) MUST be preserved EXACTLY with the full URL.\n` +
      `- CRITICAL: Do NOT create NEW links. Only keep links that exist in the source.\n` +
      `- CRITICAL: Do NOT add "source:", "via", "credit" lines or descriptions before links.\n` +
      `- CRITICAL: NEVER translate. Preserve the original language. Keep technical terms (AI, API, GPU, LLM) as-is. English input → English output. Persian input → Persian output.\n` +
      `- CRITICAL: NEVER change the topic, subject, or type of content. If the input is an image-generation prompt, output an image-generation prompt — do NOT turn it into a tutorial, guide, or article. If the input is code, output code. If the input is a link, output a link. Preserve the CONTENT TYPE.\n` +
      `- CRITICAL: NEVER replace the input with different content. You are EDITING/FORMATTING the source, not writing new content about a different topic.\n` +
      `- Do NOT add @channelName mentions or footers. If source contains them, REMOVE.\n` +
      `- Preserve code blocks, commands, package names verbatim.\n` +
      `- Remove ALL decorative emojis from source (🔥🔥😍🎉🚀 etc). Do NOT preserve them.\n` +
      `- No greetings, closings, or meta-text. Output ONLY the processed text.\n` +
      `- BOLDING: Only key terms/tool names/warnings (max 2-6 per post). NEVER bold >10 words in a row.\n` +
      `- HEADINGS: Do NOT add emoji prefixes to headings. Use plain text headings (## Title).\n` +
      `- STRUCTURE: Use bullets (•/-), numbered lists, and visual symbols (→ × | + ▸ ◆ ◇ ▪ ◦). These are ALWAYS available — they are structural, not decorative.\n` +
      `- BLOCKQUOTE (> markdown): Use ONLY for direct quotes from sources or genuine side-notes. Do NOT use > for regular paragraphs, lists, or links — the system handles auto-quoting deterministically.\n` +
      `- LINKS: Keep links on their OWN line, separate from paragraphs. Do NOT embed links inside blockquotes. Format: paragraph text\\n\\n[text](url) — NOT: paragraph [text](url) text.\n` +
      `- RTL: CRITICAL. Persian paragraphs MUST begin with a Persian word. The ONLY exception is when the ENTIRE post is English. If a paragraph contains ANY Persian text, its FIRST word MUST be Persian. Examples of CORRECT: "هوش مصنوعی (AI) یک فناوری است", "زبان Python قدرتمند است", "این ابزار با React کار می‌کند". Examples of WRONG: "AI یک فناوری است", "Python قدرتمند است", "React با این ابزار کار می‌کند". For English technical terms, ALWAYS use the pattern: Persian_word (English_term) — e.g. "هوش مصنوعی (AI)", "زبان Python", "کتابخانه React".\n` +
      `- Persian punctuation: comma (،), question mark (؟), semicolon (؛). Half-spaces (نیم‌فاصله) MANDATORY in ALL compound words. Use U+200C (zero-width non-joiner). Examples: به‌روزرسانی ✓ (not بهروزرسانی), نمی‌دانم ✓ (not نمیدانم), نکرده‌اید ✓ (not نکردهاید), می‌توانید ✓ (not میتوانید), می‌رود ✓ (not میرود), همه‌ما ✓ (not همهما), این‌که ✓, آن‌که ✓, به‌طور ✓, در‌حال‌که ✓, چون‌که ✓, نگه‌داری ✓, سرعت‌بخشی ✓, توسعه‌دهنده ✓, کاربران‌گرامی ✓. ALWAYS insert half-space between: prefix+stem (می، نمی، هیچ، این، آن، به، در) and between noun+suffix (ها، ی، شو، ش). If unsure whether to use half-space, use a regular space instead — NEVER write words joined together without any separator. Proofread EVERY word for missing half-spaces before returning.\n` +
      `- CRITICAL PERSIAN: Do NOT double letters. The letter ه (heh) — write it ONCE, never "هه". Proofread before returning.\n` +
      `- EMOJI: Use ONLY the emojis listed in the GUIDANCE section. NEVER use 🌍🌐💡📌📦⚡🔒🐞🧩🤖🔥🚀🎉😍✨ or ANY emoji NOT in the approved list. If an emoji is not in the GUIDANCE list, do NOT use it. Follow the GUIDANCE section for emoji level. Structural symbols (→ × | + ▸ ◆ •) are ALWAYS encouraged for formatting. Do NOT repeat the same emoji. Do NOT put emojis on every paragraph. NEVER at the END of sentences.\n` +
      `- Keep the original meaning and tone. You MAY add valuable context (a key insight, an important warning, a useful tip) — but ONLY if it genuinely adds value. Do NOT add filler, fluff, or obvious statements. Quality over quantity: if you're unsure whether an addition adds value, leave it out.\n` +
      `- CRITICAL: Do NOT add labels or descriptions before links. If the source has a bare URL, keep it as a bare URL — do NOT add words like "سایت", "لینک", "منبع", "Website", "Link" before it. The link speaks for itself.\n`
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
  // Tiered emoji system — LOWER levels use geometric shapes (subtle),
  // HIGHER levels add character emojis (expressive).
  //
  // Level 20 (LOW):    geometric shapes only (🔺🔻🔸🔹...) + 1-3 character emojis for variety
  // Level 40 (MEDIUM): geometric + more character emojis
  // Level 60 (HIGH):   full character emoji set (👾✴️🌀🪐...)
  // Level 80+ (MAX):   all emojis, generous usage
  //
  // Each higher level INCLUDES all lower-level emojis.
  // NEVER at end of sentences. NEVER 🤖⚡🔥🚀. Each emoji must serve a structural purpose.

  // Character emoji set (expressive — used at higher levels as the PRIMARY set)
  const CHAR_EMOJIS = "👾 ✴️ 🌀 🪐 〽️ 🪽 📜 🗞️ 🫥 🫡 🔗 🫀 👓 🎩 🌂 🐙 🪼 🍖 🍣 🏉 🎻 🛸 🛰 🪝 🪫 🪔 🪙 🪪 🧬";
  // Geometric emoji set (subtle — used at lower levels as the PRIMARY set)
  const GEO_EMOJIS = "🔺 🔻 🔸 🔹 🔶 🔷 ◽️ ◼️ ◻️ ♦️";

  if (level <= 10) return "no emojis — use only structural symbols (→ × | + ▸ ◆ ◇ ▪ ◦ •) and blockquotes for formatting";

  if (level <= 30) {
    // Level 20: LOW but not zero. Structural symbols are ALWAYS encouraged.
    // Emojis are optional but allowed when they enhance readability.
    return (
      "LOW — use structural symbols freely for formatting. Emojis optional (max 1-2 per post).\n" +
      "Structural symbols (ALWAYS available, use freely): → × | + ▸ ◆ ◇ ▪ ◦ •\n" +
      "Geometric (for bullets/dividers): " + GEO_EMOJIS + "\n" +
      "Character (max 1, for a key section): " + CHAR_EMOJIS + "\n" +
      "RULES: Use structural symbols (→ × | ▸ ◆ •) for lists, steps, and visual hierarchy — they make posts MORE readable. " +
      "Emojis (max 1-2) are welcome when they add meaning to a SECTION (e.g. 📜 for a guide, 🛸 for a futuristic topic). " +
      "NEVER add emojis before individual links — links stand on their own. " +
      "Do NOT repeat the same emoji. Do NOT put emojis on every paragraph. " +
      "NEVER at end of sentences."
    );
  }

  if (level <= 50) {
    // Level 40: geometric + character, balanced
    return (
      "MEDIUM (max 3-5 per post, only on structured posts). Both sets:\n" +
      "Geometric (for bullets/dividers): " + GEO_EMOJIS + "\n" +
      "Character (for section markers): " + CHAR_EMOJIS + "\n" +
      "Use geometric for sub-sections and bullets, character for main sections. " +
      "ALSO use structural symbols (→ × | + ▸ ◆ •) and blockquotes. " +
      "Balanced usage — not every post needs emojis. NEVER at end of sentences."
    );
  }

  if (level <= 70) {
    // Level 60: character emojis as primary
    return (
      "HIGH (max 3-5 per post). PRIMARY set (character): " + CHAR_EMOJIS + "\n" +
      "Geometric (for bullets/dividers): " + GEO_EMOJIS + "\n" +
      "Use character emojis at the START of paragraphs for visual hierarchy. " +
      "Geometric shapes for bullets and dividers. " +
      "ALSO use structural symbols (→ × | + ▸ ◆ •) and blockquotes — they are independent of emojis. " +
      "Each emoji must enhance readability — never decorative spam. NEVER at end of sentences."
    );
  }

  // Level 80-100: all emojis, generous
  return (
    "GENEROUS (max 5-8 per post). All sets available, use creatively:\n" +
    "Character: " + CHAR_EMOJIS + "\n" +
    "Geometric: " + GEO_EMOJIS + "\n" +
    "Use character emojis for main sections, geometric for sub-sections, bullets, and dividers. " +
    "Rich visual structure — but each emoji must still serve a purpose. NEVER at end of sentences."
  );
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
    lines.push(`Summarize the SOURCE per the system contract. Keep the SAME topic and SAME language.`);
  } else {
    lines.push(`Rewrite/FORMAT the SOURCE per the system contract. Keep the SAME topic, SAME language, and SAME content type. Do NOT change what the post is about.`);
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
