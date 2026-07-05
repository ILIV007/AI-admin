/**
 * src/ai.js
 * Unified AI client with MULTI-MODEL fallback — v0.7.1 (token optimization)
 *
 * v0.7.1 changes (token optimization — NO behavior changes):
 *   - REDUCED maxOutputTokens / max_tokens from 3096 → 2048
 *     (Telegram hard limit is 4096 chars; 2048 tokens ≈ 8000 chars is plenty)
 *   - LIMITED parallel providers to TOP 4 (was up to 11)
 *     Old: top 2 preferred + ALL of other provider + rest of preferred = ~11 racing
 *     New: top 2 preferred + top 2 of other provider = 4 racing
 *     Saves tokens: 7 models no longer consume input tokens before being aborted
 *   - ADDED input truncation: text > 8000 chars → trim to 8000 with marker
 *     Avoids sending massive inputs that produce massive outputs (saves output tokens too)
 *   - TIGHTENED prompts: removed redundant rules, kept all critical ones
 *     Saves ~80 tokens per request on system prompt
 *   - PRESERVED: AbortController (cancels losers), profile support, smart fallback
 *
 * v0.5.9 changes (kept):
 *   - AbortController: when first provider succeeds, all others are ABORTED
 *   - HARD RULE: ONLY use COMPACT_REWRITE_PROMPT / COMPACT_SUMMARIZE_PROMPT
 *   - aiSummarize accepts targetCharLimit to fit Telegram limits
 *   - Static import of profiles (was dynamic — failed in CF Workers bundler)
 *   - Always include BOTH providers as fallback (preferred first)
 *
 * v0.6.4 changes (kept):
 *   - Smart fallback ordering (preferred top 2 → other provider → rest)
 *   - Updated model lists (Gemini 3, Llama 3.3, etc.)
 */

// v0.5.7: STATIC import (dynamic import was failing in Cloudflare Workers bundler)
import { buildProfileEditorPrompt, getProfile } from "../ai/profiles/index.js";

const REQUEST_TIMEOUT_MS = 15_000;

// v0.7.1: Reduced from 3096 → 2048 (still 2x the typical Telegram post size)
const MAX_OUTPUT_TOKENS = 2048;

// v0.7.1: Max parallel providers racing (was unlimited = up to 11)
// Top 2 of preferred + top 2 of other provider = 4 racing max.
// Losers get aborted when winner succeeds, but they still consume input tokens
// before being aborted. Limiting to 4 cuts input token cost by ~60%.
const MAX_PARALLEL_PROVIDERS = 4;

// v0.7.1: Truncate input text to avoid sending massive prompts
const MAX_INPUT_CHARS = 8000;

// ============================================================
// DEFAULT FREE MODELS — v0.6.4 (latest ranked models)
// ============================================================

const GEMINI_MODELS = [
  "gemini-3-flash-preview",
  "gemini-2.5-flash",
  "gemini-3.1-flash-lite-preview",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

const DEFAULT_OPENROUTER_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-120b:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
];

// ============================================================
// SHARED: fetch with AbortController-based timeout
// v0.5.9: Now accepts an EXTERNAL signal (for cancellation when another
// provider wins) and merges it with an internal timeout signal.
// ============================================================

/**
 * Merge two AbortSignals into one. Aborts when EITHER signal aborts.
 * (Native signal merging is available in newer runtimes, but we polyfill
 * for older Cloudflare Workers compatibility.)
 */
