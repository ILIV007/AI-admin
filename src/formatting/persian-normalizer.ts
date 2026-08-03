/**
 * src/formatting/persian-normalizer.ts
 * -----------------------------------------------------------------------------
 * Post-processing normalizer for Persian text.
 *
 * PROBLEM: Even with explicit instructions in the AI system prompt, models
 * frequently forget to insert half-spaces (نیم‌فاصله, U+200C) in compound
 * words. Output like "بهروزرسانی" (wrong) appears instead of "به‌روزرسانی" (correct).
 *
 * SOLUTION: This module applies deterministic fixes AFTER the AI generates text.
 * It uses TWO approaches:
 *
 * 1. PATTERN-BASED: regex patterns that match common Persian prefix/stem and
 *    noun/suffix combinations and insert U+200C. This catches most cases
 *    without needing an exhaustive word list.
 *
 * 2. WORD-LIST: a curated list of specific compound words that don't follow
 *    the patterns above (e.g. به‌روزرسانی, توسعه‌دهنده).
 *
 * The normalizer is SAFE to run on any text:
 *   - It only matches specific Persian word patterns.
 *   - It runs BEFORE markdownToBlocks; code blocks, links, AND bare URLs are
 *     protected so URL paths containing Persian text (e.g.
 *     https://example.com/بهروز) are never mutated.
 *   - It preserves existing U+200C chars (idempotent).
 * -----------------------------------------------------------------------------
 */

// ============================================================
// 1. WORD-LIST: specific compound words that don't follow patterns
// ============================================================

/**
 * Curated list of common Persian compound words that should use نیم‌فاصله.
 * Each entry: [wrong (no half-space), correct (with half-space)].
 * The wrong form is matched as a WHOLE WORD.
 */
