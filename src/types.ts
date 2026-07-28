/**
 * src/types.ts
 * Shared types for AI Admin V2.
 * This file is the CONTRACT between all modules. Every agent must implement
 * against these types exactly.
 */

// ============================================================
// Environment / Worker bindings
// ============================================================

export interface Env {
  // Secrets (required)
  BOT_TOKEN: string;
  WEBHOOK_SECRET?: string; // OPTIONAL — if set, webhook validates secret; if unset, accepts all
  GEMINI_API_KEY: string;
  OPENROUTER_API_KEY: string;

  // Vars
  ADMIN_ID: string; // numeric Telegram ID of the OWNER
  TARGET_CHANNEL: string; // @channel or -100xxx
  FOOTER_TEXT?: string;
  DEFAULT_AI_PROVIDER?: "gemini" | "openrouter";
  GEMINI_MODEL?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_FALLBACK_MODELS?: string; // comma-separated
  DEBUG_MODE?: string; // "true" | "false"
  DEBUG_TOKEN?: string; // bearer token for /debug routes
  CHANNEL_PROFILE?: string; // default "ilivir3"

  // Bindings
  DB: D1Database;
  AI_ADMIN_KV: KVNamespace;
  QUEUE: Queue<QueueMessage>;
}

export type QueueMessage =
  | { kind: "process_update"; update: TelegramUpdate; receivedAt: number }
  | { kind: "finalize_media_group"; mediaGroupId: string; receivedAt: number }
  | { kind: "publish_scheduled"; jobId: string }
  | { kind: "retry_publish"; jobId: string; attempt: number };

// ============================================================
// Telegram Update model (subset we care about)
// ============================================================

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: {
    id: number;
    type: "private" | "group" | "supergroup" | "channel";
    title?: string;
    username?: string;
  };
  from?: TelegramUser;
  sender_chat?: { id: number; title?: string; username?: string };
  text?: string;
  caption?: string;
  entities?: TelegramEntity[];
  caption_entities?: TelegramEntity[];
  media_group_id?: string;
  photo?: { file_id: string; file_unique_id: string; width: number; height: number }[];
  video?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number };
  document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string };
  animation?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number };
  reply_to_message?: TelegramMessage;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramEntity {
  type: string; // "bold","italic","code","pre","url","text_link","mention", etc.
  offset: number;
  length: number;
  url?: string;
  language?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

// ============================================================
// Content extraction
// ============================================================

export type MediaType = "photo" | "video" | "document" | "animation";

export interface ExtractedContent {
  fromId: number | null;
  fromName: string;
  chatId: number;
  chatType: string;
  messageId: number;
  text: string; // message text OR caption
  entities: TelegramEntity[];
  media?: { type: MediaType; fileId: string; fileName?: string; mimeType?: string };
  mediaGroupId?: string;
  isChannelPost: boolean;
  isEdit: boolean;
  replyToText?: string;
}

// ============================================================
// Roles & authz
// ============================================================

export type Role = "owner" | "editor" | "reviewer" | "viewer";

export interface AdminRecord {
  userId: number;
  username?: string;
  firstName?: string;
  role: Role;
  addedAt: number;
  addedBy: number;
}

// ============================================================
// Settings (per-user overrides + global defaults)
// ============================================================

export type RewriteMode = "none" | "light" | "normal" | "aggressive";
export type PersonalityMode = "friendly" | "professional" | "neutral";
export type LanguageMode = "auto" | "fa" | "en";

export interface Settings {
  rewriteMode: RewriteMode;
  personalityMode: PersonalityMode;
  editIntensity: number; // 0-100
  emojiLevel: number; // 0-100
  languageMode: LanguageMode;
  approvalMode: boolean;
  channelEditing: boolean;
  footerText: string;
  aiProvider: "gemini" | "openrouter";
  geminiModel: string;
  openrouterModel: string;
  profile: string; // channel profile key
  /**
   * UI language — controls bot-facing messages (command responses, menus,
   * errors, etc.). SEPARATE from `languageMode` which controls AI output
   * language. Optional so older stored settings rows still parse; the
   * settings repo merges `DEFAULT_SETTINGS.uiLanguage` ("en") when missing.
   */
  uiLanguage?: "en" | "fa";

  /**
   * Schedule system (task 26).
   *
   * When `scheduleEnabled` is true, the pipeline does NOT publish admin
   * posts immediately. Instead it stores a `scheduled_post` job in D1 with
   * `scheduled_for` = the computed next slot. The cron (every minute) picks
   * up due jobs and publishes them via the queue.
   *
   *   scheduleMessagesPerDay : max posts per 24h cycle (1,2,3,4,6,8,12,24).
   *   scheduleIntervalHours  : hours between posts (1,2,3,4,6,8,12,24).
   *
   * Default = "24h after received, one post per day, spaced 24h apart".
   *
   * All three fields are optional so older stored settings rows still parse;
   * the settings repo merges DEFAULT_SETTINGS when missing.
   */
  scheduleEnabled?: boolean;
  scheduleMessagesPerDay?: number;
  scheduleIntervalHours?: number;
}

// ============================================================
// Classification (deterministic, rule-based)
// ============================================================

export type ContentCategory =
  | "code"
  | "github"
  | "news"
  | "tutorial"
  | "tool"
  | "cybersecurity"
  | "ai"
  | "hardware"
  | "general";

export interface Classification {
  category: ContentCategory;
  language: "fa" | "en" | "auto";
  hasCode: boolean;
  hasGithubLink: boolean;
  hasLongText: boolean; // > 800 chars
  wordCount: number;
  recommendedRewrite: RewriteMode;
  recommendedNeedsRewrite: boolean;
}

// ============================================================
// AI
// ============================================================

export interface AIRequest {
  text: string;
  classification: Classification;
  settings: Settings;
  profile: ChannelProfile;
  mode: "rewrite" | "summarize";
}

export interface AIResult {
  ok: boolean;
  text: string; // rewritten/summarized text (plain markdown, NOT html)
  provider: string;
  model: string;
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
}

export interface ChannelProfile {
  key: string;
  name: string;
  description: string;
  soul: string;
  style: string;
  rules: string;
  formatting: string;
  defaultSettings: Partial<Settings>;
}

export interface ModelHealth {
  model: string;
  provider: "gemini" | "openrouter";
  healthy: boolean;
  lastCheck: number;
  lastError?: string;
  consecutiveFailures: number;
}

// ============================================================
// Formatting — block-based intermediate representation
// ============================================================

export type ContentBlock =
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "heading"; level: 2 | 3; spans: Span[] }
  | { kind: "code"; language?: string; code: string }
  | { kind: "quote"; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "divider" };

