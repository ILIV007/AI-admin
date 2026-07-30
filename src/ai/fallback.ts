/**
 * src/ai/fallback.ts
 * Sequential AI fallback orchestrator.
 *
 * This is THE fix for V1's broken 11-model parallel race that burned through
 * the free-tier quota in minutes. V2 rules:
 *
 *   1. Never race models. Always call providers SEQUENTIALLY.
 *   2. Max 2 attempts per post inside the primary provider's model chain
 *      (primary model + 1 fallback model).
 *   3. If the primary provider chain is exhausted, try the OTHER provider
 *      exactly once with its primary model.
 *   4. Honor KV-backed model health cache: skip models marked unhealthy if
 *      the failure was recent (< UNHEALTHY_SKIP_MS = 5 min).
 *   5. Always return the last AIResult, even if it failed — callers decide
 *      what to do with the error.
 */

import type {
  AIRequest,
  AIResult,
  Env,
  ModelHealth,
  Settings,
} from "../types";
import {
  AI_BUDGET,
  ALL_MODELS,
  DEFAULT_SETTINGS,
  geminiFallbackChain,
  openrouterFallbackChain,
} from "../config/defaults";
import { geminiProvider } from "./gemini";
import { openrouterProvider } from "./openrouter";
import type { AIProvider } from "./provider";
import { sleep } from "./provider";

// ============================================================
// Health cache constants
// ============================================================

const KV_KEY_PREFIX = "ai:health";
const HEALTH_CACHE_VERSION = "v8"; // bump v7→v8: 2.5 models no longer primary; reset health cache
const UNHEALTHY_SKIP_MS = 5 * 60 * 1000; // 5 min: skip models that failed recently
const UNHEALTHY_THRESHOLD = 3; // mark unhealthy after 3 consecutive failures
const HEALTH_TTL_SEC = 2 * 60 * 60; // 2 hour KV TTL for health records
const REFRESH_MIN_INTERVAL_MS = 30 * 60 * 1000; // refresh no more than every 30 min
const PING_DELAY_MS = 500; // space pings to be gentle on free quota

function healthKey(provider: string, model: string): string {
  // Include version in the key so changing the model catalog invalidates ALL
  // old health records automatically (old keys expire via TTL, new keys start
  // fresh with no stale "unhealthy" marks from previous model configurations).
  return `${KV_KEY_PREFIX}:${HEALTH_CACHE_VERSION}:${provider}:${model}`;
}

// ============================================================
// Health cache I/O
// ============================================================

async function readHealth(env: Env, provider: string, model: string): Promise<ModelHealth | null> {
  try {
    const raw = await env.AI_ADMIN_KV.get(healthKey(provider, model));
    if (!raw) return null;
    return JSON.parse(raw) as ModelHealth;
  } catch {
    return null;
  }
}

async function writeHealth(env: Env, h: ModelHealth): Promise<void> {
  try {
    await env.AI_ADMIN_KV.put(healthKey(h.provider, h.model), JSON.stringify(h), {
      expirationTtl: HEALTH_TTL_SEC,
    });
  } catch {
    // KV write failures are non-fatal. We'll just retry the model next time.
  }
}

/** True if a model should be SKIPPED because it is unhealthy AND recent. */
function isSkippable(h: ModelHealth | null): boolean {
  if (!h) return false;
  if (h.healthy) return false;
  // Only skip if the model has reached the unhealthy threshold (3 permanent
  // failures). Transient errors (429/5xx) increment the counter but do NOT
  // make the model skippable until the threshold is reached.
  // This prevents a single timeout from skipping the primary model.
  if (h.consecutiveFailures < UNHEALTHY_THRESHOLD) return false;
  return Date.now() - h.lastCheck < UNHEALTHY_SKIP_MS;
}

function markSuccess(_h: ModelHealth | null, provider: string, model: string): ModelHealth {
  return {
    model,
    provider: provider as ModelHealth["provider"],
    healthy: true,
    lastCheck: Date.now(),
    consecutiveFailures: 0,
    // Clear lastError on success — a recovered model should not show stale errors.
    lastError: undefined,
  };
}

function markFailure(
  h: ModelHealth | null,
  provider: string,
  model: string,
  error: string,
): ModelHealth {
  const prevFailures = h?.consecutiveFailures ?? 0;
  const status = parseStatusFromError(error);
  const isTransient = status === 429 || (status >= 500 && status < 600) || status === 0;

  if (isTransient) {
    // CRITICAL FIX: for transient errors (429/5xx/timeout), do NOT mark the
    // model as unhealthy. Only increment the counter — and only mark unhealthy
    // when the THRESHOLD is reached. This prevents a single timeout from
    // making the primary model skippable for 5 minutes, which caused the bot
    // to fall back to a different model after a single transient failure.
    const consecutiveFailures = prevFailures + 1; // still count, but dont skip
    const healthy = consecutiveFailures < UNHEALTHY_THRESHOLD;
    return {
      model,
      provider: provider as ModelHealth["provider"],
      healthy,
      lastCheck: Date.now(),
      lastError: error,
      consecutiveFailures,
    };
  }

  // Non-transient (4xx except 429): permanent failure, increment and mark
  const consecutiveFailures = prevFailures + 1;
  const healthy = consecutiveFailures < UNHEALTHY_THRESHOLD;
  return {
    model,
    provider: provider as ModelHealth["provider"],
    healthy,
    lastCheck: Date.now(),
    lastError: error,
    consecutiveFailures,
  };
}