function mergeSignals(externalSignal, timeoutMs) {
  const ctrl = new AbortController();

  // If external signal already aborted, abort immediately
  if (externalSignal?.aborted) {
    ctrl.abort();
    return { signal: ctrl.signal, cleanup: () => {} };
  }

  // Listen to external signal
  const onExternalAbort = () => ctrl.abort();
  if (externalSignal) {
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // Internal timeout
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const cleanup = () => {
    clearTimeout(timer);
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  };

  return { signal: ctrl.signal, cleanup };
}

/**
 * Fetch with timeout. Accepts optional external signal for cancellation.
 */
function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS, externalSignal = null) {
  const { signal, cleanup } = mergeSignals(externalSignal, timeoutMs);
  return fetch(url, { ...options, signal })
    .catch((e) => {
      if (e.name === "AbortError") {
        // Distinguish timeout-abort from external-cancel-abort
        if (externalSignal?.aborted) throw new Error("CANCELLED");
        throw new Error(`TIMEOUT ${timeoutMs / 1000}s`);
      }
      throw new Error(`NETWORK: ${e.message}`);
    })
    .finally(cleanup);
}

// ============================================================
// GEMINI complete — v0.5.9: accepts externalSignal for cancellation
// v0.7.1: maxOutputTokens reduced to 2048
// ============================================================
async function geminiComplete(apiKey, model, { system, user, jsonMode = false }, externalSignal = null) {
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      ...(jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, REQUEST_TIMEOUT_MS, externalSignal);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${errText.slice(0, 150)}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  if (!text) throw new Error("EMPTY_RESPONSE");
  return text.trim();
}

// ============================================================
// OPENROUTER complete — v0.5.9: accepts externalSignal for cancellation
// v0.7.1: max_tokens reduced to 2048
// ============================================================
async function openRouterComplete(apiKey, model, { system, user, jsonMode = false }, externalSignal = null) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

  const url = "https://openrouter.ai/api/v1/chat/completions";
  const body = {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    temperature: 0.7,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://ai-admin.workers.dev",
      "X-Title": "AI Admin",
    },
    body: JSON.stringify(body),
  }, REQUEST_TIMEOUT_MS, externalSignal);

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${errText.slice(0, 150)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text || !text.trim()) {
    throw new Error("EMPTY_RESPONSE (200 OK but no content — model may have refused)");
  }
  return text.trim();
}

// ============================================================
// Get the list of OpenRouter models to try
// ============================================================
function getOpenRouterModels(env) {
  if (env.OPENROUTER_FALLBACK_MODELS) {
    const models = env.OPENROUTER_FALLBACK_MODELS.split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length > 0) return models;
  }

  const primary = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODELS[0];
  return [primary, ...DEFAULT_OPENROUTER_MODELS.filter((m) => m !== primary)];
}

// ============================================================
// v0.7.1: Truncate input text if too long
// ============================================================
function truncateInput(text, maxChars = MAX_INPUT_CHARS) {
  if (!text || text.length <= maxChars) return text;
  // Truncate at paragraph boundary if possible
  const cut = text.slice(0, maxChars);
  const lastPara = cut.lastIndexOf("\n\n");
  const safeCut = lastPara > maxChars * 0.7 ? lastPara : maxChars;
  return text.slice(0, safeCut) + "\n\n[... content truncated for length ...]";
}

// ============================================================
// UNIFIED complete() — v0.7.2: TWO-WAVE fallback
// ============================================================
// v0.5.9: AbortController cancels losers when winner succeeds.
//
// v0.7.1 bug: limited to 4 racing providers — if ALL 4 failed
// (e.g. Gemini rate-limited AND top 2 OpenRouter models failed),
// there was NO fallback to the remaining 7 providers. Bot ended up
// format-only even though OpenRouter had 4 more models available.
//
// v0.7.2 fix: TWO-WAVE strategy.
//   Wave 1: Race top 2 preferred + top 2 other = 4 providers (fast, token-efficient).
//   Wave 2: ONLY if Wave 1 all fail, race ALL remaining providers (robust fallback).
// Most requests succeed in Wave 1 (cheap). Only when Wave 1 fails do we
// spend tokens on Wave 2. This preserves v0.7.1's token savings while
// restoring v0.6.11's robust fallback behavior.
//
// Also: explicit warnings when API keys are missing, so the user can
// diagnose "format-only fallback" quickly.
// ============================================================

/**
 * Race a list of providers with Promise.any + shared AbortController.
 * Returns { ok, text, provider, model, ms } on success, or { ok:false, errors } on failure.
 */