const COMPOUND_FIXES: ReadonlyArray<[string, string]> = [
  // --- Common compounds ---
  ["بهروزرسانی", "به‌روزرسانی"],
  ["بهروز", "به‌روز"],
  ["توسعهدهنده", "توسعه‌دهنده"],
  ["توسعهدهندگان", "توسعه‌دهندگان"],
  ["برنامهنویس", "برنامه‌نویس"],
  ["برنامهنویسان", "برنامه‌نویسان"],
  ["برنامهنویسی", "برنامه‌نویسی"],
  ["نگهداری", "نگه‌داری"],
  ["نگهدار", "نگه‌دار"],
  ["سرعتبخشی", "سرعت‌بخشی"],
  ["کاربرانگرامی", "کاربران‌گرامی"],
  ["کاربرگرامی", "کاربر‌گرامی"],
  ["هوشمصنوعی", "هوش‌مصنوعی"],
  ["یادگیریماشین", "یادگیری‌ماشین"],
  ["یادگیریعمیق", "یادگیری‌عمیق"],
  ["نرمافزار", "نرم‌افزار"],
  ["نرمافزاری", "نرم‌افزاری"],
  ["نرمافزارهای", "نرم‌افزارهای"],
  ["سختافزار", "سخت‌افزار"],
  ["سختافزاری", "سخت‌افزاری"],
  ["راهاندازی", "راه‌اندازی"],
  ["راهانداز", "راه‌انداز"],
  ["پیشبینی", "پیش‌بینی"],
  ["پیشبین", "پیش‌بین"],
  ["درحالکه", "در‌حال‌که"],
  ["درحالیکه", "در‌حالی‌که"], // FIX v2.15.6: was "در‌حال‌که" (dropped ی)

  // --- به + word ---
  ["بهطور", "به‌طور"],
  ["بهنحو", "به‌نحو"],
  ["بهعنوان", "به‌عنوان"],
  ["بهمعنی", "به‌معنی"],
  ["بهویژه", "به‌ویژه"],
  ["بهخصوص", "به‌خصوص"],
  ["بهراحتی", "به‌راحتی"],
  ["بهدلیل", "به‌دلیل"],
  ["بهراه", "به‌راه"],
  ["بهسادگی", "به‌سادگی"],
  ["بههمین", "به‌همین"],
  ["بهموجب", "به‌موجب"],
  ["بهمنظور", "به‌منظور"],
  ["بهکارگیری", "به‌کارگیری"],

  // --- در + word ---
  ["درحال", "در‌حال"],
  ["درنتیجه", "در‌نتیجه"],
  ["درواقع", "در‌واقع"],
  ["درحالی", "در‌حالی"],
  ["دردسترس", "در‌دسترس"],
  // REMOVED v2.15.6: ["درباره", "در‌باره"] — درباره is a correctly-spelled
  // single word ("about"); inserting a half-space corrupts it into در+باره.
  ["درمورد", "در‌مورد"],
  ["درطول", "در‌طول"],
  ["درکنار", "در‌کنار"],
  ["درحین", "در‌حین"],
  ["درپاسخ", "در‌پاسخ"],
  ["درجریان", "در‌جریان"],
  ["درنهایت", "در‌نهایت"],
  ["دروعمل", "در‌عمل"],

  // --- این / آن / هیچ / همه ---
  ["اینکه", "این‌که"],
  ["آنکه", "آن‌که"],
  ["آنچه", "آن‌چه"],
  ["هیچگاه", "هیچ‌گاه"],
  ["هیچکدام", "هیچ‌کدام"],
  ["هیچکس", "هیچ‌کس"],
  ["هیچچیز", "هیچ‌چیز"],
  ["هیچیک", "هیچ‌یک"],
  ["همهما", "همه‌ما"],
  ["همهچیز", "همه‌چیز"],
  ["همهکس", "همه‌کس"],
  ["همهی", "همه‌ی"],
  ["همهیک", "همه‌یک"],
  ["کدامیک", "کدام‌یک"],
  ["کدامها", "کدام‌ها"],

  // --- ـها suffix (plural) ---
  ["دادهها", "داده‌ها"],
  ["دادههای", "داده‌های"],
  ["سیستمها", "سیستم‌ها"],
  ["سیستمهای", "سیستم‌های"],
  ["شبکهها", "شبکه‌ها"],
  ["شبکههای", "شبکه‌های"],
  ["پیشبینیها", "پیش‌بینی‌ها"],

  // --- شده/شده/شد verbs ---
  ["ساختهشد", "ساخته‌شد"],
  ["ساختهشده", "ساخته‌شده"],
  ["انجامشد", "انجام‌شد"],
  ["انجامشده", "انجام‌شده"],
  ["انتشارشد", "انتشار‌شد"],
  ["انتشارشده", "انتشار‌شده"],

  // --- چندین ---
  ["چندینبار", "چندین‌بار"],
  ["چندیننفر", "چندین‌نفر"],
  ["چندینمورد", "چندین‌مورد"],
];

// ============================================================
// 2. PATTERN-BASED: regex patterns for common prefix/stem combos
// ============================================================

/**
 * Pattern: نمی + verb stem (without half-space) → نمی‌ + stem
 * Matches: نمیرود, نمیشود, نمیتواند, نمیدانم, نمیدانیم, etc.
 * The stem must start with a Persian letter.
 *
 * Note: we use a whitelist of common stems to avoid false positives.
 */
const NEGATIVE_VERB_STEMS = [
  "رود", "شود", "تواند", "توان", "توانید", "توانستم",
  "دانم", "دانیم", "دانند", "داند", "دانست", "دانستند", "دانستم",
  "ده", "دهد", "دهند",
  "گیرد", "گیرند",
  "کنم", "کنیم", "کنید", "کند", "کنند",
  "شوم", "شویم", "شوید", "شوند",
  "شناسد", "شناسند",
  "نویسد", "نویسند",
  "آید", "آیند",
];

/**
 * Pattern: می + verb stem (without half-space) → می‌ + stem
 */
