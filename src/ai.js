/**
 * src/ai.js
 * Unified AI client with MULTI-MODEL fallback (v0.2.2)
 *
 * Architecture:
 *   - Gemini is tried if key exists
 *   - MULTIPLE OpenRouter free models are tried in PARALLEL
 *   - Promise.any returns the FIRST successful response
 *   - If all fail, returns combined error
 *
 * Why multiple models?
 *   OpenRouter free models are often rate-limited (429) when many users
 *   hit them at once. By racing 6+ models, if even ONE is available, we
 *   get a successful response.
 */

const REQUEST_TIMEOUT_MS = 25_000;

// ============================================================
// DEFAULT FREE MODELS on OpenRouter (v0.2.4 — user-provided current list)
// ============================================================
// These are verified available free models from openrouter.ai/models (2025).
// OpenRouter frequently changes which models are free — if you see 404 errors,
// visit https://openrouter.ai/models (filter by "Free") and update this list.
const DEFAULT_OPENROUTER_MODELS = [
  "openrouter/free",                                   // #1 special auto-router — picks best free model
  "nvidia/nemotron-3-ultra-550b-a55b:free",            // #2 smartest but slow
  "nvidia/nemotron-3-super-120b-a12b:free",            // #3 balanced
  "nvidia/nemotron-3-nano-30b-a3b:free",               // #4 fast
  "openai/gpt-oss-20b:free",                           // #5 OpenAI open model
  "google/gemma-4-31b-it:free",                        // #6 Gemma 4
  "google/gemma-4-26b-a4b-it:free",                    // #7 Gemma 4 smaller
  "qwen/qwen3-next-80b-a3b-instruct:free",             // #8 Qwen (good multilingual)
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free", // #9 Dolphin
  "meta-llama/llama-3.2-3b-instruct:free",             // #10 small + fast
  "poolside/laguna-m.1:free",                          // #11 Poolside
];

// ============================================================
// SHARED: fetch with AbortController-based timeout
// ============================================================
function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...options, signal: ctrl.signal })
    .catch((e) => {
      if (e.name === "AbortError") throw new Error(`TIMEOUT ${timeoutMs / 1000}s`);
      throw new Error(`NETWORK: ${e.message}`);
    })
    .finally(() => clearTimeout(t));
}

// ============================================================
// GEMINI complete
// ============================================================
async function geminiComplete(apiKey, model, { system, user, jsonMode = false }) {
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

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

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
// OPENROUTER complete (single model)
// ============================================================
async function openRouterComplete(apiKey, model, { system, user, jsonMode = false }) {
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

  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://ai-admin.workers.dev",
      "X-Title": "AI Admin",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${errText.slice(0, 150)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  if (!text || !text.trim()) {
    // Some models return 200 OK but with empty content (content filter, etc.)
    throw new Error("EMPTY_RESPONSE (200 OK but no content — model may have refused)");
  }
  return text.trim();
}

// ============================================================
// Get the list of OpenRouter models to try
// ============================================================
function getOpenRouterModels(env) {
  // If user specified a comma-separated list of fallback models, use that
  if (env.OPENROUTER_FALLBACK_MODELS) {
    const models = env.OPENROUTER_FALLBACK_MODELS.split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    if (models.length > 0) return models;
  }

  // Otherwise, use OPENROUTER_MODEL as primary + all defaults
  const primary = env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODELS[0];
  return [primary, ...DEFAULT_OPENROUTER_MODELS.filter((m) => m !== primary)];
}

// ============================================================
// UNIFIED complete() — races Gemini + ALL OpenRouter models in PARALLEL
// ============================================================
// Uses Promise.any(): first provider to SUCCEED wins.
// If ALL fail, returns combined error.
// ============================================================
export async function aiComplete(env, settings, params) {
  // Build list of all providers to race
  const providers = [];

  // 1. Gemini (if key exists)
  if (env.GEMINI_API_KEY) {
    const geminiModel = env.GEMINI_MODEL || "gemini-2.0-flash";
    providers.push({
      name: "gemini",
      model: geminiModel,
      complete: () => geminiComplete(env.GEMINI_API_KEY, geminiModel, params),
    });
  }

  // 2. ALL OpenRouter free models (if key exists)
  if (env.OPENROUTER_API_KEY) {
    const models = getOpenRouterModels(env);
    for (const model of models) {
      providers.push({
        name: "openrouter",
        model: model,
        complete: () => openRouterComplete(env.OPENROUTER_API_KEY, model, params),
      });
    }
  }

  if (providers.length === 0) {
    return { ok: false, error: "No AI providers configured (need GEMINI_API_KEY or OPENROUTER_API_KEY)" };
  }

  console.log(`[AI] racing ${providers.length} providers:`);
  providers.forEach((p) => console.log(`[AI]   - ${p.name}/${p.model}`));

  // Race ALL providers in parallel using Promise.any
  // Promise.any returns the first successful result.
  // If ALL fail, it throws AggregateError with all errors.
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
    // All providers failed — AggregateError.errors has all rejection reasons
    const errors = providers.map((p, i) => ({
      provider: p.name,
      model: p.model,
      error: aggErr.errors?.[i]?.message || "unknown",
    }));
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
export async function aiClassify(env, settings, text) {
  const { CLASSIFY_PROMPT, buildClassifyUserMessage } = await import("./prompts.js");
  const res = await aiComplete(env, settings, {
    system: CLASSIFY_PROMPT,
    user: buildClassifyUserMessage(text),
    jsonMode: true,
  });

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
export async function aiRewrite(env, settings, text, mode, language, personality) {
  const { REWRITE_PROMPT, buildRewriteUserMessage } = await import("./prompts.js");
  const res = await aiComplete(env, settings, {
    system: REWRITE_PROMPT,
    user: buildRewriteUserMessage(text, mode, language, personality),
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider, model: res.model };
}

// ============================================================
// SUMMARIZE
// ============================================================
export async function aiSummarize(env, settings, text, language) {
  const { SUMMARIZE_PROMPT, buildSummarizeUserMessage } = await import("./prompts.js");
  const res = await aiComplete(env, settings, {
    system: SUMMARIZE_PROMPT,
    user: buildSummarizeUserMessage(text, language),
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider, model: res.model };
}

// ============================================================
// Export for debug dashboard
// ============================================================
export { DEFAULT_OPENROUTER_MODELS, getOpenRouterModels };