async function raceProviders(providers, env, params, label = "wave") {
  if (providers.length === 0) {
    return { ok: false, errors: [], empty: true };
  }

  const winnerController = new AbortController();

  try {
    const result = await Promise.any(
      providers.map(async (p) => {
        const start = Date.now();
        let text;
        try {
          if (p.name === "gemini") {
            text = await geminiComplete(env.GEMINI_API_KEY, p.model, params, winnerController.signal);
          } else {
            text = await openRouterComplete(env.OPENROUTER_API_KEY, p.model, params, winnerController.signal);
          }
        } catch (e) {
          if (e.message === "CANCELLED" || e.message.includes("CANCELLED")) {
            throw new Error("CANCELLED (another provider won)");
          }
          throw e;
        }
        const ms = Date.now() - start;
        console.log(`[AI] ✓ [${label}] ${p.name}/${p.model} OK in ${ms}ms (${text.length} chars) — aborting others`);
        winnerController.abort();
        return { ok: true, text, provider: p.name, model: p.model, ms };
      })
    );
    console.log(`[AI] WINNER [${label}]: ${result.provider}/${result.model}`);
    return result;
  } catch (aggErr) {
    const errors = providers.map((p, i) => {
      const errMsg = aggErr.errors?.[i]?.message || "unknown";
      if (errMsg.includes("CANCELLED")) return { provider: p.name, model: p.model, error: "cancelled" };
      return { provider: p.name, model: p.model, error: errMsg };
    });
    const realErrors = errors.filter((e) => e.error !== "cancelled");
    console.error(`[AI] [${label}] ALL ${providers.length} providers failed (${realErrors.length} real errors):`);
    realErrors.forEach((e) => console.error(`[AI]   ✗ [${label}] ${e.provider}/${e.model}: ${e.error}`));
    return { ok: false, errors: realErrors };
  }
}

