/**
 * src/ai/provider.ts
 * Shared AI provider interface + retry / timeout helpers.
 *
 * Every concrete provider (gemini, openrouter) implements `AIProvider`.
 * The fallback orchestrator (fallback.ts) consumes providers through this
 * interface so we can add new ones without touching the orchestrator.
 */

import type { AIRequest, AIResult, Env } from "../types";

// ============================================================
// Provider interface
// ============================================================

export interface AIProvider {
  /** Stable provider name, e.g. "gemini" | "openrouter". */
  name: string;
  /** Execute a single AI request. Never retries internally (except where the
   *  provider's own contract requires it, e.g. OpenRouter 429 once). */
  call(req: AIRequest, env: Env, modelOverride?: string): Promise<AIResult>;
}

// ============================================================
// Retry helpers
// ============================================================

/** HTTP status codes that are worth retrying on a different/again model. */
export function isRetryableError(status: number): boolean {
  // Network-level (0 = fetch threw) is also retryable.
  if (status === 0) return true;
  return (
    status === 408 || // Request Timeout
    status === 429 || // Too Many Requests
    status === 500 || // Internal Server Error
    status === 502 || // Bad Gateway
    status === 503 || // Service Unavailable
    status === 504    // Gateway Timeout
  );
}

/**
 * Parse a `Retry-After` header. May be either:
 *  - an integer number of seconds, OR
 *  - an HTTP-date.
 * We always return seconds. Cap at 30s so we stay inside the Worker budget.
 * Returns 0 if the header is missing or unparseable.
 */
export function parseRetryAfter(headers: Headers): number {
  const raw = headers.get("retry-after");
  if (!raw) return 0;
  const trimmed = raw.trim();

  // Integer seconds?
  const asNum = Number(trimmed);
  if (Number.isFinite(asNum) && asNum >= 0) {
    return Math.min(30, Math.floor(asNum));
  }

  // HTTP-date?
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const seconds = Math.ceil((asDate - Date.now()) / 1000);
    if (seconds > 0) return Math.min(30, seconds);
    return 0;
  }

  return 0;
}

/** Promise-based sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a fetch with an AbortController timeout.
 * Resolves to either the Response or `null` if it timed out.
 * Never throws — callers handle null/!ok explicitly.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // AbortError → timed out. Any other network error → also null.
    // Callers will surface a synthetic error.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// Shared result builders
// ============================================================

export function okResult(
  provider: string,
  model: string,
  text: string,
  startedAt: number,
  tokensIn?: number,
  tokensOut?: number,
): AIResult {
  return {
    ok: true,
    text,
    provider,
    model,
    latencyMs: Date.now() - startedAt,
    tokensIn,
    tokensOut,
  };
}

export function errResult(
  provider: string,
  model: string,
  error: string,
  startedAt: number,
): AIResult {
  return {
    ok: false,
    text: "",
    provider,
    model,
    latencyMs: Date.now() - startedAt,
    error,
  };
}
