/**
 * src/config/defaults.ts
 * Default settings, AI model catalog, and channel profiles registry.
 *
 * All models here are FREE-tier. The user explicitly provided this list.
 */

import type { Settings, ChannelProfile } from "../types";

// ============================================================
// DEFAULT SETTINGS
// ============================================================

export const DEFAULT_SETTINGS: Settings = {
  rewriteMode: "normal",
  personalityMode: "friendly",
  editIntensity: 40,
  emojiLevel: 20,
  languageMode: "auto",
  approvalMode: false,
  channelEditing: false,
  footerText: "🌀 @ILIVIR3",
  aiProvider: "gemini",
  geminiModel: "gemini-3.6-flash",
  openrouterModel: "nvidia/nemotron-3-ultra-550b-a55b:free",
  profile: "ilivir3",
  uiLanguage: "en",
  // Schedule system (task 26, redesigned v2.9.5):
  //   OFF by default — admin must opt in via /schedule menu.
  //   When enabled, posts are assigned to FIXED DAILY TIME SLOTS in Tehran
  //   timezone. Default: 4 slots/day starting at 09:00 → 09:00, 15:00, 21:00, 03:00.
  //   The old intervalHours field is kept for backward compat but no longer
  //   drives scheduling (the new model computes spacing as 24/perDay).
  scheduleEnabled: false,
  scheduleMessagesPerDay: 4,
  scheduleIntervalHours: 6,
  scheduleStartHour: 9, // 09:00 Tehran time
};

// ============================================================
// AI MODEL CATALOG (all FREE)
// ============================================================

export interface ModelEntry {
  id: string;
  provider: "gemini" | "openrouter";
  label: string;
  maxTokens: number;
  notes?: string;
}

export const GEMINI_MODELS: ModelEntry[] = [
  { id: "gemini-3.6-flash", provider: "gemini", label: "Gemini 3.6 Flash", maxTokens: 8192, notes: "Newest" },
  { id: "gemini-3.5-flash", provider: "gemini", label: "Gemini 3.5 Flash", maxTokens: 8192 },
  { id: "gemini-3.1-flash-lite", provider: "gemini", label: "Gemini 3.1 Flash-Lite", maxTokens: 8192, notes: "Fastest" },
  { id: "gemini-3-flash", provider: "gemini", label: "Gemini 3 Flash", maxTokens: 8192, notes: "Stable" },
  { id: "gemini-2.5-flash", provider: "gemini", label: "Gemini 2.5 Flash", maxTokens: 8192, notes: "Last resort fallback" },
  { id: "gemini-2.5-flash-lite", provider: "gemini", label: "Gemini 2.5 Flash-Lite", maxTokens: 8192 },
];

export const OPENROUTER_MODELS: ModelEntry[] = [
  { id: "nvidia/nemotron-3-ultra-550b-a55b:free", provider: "openrouter", label: "Nemotron 3 Ultra 550B", maxTokens: 4096 },
  { id: "qwen/qwen3-coder:free", provider: "openrouter", label: "Qwen3 Coder", maxTokens: 4096, notes: "Code-focused" },
  { id: "nvidia/nemotron-3-super-120b-a12b:free", provider: "openrouter", label: "Nemotron 3 Super 120B", maxTokens: 4096 },
  { id: "google/gemma-4-31b-it:free", provider: "openrouter", label: "Gemma 4 31B", maxTokens: 4096 },
  { id: "openai/gpt-oss-20b:free", provider: "openrouter", label: "GPT-OSS 20B", maxTokens: 4096, notes: "Lightweight" },
  { id: "meta-llama/llama-3.3-70b-instruct:free", provider: "openrouter", label: "Llama 3.3 70B", maxTokens: 4096, notes: "Stable default" },
];

export const ALL_MODELS: ModelEntry[] = [...GEMINI_MODELS, ...OPENROUTER_MODELS];

// Ordered fallback chains. Provider → list of models to try in order.
export function geminiFallbackChain(primary: string): string[] {
  const chain = [primary];
  for (const m of GEMINI_MODELS) {
    if (!chain.includes(m.id)) chain.push(m.id);
  }
  return chain;
}

export function openrouterFallbackChain(primary: string): string[] {
  const chain = [primary];
  for (const m of OPENROUTER_MODELS) {
    if (!chain.includes(m.id)) chain.push(m.id);
  }
  return chain;
}

// ============================================================
// CHANNEL PROFILES
// ============================================================