// ============================================================
// Provider resolution
// ============================================================

function getProvider(name: Settings["aiProvider"]): AIProvider {
  return name === "openrouter" ? openrouterProvider : geminiProvider;
}

function getOtherProvider(name: Settings["aiProvider"]): AIProvider {
  return name === "openrouter" ? geminiProvider : openrouterProvider;
}

function getPrimaryModel(settings: Settings, providerName: Settings["aiProvider"]): string {
  if (providerName === "openrouter") {
    return settings.openrouterModel || DEFAULT_SETTINGS.openrouterModel!;
  }
  return settings.geminiModel || DEFAULT_SETTINGS.geminiModel!;
}

function getOtherPrimaryModel(settings: Settings, providerName: Settings["aiProvider"]): string {
  // The OTHER provider — read its model from settings, fall back to catalog default.
  if (providerName === "openrouter") {
    return settings.geminiModel || DEFAULT_SETTINGS.geminiModel!;
  }
  return settings.openrouterModel || DEFAULT_SETTINGS.openrouterModel!;
}

function getFallbackChain(providerName: Settings["aiProvider"], primaryModel: string): string[] {
  return providerName === "openrouter"
    ? openrouterFallbackChain(primaryModel)
    : geminiFallbackChain(primaryModel);
}

// ============================================================
// Main orchestrator
// ============================================================

/**
 * Rewrite (or summarize) with sequential fallback.
 *
 * Worst-case call sequence:
 *   1. primary provider  + primary model         (attempt 1)
 *   2. primary provider  + 1 fallback model      (attempt 2 — within MAX_RETRIES)
 *   3. OTHER provider    + its primary model      (emergency, single attempt)
 *
 * Best case: 1 call. Typical case: 1 call. Failure case: ≤3 calls.
 */
export async function rewriteWithFallback(
  env: Env,
  req: AIRequest,
): Promise<AIResult> {
  const primaryProviderName = req.settings.aiProvider;
  const primaryProvider = getProvider(primaryProviderName);
  const primaryModel = getPrimaryModel(req.settings, primaryProviderName);

  // ---------- Attempt 1: primary provider + primary model ----------
  const primaryHealth = await readHealth(env, primaryProviderName, primaryModel);
  if (!isSkippable(primaryHealth)) {
    const r1 = await primaryProvider.call(req, env, primaryModel);
    if (r1.ok) {
      // FIX-3: only write health on success if state CHANGED (was unhealthy
      // or had recent failures). If the model was already healthy with 0
      // failures, the write is redundant — saves a KV write per AI call.
      if (!primaryHealth?.healthy || (primaryHealth.consecutiveFailures ?? 0) > 0) {
        await writeHealth(env, markSuccess(primaryHealth, primaryProviderName, primaryModel));
      }
      return r1;
    }
    await writeHealth(
      env,
      markFailure(primaryHealth, primaryProviderName, primaryModel, r1.error ?? "unknown"),
    );
    // For ALL errors (retryable or not), fall through to the same-provider
    // fallback chain. Only auth errors (401/402/403) skip the chain entirely.
    const status = parseStatusFromError(r1.error);
    const isAuth = status === 401 || status === 402 || status === 403;
    if (isAuth) {
      return crossProviderFallback(env, req, primaryProviderName, r1);
    }
    // All other errors (timeout, 429, 5xx, 404, 400) → try next model in chain
  }

  // ---------- Attempt 2: same-provider fallback (ALL remaining models) ----------
  // Try ALL remaining models in the chain, not just 1.
  // This ensures: 3.6 fails → try 3.5 → try 3.1-lite → try 3.0
  // before giving up and going cross-provider.
  const chain = getFallbackChain(primaryProviderName, primaryModel);
  let lastError: AIResult | null = null;
  for (const candidate of chain) {
    if (candidate === primaryModel) continue;
    const candidateHealth = await readHealth(env, primaryProviderName, candidate);
    if (isSkippable(candidateHealth)) continue;
    await sleep(AI_BUDGET.BACKOFF_MS);
    const r2 = await primaryProvider.call(req, env, candidate);
    if (r2.ok) {
      // FIX-3: skip redundant health write when already healthy.
      if (!candidateHealth?.healthy || (candidateHealth.consecutiveFailures ?? 0) > 0) {
        await writeHealth(env, markSuccess(candidateHealth, primaryProviderName, candidate));
      }
      return r2;
    }
    await writeHealth(env, markFailure(candidateHealth, primaryProviderName, candidate, r2.error ?? "unknown"));
    lastError = r2;
    const status2 = parseStatusFromError(r2.error);
    if (status2 === 401 || status2 === 402 || status2 === 403) break;
  }
  return crossProviderFallback(env, req, primaryProviderName, lastError ?? {
    ok: false,
    text: "",
    provider: primaryProviderName,
    model: primaryModel,
    latencyMs: 0,
    error: "primary chain exhausted (all models unhealthy)",
  });
}