export type Span =
  | { kind: "text"; text: string }
  | { kind: "bold"; spans: Span[] }
  | { kind: "italic"; spans: Span[] }
  | { kind: "underline"; spans: Span[] }
  | { kind: "strikethrough"; spans: Span[] }
  | { kind: "spoiler"; spans: Span[] }
  | { kind: "code"; code: string }
  | { kind: "link"; text: string; url: string }
  | { kind: "mention"; text: string; userId?: number };

// ============================================================
// Jobs (scheduled posts + approvals)
// ============================================================

export type JobType = "scheduled_post" | "approval";
export type JobStatus =
  | "pending"
  | "published"
  | "rejected"
  | "expired"
  | "failed";

export interface JobRecord {
  id: string;
  type: JobType;
  status: JobStatus;
  userId: number;
  chatId: number;
  messageId: number;
  payload: string; // JSON: { html, media, footer, parts, scheduledFor? }
  scheduledFor: number | null; // epoch ms
  createdAt: number;
  updatedAt: number;
  publishedMessageId: number | null;
  publishedChatId: number | null;
  errorMessage?: string;
  attempts: number;
}

// ============================================================
// Stats
// ============================================================

export interface Stats {
  totalReceived: number;
  totalPublished: number;
  totalRewritten: number;
  totalFailed: number;
  totalApprovals: number;
  totalRejected: number;
  totalScheduled: number;
  aiCalls: number;
  aiFailures: number;
  lastUpdated: number;
}

// ============================================================
// Pipeline result
// ============================================================

export interface PipelineResult {
  ok: boolean;
  action: "published" | "preview" | "format_only" | "skipped" | "failed" | "scheduled";
  html: string;
  parts: string[]; // for multi-part posts
  media?: ExtractedContent["media"];
  classification: Classification;
  aiUsed: boolean;
  aiProvider?: string;
  aiModel?: string;
  jobId?: string;
  /**
   * Epoch ms the post was scheduled for. Populated only when
   * action === "scheduled". The consumer uses this to render the
   * "📅 Scheduled for {time}" reply to the admin.
   */
  scheduledFor?: number;
  errorMessage?: string;
}

// ============================================================
// Media Group
// ============================================================

export interface MediaGroupItem {
  mediaGroupId: string;
  messageId: number;
  chatId: number;
  fromId: number;
  text: string;
  media: ExtractedContent["media"];
  receivedAt: number;
  finalized: number; // 0 = not finalized
}