export async function aiComplete(env, settings, params) {
  const preferred = settings?.ai_provider || env.DEFAULT_AI_PROVIDER || "openrouter";

  // v0.7.2: Explicit warnings when API keys are missing — helps diagnose
  // "format-only fallback" issues quickly.
  if (!env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY) {
    const errMsg = "No AI providers configured (need GEMINI_API_KEY or OPENROUTER_API_KEY set as secrets)";
    console.error(`[AI] NO PROVIDERS: ${errMsg}`);
    return { ok: false, error: errMsg };
  }
  if (!env.OPENROUTER_API_KEY) {
    console.warn(`[AI] ⚠️ OPENROUTER_API_KEY not set — OpenRouter fallback disabled. If Gemini rate-limits, bot will use format-only.`);
  }
  if (!env.GEMINI_API_KEY) {
    console.warn(`[AI] ⚠️ GEMINI_API_KEY not set — Gemini disabled. Using OpenRouter only.`);
  }

  const geminiProviders = [];
  const openRouterProviders = [];

  // 1. Gemini models — use GEMINI_MODELS list, put env override first
  if (env.GEMINI_API_KEY) {
    const userModel = env.GEMINI_MODEL;
    const geminiModels = userModel && !GEMINI_MODELS.includes(userModel)
      ? [userModel, ...GEMINI_MODELS]
      : GEMINI_MODELS;
    for (const model of geminiModels) {
      geminiProviders.push({ name: "gemini", model });
    }
  }

  // 2. OpenRouter models
  if (env.OPENROUTER_API_KEY) {
    const models = getOpenRouterModels(env);
    for (const model of models) {
      openRouterProviders.push({ name: "openrouter", model });
    }
  }

  // ----- Wave 1: top 2 preferred + top 2 other (max 4, fast) -----
  const wave1 = [];
  if (preferred === "openrouter") {
    wave1.push(...openRouterProviders.slice(0, 2));
    wave1.push(...geminiProviders.slice(0, 2));
  } else {
    // default to gemini preferred
    wave1.push(...geminiProviders.slice(0, 2));
    wave1.push(...openRouterProviders.slice(0, 2));
  }
  const wave1Racing = wave1.slice(0, MAX_PARALLEL_PROVIDERS);

  console.log(`[AI] v0.7.2 Wave 1: racing ${wave1Racing.length} providers (preferred=${preferred}):`);
  wave1Racing.forEach((p) => console.log(`[AI]   - ${p.name}/${p.model}`));

  const wave1Result = await raceProviders(wave1Racing, env, params, "wave1");
  if (wave1Result.ok) {
    return wave1Result;
  }

  // ----- Wave 2: ALL remaining providers (robust fallback) -----
  // v0.7.2: Only reached if Wave 1 all failed. Try every remaining provider.
  const wave1Keys = new Set(wave1Racing.map((p) => `${p.name}/${p.model}`));
  const wave2 = [];
  for (const p of [...geminiProviders, ...openRouterProviders]) {
    if (!wave1Keys.has(`${p.name}/${p.model}`)) {
      wave2.push(p);
    }
  }

  if (wave2.length === 0) {
    console.error(`[AI] Wave 2 empty — no more providers to try`);
    return {
      ok: false,
      error: wave1Result.errors?.length > 0
        ? wave1Result.errors.map((e) => `${e.provider}/${e.model}: ${e.error}`).join(" | ")
        : "All Wave 1 providers failed (no Wave 2 available)",
      details: wave1Result.errors,
    };
  }

  console.warn(`[AI] ⚠️ Wave 1 failed — trying Wave 2 with ${wave2.length} remaining providers:`);
  wave2.forEach((p) => console.warn(`[AI]   - ${p.name}/${p.model}`));

  const wave2Result = await raceProviders(wave2, env, params, "wave2");
  if (wave2Result.ok) {
    return wave2Result;
  }

  // Both waves failed
  const allErrors = [...(wave1Result.errors || []), ...(wave2Result.errors || [])];
  console.error(`[AI] ❌ BOTH WAVES FAILED (${allErrors.length} total errors):`);
  allErrors.forEach((e) => console.error(`[AI]   ✗ ${e.provider}/${e.model}: ${e.error}`));

  return {
    ok: false,
    error: allErrors.length > 0
      ? allErrors.map((e) => `${e.provider}/${e.model}: ${e.error}`).join(" | ")
      : "All providers failed",
    details: allErrors,
  };
}

// ============================================================
// v0.5.5: ULTRA-COMPACT PROMPTS — self-contained, under 800 tokens
// v0.5.9 HARD RULE: ONLY these prompts are sent to the API.
// v0.7.1: Tightened — removed redundant rules, kept all critical ones.
// ============================================================
const COMPACT_REWRITE_PROMPT = `You are a Telegram channel content editor. EDIT the post (do not answer it). Output ONLY the edited version — no preamble.

RULES:
- Keep input language. NEVER translate.
- PRESERVE: GitHub/docs/APIs/commands/code blocks/filenames/versions.
- REMOVE: spam, ads, @channel mentions, "join/follow", attribution lines.
- PRESERVE functional emojis (📚🛠️⚡💡🔒🌐📦) and number emojis (1️⃣2️⃣3️⃣). Remove decorative (🔥😍🎉).
- PRESERVE AI/Midjourney prompts and long technical instructions EXACTLY as-is.
- Output plain text with markdown (**bold**, *italic*, \`code\`, \`\`\`blocks\`\`\`).
- No footer, no explanations, no HTML tags.
- Each URL on its own line.
- NEVER start with "Here is" / "Sure" / "I'll" — output the edited post directly.
- PRESERVE paragraph structure and blank lines between sections.`;

const COMPACT_SUMMARIZE_PROMPT = `You are a Telegram channel content editor. The post is too long — TRIM it (don't bullet-summarize).

RULES:
- Keep input language. NEVER translate.
- PRESERVE EVERY URL, link, download link, code block, command.
- Remove only: redundancy, fluff, repetition, filler.
- Output: 80-90% of original length (NOT 30-50%).
- Keep structure and flow.
- Output plain text with markdown. No HTML, no footer.`;