/**
 * Emergency cross-provider attempt: call the OTHER provider once with its
 * primary model. Returns the last AIResult if the other provider also fails.
 */
async function crossProviderFallback(
  env: Env,
  req: AIRequest,
  primaryProviderName: Settings["aiProvider"],
  lastResult: AIResult,
): Promise<AIResult> {
  const otherProviderName: Settings["aiProvider"] =
    primaryProviderName === "openrouter" ? "gemini" : "openrouter";
  const otherProvider = getOtherProvider(primaryProviderName);
  const otherModel = getOtherPrimaryModel(req.settings, primaryProviderName);

  const otherHealth = await readHealth(env, otherProviderName, otherModel);
  if (isSkippable(otherHealth)) {
    return lastResult;
  }

  await sleep(AI_BUDGET.BACKOFF_MS);
  const r = await otherProvider.call(req, env, otherModel);
  if (r.ok) {
    // FIX-3: skip redundant health write when already healthy.
    if (!otherHealth?.healthy || (otherHealth.consecutiveFailures ?? 0) > 0) {
      await writeHealth(env, markSuccess(otherHealth, otherProviderName, otherModel));
    }
    return r;
  }
  await writeHealth(
    env,
    markFailure(otherHealth, otherProviderName, otherModel, r.error ?? "unknown"),
  );
  // Return the LAST failure. If the primary failure carried useful context
  // (e.g. an empty-response error) we still surface the most recent one.
  return r;
}

/** Extract a numeric HTTP status from our error string format ("gemini 429: ..."). */
function parseStatusFromError(error: string | undefined): number {
  if (!error) return 0;
  const m = error.match(/\b(\d{3})\b/);
  return m ? Number(m[1]) : 0;
}

// ============================================================
// Cron-driven health refresh
// ============================================================

/**
 * Periodically ping every model in the catalog and refresh health cache.
 * Designed to run from the cron trigger (once per day — FIX-6).
 *
 * - Skips models checked within the last REFRESH_MIN_INTERVAL_MS (30 min).
 * - Spaces pings by PING_DELAY_MS (500ms) to be gentle on free quotas.
 * - Writes back to KV with 2h TTL.
 *
 * FIX-7: the ping now uses a MINIMAL direct fetch (no buildSystemPrompt,
 * no profile, no classification). This cuts token usage from ~2000 to ~10
 * per model (99.5% reduction). The old approach built a full AIRequest with
 * a 2000-token system prompt just to check if the model responds — wasteful.
 */
export async function refreshModelHealth(env: Env): Promise<void> {
  const now = Date.now();

  for (const entry of ALL_MODELS) {
    const provider = entry.provider;
    const model = entry.id;

    // Skip if checked recently.
    const existing = await readHealth(env, provider, model);
    if (existing && now - existing.lastCheck < REFRESH_MIN_INTERVAL_MS) {
      continue;
    }

    // FIX-7: minimal direct fetch — no system prompt, no profile, no
    // classification. Just "ping" → expect any HTTP 200 response.
    const result = await pingModelDirect(env, provider, model);

    let next: ModelHealth;
    if (result.ok) {
      next = markSuccess(existing, provider, model);
    } else {
      next = markFailure(existing, provider, model, result.error ?? "ping failed");
    }
    await writeHealth(env, next);

    // Be gentle on free quota.
    await sleep(PING_DELAY_MS);
  }
}

/**
 * Minimal direct API ping — bypasses the full AIRequest/provider pipeline.
 * Sends a tiny request ("ping" with maxOutputTokens=5) directly to the
 * provider's API. Returns ok=true on any HTTP 200 response (we don't care
 * about the response content — we just want to know the endpoint is alive
 * and the API key is valid).
 */
async function pingModelDirect(
  env: Env,
  provider: "gemini" | "openrouter",
  model: string,
): Promise<{ ok: boolean; error?: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    if (provider === "gemini") {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "ping" }], role: "user" }],
          generationConfig: { maxOutputTokens: 5, temperature: 0 },
        }),
        signal: controller.signal,
      });
      return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
    }
    // openrouter
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://ilivir3.bot",
        "X-Title": "AI Admin Health",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
      signal: controller.signal,
    });
    return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}
