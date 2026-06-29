/**
 * src/ai.js
 * Unified AI client with multi-model fallback, AbortSignal propagation, and retry logic.
 * v0.5.0 — Refactored: signal passing, provider filtering, retry on transient errors, better AggregateError handling.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 1;

const DEFAULT_OPENROUTER_MODELS = [
  "nvidia/nemotron-3-nano-30b-a3b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free",
  "meta-llama/llama-3.2-3b-instruct:free",
  "poolside/laguna-m.1:free",
];

// ============================================================
// SHARED: fetch with AbortController-based timeout + external signal
// ============================================================
function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS, externalSignal = null) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  // If external signal is provided, abort when either timeout or external fires
  if (externalSignal) {
    externalSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  return fetch(url, { ...options, signal: ctrl.signal })
    .catch((e) => {
      if (e.name === "AbortError") throw new Error(`TIMEOUT ${timeoutMs / 1000}s`);
      throw new Error(`NETWORK: ${e.message}`);
    })
    .finally(() => clearTimeout(t));
}

// ============================================================
// GEMINI complete with retry on transient errors
// ============================================================
async function geminiComplete(apiKey, model, { system, user, jsonMode = false }, signal = null, retryCount = 0) {
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.7,
      topP: 0.9,
      maxOutputTokens: 2048,
      ...(jsonMode ? { responseMimeType: "application/json" } : {}),
    },
  };

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, REQUEST_TIMEOUT_MS, signal);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // Retry on transient errors (502, 503, 504)
      if (retryCount < MAX_RETRIES && [502, 503, 504].includes(res.status)) {
        console.warn(`[AI] Gemini ${model} ${res.status}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, 1000));
        return geminiComplete(apiKey, model, { system, user, jsonMode }, signal, retryCount + 1);
      }
      throw new Error(`${res.status}: ${errText.slice(0, 150)}`);
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    if (!text) throw new Error("EMPTY_RESPONSE");
    return text.trim();
  } catch (e) {
    if (e.name === "AbortError" || e.message.includes("TIMEOUT")) throw e;
    throw e;
  }
}

// ============================================================
// OPENROUTER complete with retry on transient errors
// ============================================================
async function openRouterComplete(apiKey, model, { system, user, jsonMode = false }, signal = null, retryCount = 0) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing");

  const url = "https://openrouter.ai/api/v1/chat/completions";
  const body = {
    model,
    messages: [
      ...(system ? [{ role: "system", content: system }] : []),
      { role: "user", content: user },
    ],
    temperature: 0.7,
    max_tokens: 2048,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": "https://ai-admin.workers.dev",
        "X-Title": "AI Admin",
      },
      body: JSON.stringify(body),
    }, REQUEST_TIMEOUT_MS, signal);

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      // Retry on transient errors
      if (retryCount < MAX_RETRIES && [502, 503, 504].includes(res.status)) {
        console.warn(`[AI] OpenRouter ${model} ${res.status}, retrying (${retryCount + 1}/${MAX_RETRIES})...`);
        await new Promise(r => setTimeout(r, 1000));
        return openRouterComplete(apiKey, model, { system, user, jsonMode }, signal, retryCount + 1);
      }
      throw new Error(`${res.status}: ${errText.slice(0, 150)}`);
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    if (!text || !text.trim()) {
      const finishReason = data?.choices?.[0]?.finish_reason || "unknown";
      throw new Error(`EMPTY_RESPONSE (finish_reason: ${finishReason})`);
    }
    return text.trim();
  } catch (e) {
    if (e.name === "AbortError" || e.message.includes("TIMEOUT")) throw e;
    throw e;
  }
}

// ============================================================
// Get OpenRouter models list
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
// UNIFIED complete() — races providers in parallel with signal propagation
// ============================================================
export async function aiComplete(env, settings, params, signal = null) {
  const providers = [];

  // Filter providers based on settings.ai_provider
  const allowedProvider = settings?.ai_provider;

  // 1. Gemini models
  if (env.GEMINI_API_KEY && (!allowedProvider || allowedProvider === "gemini" || allowedProvider === "auto")) {
    const geminiModels = [
      env.GEMINI_MODEL || "gemini-2.5-flash",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ];
    const uniqueGeminiModels = [...new Set(geminiModels)];
    for (const model of uniqueGeminiModels) {
      providers.push({
        name: "gemini",
        model: model,
        complete: () => geminiComplete(env.GEMINI_API_KEY, model, params, signal),
      });
    }
  }

  // 2. OpenRouter models
  if (env.OPENROUTER_API_KEY && (!allowedProvider || allowedProvider === "openrouter" || allowedProvider === "auto")) {
    const models = getOpenRouterModels(env);
    for (const model of models) {
      providers.push({
        name: "openrouter",
        model: model,
        complete: () => openRouterComplete(env.OPENROUTER_API_KEY, model, params, signal),
      });
    }
  }

  if (providers.length === 0) {
    return { ok: false, error: "No AI providers configured (need GEMINI_API_KEY or OPENROUTER_API_KEY)" };
  }

  console.log(`[AI] racing ${providers.length} providers:`);
  providers.forEach((p) => console.log(`[AI]   - ${p.name}/${p.model}`));

  try {
    const result = await Promise.any(
      providers.map(async (p) => {
        const start = Date.now();
        const text = await p.complete();
        const ms = Date.now() - start;
        console.log(`[AI] ✓ ${p.name}/${p.model} OK in ${ms}ms (${text.length} chars)`);
        return { ok: true, text, provider: p.name, model: p.model, ms };
      })
    );
    console.log(`[AI] WINNER: ${result.provider}/${result.model}`);
    return result;
  } catch (aggErr) {
    // Better AggregateError handling
    const errors = aggErr.errors?.map((e, i) => ({
      provider: providers[i]?.name || "unknown",
      model: providers[i]?.model || "unknown",
      error: e?.message || "unknown",
      type: e?.message?.includes("TIMEOUT") ? "TIMEOUT" : 
            e?.message?.includes("EMPTY") ? "EMPTY" :
            e?.message?.includes("429") ? "RATE_LIMIT" : "ERROR",
    })) || [{ provider: "unknown", model: "unknown", error: aggErr.message || "unknown" }];

    console.error(`[AI] ALL ${providers.length} providers failed:`);
    errors.forEach((e) => console.error(`[AI]   ✗ ${e.provider}/${e.model}: ${e.error}`));

    return {
      ok: false,
      error: errors.map((e) => `${e.provider}/${e.model}: ${e.error}`).join(" | "),
      details: errors,
    };
  }
}

// ============================================================
// CLASSIFY (unused — rule-based only — kept for future)
// ============================================================
export async function aiClassify(env, settings, text, signal = null) {
  const { CLASSIFY_PROMPT, buildClassifyUserMessage } = await import("./prompts.js");
  const res = await aiComplete(env, settings, {
    system: CLASSIFY_PROMPT,
    user: buildClassifyUserMessage(text),
    jsonMode: true,
  }, signal);

  if (!res.ok) return { ok: false, error: res.error };

  let cleaned = res.text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  try {
    const parsed = JSON.parse(cleaned);
    return {
      ok: true,
      provider: res.provider,
      decision: {
        content_type: parsed.content_type || "other",
        rewrite_mode: ["none", "light", "normal", "summary"].includes(parsed.rewrite_mode)
          ? parsed.rewrite_mode
          : "light",
        language_mode: ["auto", "fa", "en"].includes(parsed.language_mode) ? parsed.language_mode : "auto",
        needs_rewrite: Boolean(parsed.needs_rewrite),
      },
    };
  } catch (e) {
    return { ok: false, error: `JSON_PARSE_ERROR: ${e.message}`, raw: res.text };
  }
}

// ============================================================
// REWRITE
// ============================================================
export async function aiRewrite(env, settings, text, mode, language, personality, editIntensity, emojiLevel, signal = null) {
  const { REWRITE_PROMPT, buildRewriteUserMessage } = await import("./prompts.js");
  const { buildEditorPrompt } = await import("../ai/knowledge/index.js");
  const { buildProfileEditorPrompt, getProfile } = await import("../ai/profiles/index.js");

  let fullSystemPrompt;
  if (settings.active_profile) {
    const pp = buildProfileEditorPrompt(REWRITE_PROMPT, settings.active_profile);
    fullSystemPrompt = pp || buildEditorPrompt(REWRITE_PROMPT);
  } else {
    fullSystemPrompt = buildEditorPrompt(REWRITE_PROMPT);
  }

  const profile = settings.active_profile ? getProfile(settings.active_profile) : null;
  const effMode = profile ? profile.settings.rewrite_mode : mode;
  const effIntensity = profile ? profile.settings.edit_intensity : editIntensity;
  const effEmoji = profile ? profile.settings.emoji_level : emojiLevel;
  const effPersonality = profile ? profile.settings.personality_mode : personality;

  const res = await aiComplete(env, settings, {
    system: fullSystemPrompt,
    user: buildRewriteUserMessage(text, effMode, language, effPersonality, effIntensity ?? 60, effEmoji ?? 20),
  }, signal);

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider, model: res.model };
}

// ============================================================
// SUMMARIZE
// ============================================================
export async function aiSummarize(env, settings, text, language, editIntensity = 60, signal = null) {
  const { SUMMARIZE_PROMPT, buildSummarizeUserMessage } = await import("./prompts.js");
  const { buildEditorPrompt } = await import("../ai/knowledge/index.js");
  const { buildProfileEditorPrompt } = await import("../ai/profiles/index.js");

  let fullSystemPrompt;
  if (settings.active_profile) {
    const pp = buildProfileEditorPrompt(SUMMARIZE_PROMPT, settings.active_profile);
    fullSystemPrompt = pp || buildEditorPrompt(SUMMARIZE_PROMPT);
  } else {
    fullSystemPrompt = buildEditorPrompt(SUMMARIZE_PROMPT);
  }

  // Build user message with intensity guidance for summarization
  const userMsg = buildSummarizeUserMessage(text, language, editIntensity);

  const res = await aiComplete(env, settings, {
    system: fullSystemPrompt,
    user: userMsg,
  }, signal);

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider, model: res.model };
}

// ============================================================
// Export for debug dashboard
// ============================================================
export { DEFAULT_OPENROUTER_MODELS, getOpenRouterModels };