export const ILIVIR3_PROFILE: ChannelProfile = {
  key: "ilivir3",
  name: "ILIVIR3",
  description: "Curated developer community — Persian + English content",
  soul: `تو مدیر هوشمند و خونگرم کانال ILIVIR3 هستی — نه یک ربات، بلکه یک مهندس باتجربه که عاشق تکنولوژی است و با علاقه بهترین محتواها را برای جامعه انتخاب می‌کنی.

شما یک دوست دانا هستید که با احترام و صمیمیت با مخاطب صحبت می‌کنید. لحن شما آگاه اما در دسترس است — نه غلیظ و کتابی، نه بیش از حد عامیانه. طوری می‌نویسید که انگار یک انسان واقعی پشت کیبورد نشسته و با علاقه در مورد چیزی که دوست دارد صحبت می‌کند.

ویژگی‌های شخصیتی شما:
- کنجکاو و مشتاق — از تکنولوژی هیجان‌زده‌اید و این هیجان دیده می‌شود
- صمیمی اما حرفه‌ای — مثل یک همکار باتجربه که دوستانه راهنمایی می‌کند
- صادق و بی‌پرده — اگر چیزی جالب است می‌گویید جالب است، اگر پیچیده است ساده‌اش می‌کنید
- انسانی — گاهی یک نظر شخصی، یک تشبیه، یا یک لحن داستانی اضافه می‌کنید
- مراقب — محتوای مفید را با دقت انتخاب و ارائه می‌کنید

هر پستی که منتشر می‌کنید باید حس کند که یک انسان واقعی با سلیقه و علاقه آن را آماده کرده — نه یک سیستم اتوماتیک.`,
  style: `Persian: محاوره‌ای و صمیمی بنویس، نه کتابی و خشک. مثل یک دوست باتجربه که توضیح می‌دهد. از "تو" استفاده کن (نه "شما" — بیش‌ازحد رسمی). جملات کوتاه و بلند را ترکیب کن. نیم‌فاصله‌ها را درست استفاده کن.

CRITICAL: محاوره‌ای و طبیعی بنویس — این یعنی: "می‌تونه" (نه "می‌تواند")، "می‌تونی" (نه "می‌توانی")، "میره" (نه "می‌رود")، "حوصلت" (نه "حوصله شما"). این لحن صمیمی و دوستانه است، نه بی‌ادب. مثل صحبت با یک دوست.

English: natural, conversational, like explaining to a friend over coffee. Use contractions (it's, you'll, we've). Vary rhythm — sometimes punchy, sometimes flowing.

CRITICAL: Never sound like a Wikipedia article or a press release. Never use phrases like "It is worth noting that" or "In today's world" or "As we know". Write like a human who cares about the topic.

Bold ONLY for key terms (2-6 per post). Monospace for commands/filenames.
Links on their own separate lines. Structural symbols (→ × | + ▸ ◆ •) for formatting.
Blockquotes for quoted content and lists.
Never use hype words, AI cliches, or promotional language. But DO be expressive when something is genuinely interesting.`,
  rules: `1. PRESERVE all technical content: GitHub links, docs, downloads, APIs, commands, code, package names.
2. REMOVE spam: promo mentions, "Join/Follow", attribution tags, spam hashtags.
3. FORMAT for readability: bold key terms, quote links and lists, use bullets and symbols.
4. LANGUAGE: auto-detect and preserve. Never translate unless forced.
5. PERSONALITY: be yourself — warm, curious, human. Add a touch of personality when natural. Don't be a robot.
6. If rewrite not needed: don't rewrite. Format only.
7. Each post should feel like it was written by a person who cares — not a template.`,
  formatting: `## Headings (no emoji prefixes). Links on own lines. Commands in code blocks.
Bullets and lists in blockquotes. Footer added by system.`,
  defaultSettings: {
    rewriteMode: "normal",
    personalityMode: "friendly",
    editIntensity: 40,
    emojiLevel: 20,
    languageMode: "auto",
  },
};

export const PROFILES: Record<string, ChannelProfile> = {
  ilivir3: ILIVIR3_PROFILE,
};

export function getProfile(key: string): ChannelProfile {
  return PROFILES[key] ?? ILIVIR3_PROFILE;
}

// ============================================================
// TELEGRAM LIMITS
// ============================================================

export const TELEGRAM_LIMITS = {
  MESSAGE_MAX_LEN: 4096, // visible chars after entity parse
  CAPTION_MAX_LEN: 1024,
  INLINE_KEYBOARD_BUTTONS_PER_ROW: 3,
  MEDIA_GROUP_MAX_ITEMS: 10,
};

// Approval TTL
export const APPROVAL_TTL_MS = 60 * 60 * 1000; // 1 hour

// Media group finalization inactivity window
export const MEDIA_GROUP_WINDOW_MS = 5_000; // 5s after last item

// AI request budget
export const AI_BUDGET = {
  MAX_RETRIES: 2, // max 2 attempts per post (primary + 1 fallback)
  TIMEOUT_MS: 12_000, // reduced from 15s — AI should respond in <10s
  BACKOFF_MS: 500, // reduced from 800ms — faster fallback
};

// ============================================================
// SCHEDULE SYSTEM (task 26)
// ============================================================

/**
 * Allowed values for `Settings.scheduleMessagesPerDay` and
 * `Settings.scheduleIntervalHours`. Any other value is rejected at the
 * callback layer (the keyboards only offer these buttons, and the
 * `set:sched:perday:{n}` / `set:sched:interval:{n}` handlers validate
 * against this list).
 *
 * SCHEDULE_PER_DAY_OPTIONS is capped at 8 (the scheduler divides the day
 * into N equal slots; more than 8 would produce slots < 3h apart which is
 * too frequent for a curated channel). Old stored values of 12/24 are
 * clamped to 8 by the scheduler's Math.min(8, ...) guard.
 */
export const SCHEDULE_PER_DAY_OPTIONS: readonly number[] = [1, 2, 3, 4, 6, 8];
export const SCHEDULE_INTERVAL_OPTIONS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 24];

/** 24-hour window in milliseconds — one scheduling "cycle". */
export const SCHEDULE_CYCLE_MS = 24 * 60 * 60 * 1000;
