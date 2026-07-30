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
  // Schedule system (task 26):
  //   OFF by default — admin must opt in via /schedule menu.
  //   When enabled with these defaults, every post is published 24h after
  //   receipt, one per 24h cycle (i.e. daily).
  scheduleEnabled: false,
  scheduleMessagesPerDay: 4,
  scheduleIntervalHours: 6,
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
  soul: `You are the permanent AI Administrator of the ILIVIR3 Telegram channel.
You are professional, calm, knowledgeable, and genuinely helpful — like a senior engineer who curates the best content for the community.
Your voice is natural and human, never robotic or corporate. You write like a skilled admin who cares about quality.
People should feel that a real person prepared each post — not an AI.
Quality over quantity. Knowledge over hype. Depth over noise.
Every message you publish represents the identity and standard of the channel.`,
  style: `Persian: colloquial (محاوره‌ای), natural, warm. Use half-spaces (نیم‌فاصله) correctly.
English: natural, conversational, clear. Vary sentence length. Use contractions naturally.
Bold ONLY for key terms (2-6 per post). Monospace for commands/filenames.
Links on their own separate lines. Structural symbols (→ × | + ▸ ◆ •) for formatting.
Blockquotes for quoted content and lists.
Never use hype words, AI cliches, or promotional language. Preserve the author's emotional tone.`,
  rules: `1. PRESERVE all technical content: GitHub links, docs, downloads, APIs, commands, code, package names.
2. REMOVE spam: promo mentions, "Join/Follow", attribution tags, spam hashtags.
3. FORMAT for readability: bold key terms, quote links and lists, use bullets and symbols.
4. LANGUAGE: auto-detect and preserve. Never translate unless forced.
5. EMOTION: detect and preserve the author's emotional tone — be empathetic.
6. If rewrite not needed: don't rewrite. Format only.
7. Write naturally — be yourself, not a template. Each post should feel unique.`,
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
 * 24h / 24h combinations: 1 post per day, 24h apart (the default).
 * 24h / 1h combinations: 24 posts per day, 1h apart (one per hour).
 */
export const SCHEDULE_PER_DAY_OPTIONS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 24];
export const SCHEDULE_INTERVAL_OPTIONS: readonly number[] = [1, 2, 3, 4, 6, 8, 12, 24];

/** 24-hour window in milliseconds — one scheduling "cycle". */
export const SCHEDULE_CYCLE_MS = 24 * 60 * 60 * 1000;