const POSITIVE_VERB_STEMS = [
  "رود", "شود", "باشد",
  "تواند", "توان", "توانید", "توانستم",
  "دانم", "دانیم", "دانند", "دانست", "دانستند", "دانستم",
  "ده", "دهد", "دهند",
  "گیرد", "گیرند",
  "کنم", "کنیم", "کنید", "کند", "کنند",
  "شوم", "شویم", "شوید", "شوند",
  "شناسد", "شناسند",
  "نویسد", "نویسند",
  "آید", "آیند",
];

// Build the pattern-based regexes.
// Boundary: (?<![\u0600-\u06FF]) before, (?![\u0600-\u06FF]) after.
// Sort stems by length DESC so longer stems match first.
function buildStemRegex(prefix: string, stems: string[]): RegExp {
  const sorted = [...stems].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // Match prefix + stem, with word boundary (not preceded/followed by Persian letter)
  const pattern = `(?<![\\u0600-\\u06FF])${prefix}(${escaped.join("|")})(?![\\u0600-\\u06FF])`;
  return new RegExp(pattern, "g");
}

const NEGPREFIX_RE = buildStemRegex("نمی", NEGATIVE_VERB_STEMS);
const POSPREFIX_RE = buildStemRegex("می", POSITIVE_VERB_STEMS);

// ============================================================
// Build word-list regex + lookup
// ============================================================

function buildFixRegex(wrongWords: string[]): RegExp {
  const sorted = [...wrongWords].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = `(?<![\\u0600-\\u06FF])(${escaped.join("|")})(?![\\u0600-\\u06FF])`;
  return new RegExp(pattern, "g");
}

const FIX_RE = buildFixRegex(COMPOUND_FIXES.map(([wrong]) => wrong));

const FIX_MAP = new Map<string, string>();
for (const [wrong, correct] of COMPOUND_FIXES) {
  if (!FIX_MAP.has(wrong)) {
    FIX_MAP.set(wrong, correct);
  }
}

// ============================================================
// Main entry point
// ============================================================

/**
 * Normalize Persian compound words by inserting missing half-spaces (U+200C).
 *
 * Runs AFTER sanitizeAiOutput and BEFORE markdownToBlocks. Code fences, inline
 * code, and links are protected so we only modify prose text.
 *
 * @param text  AI output text (markdown, already sanitized).
 * @returns     Text with Persian compound words fixed.
 */
export function normalizePersianHalfSpaces(text: string): string {
  if (!text) return "";

  // 1. Protect code fences, inline code, markdown links, AND bare URLs.
  //    Bare URLs are protected so Persian text in a URL path (e.g.
  //    https://example.com/بهروز) is never mutated by the half-space fixer.
  const protected_: string[] = [];
  let working = text;

  working = working.replace(/```[\s\S]*?```/g, (m) => {
    protected_.push(m);
    return `\u0000P${protected_.length - 1}\u0000`;
  });
  working = working.replace(/`[^`\n]+`/g, (m) => {
    protected_.push(m);
    return `\u0000P${protected_.length - 1}\u0000`;
  });
  working = working.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => {
    protected_.push(m);
    return `\u0000P${protected_.length - 1}\u0000`;
  });
  // Protect bare URLs (with or without protocol). The URL extends until the
  // next whitespace or end of line. Trailing punctuation is left in place
  // (it's not part of the URL and won't be mutated by the Persian fixer).
  working = working.replace(/https?:\/\/[^\s<>"]+/gi, (m) => {
    protected_.push(m);
    return `\u0000P${protected_.length - 1}\u0000`;
  });

  // 2. Apply pattern-based fixes (می‌ + stem, نمی‌ + stem).
  //    These handle verb conjugations that a word list can't cover exhaustively.
  working = working.replace(NEGPREFIX_RE, (_m, stem) => `نمی\u200C${stem}`);
  working = working.replace(POSPREFIX_RE, (_m, stem) => `می\u200C${stem}`);

  // 3. Apply word-list fixes (specific compound nouns/prepositions).
  working = working.replace(FIX_RE, (m) => FIX_MAP.get(m) ?? m);

  // 4. Restore protected content.
  working = working.replace(/\u0000P(\d+)\u0000/g, (_, i) => protected_[Number(i)] ?? "");

  return working;
}