function buildCompactPrompt(mode) {
  return mode === "summary" ? COMPACT_SUMMARIZE_PROMPT : COMPACT_REWRITE_PROMPT;
}

// ============================================================
// REWRITE — v0.5.9: ONLY use compact prompt (never buildEditorPrompt)
// v0.7.1: Truncate input if > 8000 chars
// ============================================================
export async function aiRewrite(env, settings, text, mode, language, personality, editIntensity, emojiLevel) {
  // v0.5.9 HARD RULE: Only COMPACT_REWRITE_PROMPT (+ optional profile addendum)
  let fullSystemPrompt;
  if (settings.active_profile) {
    // Profile addendum is small (~200 tokens), keeps total under 800
    const pp = buildProfileEditorPrompt(buildCompactPrompt("rewrite"), settings.active_profile);
    fullSystemPrompt = pp || buildCompactPrompt("rewrite");
  } else {
    fullSystemPrompt = buildCompactPrompt("rewrite");
  }

  const profile = settings.active_profile ? getProfile(settings.active_profile) : null;
  const effMode = profile ? profile.settings.rewrite_mode : mode;
  const effPersonality = profile ? profile.settings.personality_mode : personality;

  const personalityGuide = {
    friendly: "Write like a REAL HUMAN. Conversational. Use contractions. For Persian: محاوره‌ای.",
    professional: "Clean, neutral, business-like.",
    technical: "Precise, terminology-friendly.",
    news: "Concise, fact-first.",
  };

  // v0.7.1: Truncate input to avoid sending massive prompts
  const safeText = truncateInput(text);

  const userMsg = [
    `REWRITE_MODE: ${effMode}`,
    `LANGUAGE_MODE: ${language}`,
    `PERSONALITY: ${effPersonality} (${personalityGuide[effPersonality] || personalityGuide.friendly})`,
    ``,
    `POST TO PROCESS:`,
    `----`,
    safeText,
    `----`,
    ``,
    `Return ONLY the edited text in the SAME language.`,
  ].join("\n");

  const res = await aiComplete(env, settings, {
    system: fullSystemPrompt,
    user: userMsg,
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider, model: res.model };
}

// ============================================================
// SUMMARIZE — v0.5.9: accepts targetCharLimit to fit Telegram limits
// v0.7.1: Truncate input if > 8000 chars (summarize is for long posts)
// ============================================================
export async function aiSummarize(env, settings, text, language, targetCharLimit = 3500) {
  let fullSystemPrompt;
  if (settings.active_profile) {
    const pp = buildProfileEditorPrompt(buildCompactPrompt("summary"), settings.active_profile);
    fullSystemPrompt = pp || buildCompactPrompt("summary");
  } else {
    fullSystemPrompt = buildCompactPrompt("summary");
  }

  // v0.7.1: Truncate input — summarize is called for long posts,
  // so input can be 4000-12000 chars. Limit to 8000 to control token cost.
  const safeText = truncateInput(text);

  // Tell the AI the EXACT target character limit so output fits Telegram
  const userMsg = [
    `LANGUAGE_MODE: ${language}`,
    `TARGET: Fit the output within ${targetCharLimit} characters (including spaces).`,
    `This is a HARD LIMIT — the output MUST be under ${targetCharLimit} chars.`,
    ``,
    `POST TO TRIM (too long for Telegram — current length: ${text.length} chars):`,
    `----`,
    safeText,
    `----`,
    ``,
    `Return ONLY the trimmed text. Keep ALL links and code blocks. Remove redundancy and fluff.`,
    `The output MUST be under ${targetCharLimit} characters.`,
  ].join("\n");

  const res = await aiComplete(env, settings, {
    system: fullSystemPrompt,
    user: userMsg,
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider, model: res.model };
}

// ============================================================
// Export for debug dashboard
// ============================================================
export { DEFAULT_OPENROUTER_MODELS, getOpenRouterModels };
