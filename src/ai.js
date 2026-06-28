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

const REQUEST_TIMEOUT_MS = 15_000; // 15s per model — fast fail so Promise.any picks a winner quickly

// ============================================================
// DEFAULT FREE MODELS on OpenRouter (v0.2.7 — ranked by speed+quality)
// ============================================================
// Ranked based on real performance data from user's Test AI results.
// Faster + higher quality models are tried FIRST (Promise.any races them
// all, but the fastest winner is preferred).
//
// Rank | Model                          | Speed    | Quality | Notes
//-----+--------------------------------+----------+---------+-------
//  1  | nvidia/nemotron-3-nano-30b     | 737ms    | good    | FASTEST
//  2  | nvidia/nemotron-3-super-120b   | 1168ms   | good    | balanced
//  3  | google/gemma-4-31b-it          | 1433ms   | good    | solid
//  4  | openai/gpt-oss-20b             | 1837ms   | good    | OpenAI
//  5  | google/gemma-4-26b-a4b-it      | 1860ms   | good    | solid
//  6  | nvidia/nemotron-3-ultra-550b   | 1929ms   | best    | smartest
//  7  | openrouter/free                | 2578ms   | varies  | auto-router
//  8  | poolside/laguna-m.1            | 10418ms  | good    | slow but works
//  -- | qwen3-next-80b                 | 429      | --      | rate-limited (keep as fallback)
//  -- | dolphin-mistral-24b            | 429      | --      | rate-limited (keep as fallback)
//  -- | llama-3.2-3b                   | 429      | --      | rate-limited (keep as fallback)
const DEFAULT_OPENROUTER_MODELS = [
  "nvidia/nemotron-3-nano-30b-a3b:free",                // #1 FASTEST (737ms)
  "nvidia/nemotron-3-super-120b-a12b:free",             // #2 balanced (1168ms)
  "google/gemma-4-31b-it:free",                         // #3 solid (1433ms)
  "openai/gpt-oss-20b:free",                            // #4 OpenAI (1837ms)
  "google/gemma-4-26b-a4b-it:free",                     // #5 solid (1860ms)
  "nvidia/nemotron-3-ultra-550b-a55b:free",             // #6 smartest (1929ms)
  "openrouter/free",                                    // #7 auto-router (2578ms)
  "qwen/qwen3-next-80b-a3b-instruct:free",              // #8 rate-limited but good for Persian
  "cognitivecomputations/dolphin-mistral-24b-venice-edition:free", // #9 fallback
  "meta-llama/llama-3.2-3b-instruct:free",              // #10 fallback
  "poolside/laguna-m.1:free",                           // #11 slow but works
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

  // 1. Multiple Gemini models (if key exists) — fallback chain
  if (env.GEMINI_API_KEY) {
    // Primary Gemini model from env, plus fallback models
    const geminiModels = [
      env.GEMINI_MODEL || "gemini-2.5-flash",
      "gemini-2.5-flash",           // stable fallback
      "gemini-2.5-flash-lite",      // cheaper fallback
      "gemini-2.0-flash",           // legacy fallback
    ];
    // Deduplicate
    const uniqueGeminiModels = [...new Set(geminiModels)];
    for (const model of uniqueGeminiModels) {
      providers.push({
        name: "gemini",
        model: model,
        complete: () => geminiComplete(env.GEMINI_API_KEY, model, params),
      });
    }
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
export async function aiRewrite(env, settings, text, mode, language, personality, editIntensity, emojiLevel) {
  const { REWRITE_PROMPT, buildRewriteUserMessage } = await import("./prompts.js");
  const { buildEditorPrompt } = await import("../ai/index.js");
  const { buildProfileEditorPrompt, getProfile } = await import("../ai/profiles/index.js");

  // If a profile is active, use profile-based prompt (soul + style + rules)
  // Otherwise, use the standard knowledge base prompt
  let fullSystemPrompt;
  if (settings.active_profile) {
    const profilePrompt = buildProfileEditorPrompt(REWRITE_PROMPT, settings.active_profile);
    if (profilePrompt) {
      fullSystemPrompt = profilePrompt;
    } else {
      fullSystemPrompt = buildEditorPrompt(REWRITE_PROMPT);
    }
  } else {
    fullSystemPrompt = buildEditorPrompt(REWRITE_PROMPT);
  }

  // If profile is active, use profile's default settings
  const profile = settings.active_profile ? getProfile(settings.active_profile) : null;
  const effectiveMode = profile ? profile.settings.rewrite_mode : mode;
  const effectiveIntensity = profile ? profile.settings.edit_intensity : editIntensity;
  const effectiveEmoji = profile ? profile.settings.emoji_level : emojiLevel;
  const effectivePersonality = profile ? profile.settings.personality_mode : personality;

  const res = await aiComplete(env, settings, {
    system: fullSystemPrompt,
    user: buildRewriteUserMessage(text, effectiveMode, language, effectivePersonality, effectiveIntensity ?? 60, effectiveEmoji ?? 20),
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider, model: res.model };
}

// ============================================================
// SUMMARIZE
// ============================================================
export async function aiSummarize(env, settings, text, language) {
  const { SUMMARIZE_PROMPT, buildSummarizeUserMessage } = await import("./prompts.js");
  const { buildEditorPrompt } = await import("../ai/index.js");
  const { buildProfileEditorPrompt } = await import("../ai/profiles/index.js");

  let fullSystemPrompt;
  if (settings.active_profile) {
    const profilePrompt = buildProfileEditorPrompt(SUMMARIZE_PROMPT, settings.active_profile);
    fullSystemPrompt = profilePrompt || buildEditorPrompt(SUMMARIZE_PROMPT);
  } else {
    fullSystemPrompt = buildEditorPrompt(SUMMARIZE_PROMPT);
  }

  const res = await aiComplete(env, settings, {
    system: fullSystemPrompt,
    user: buildSummarizeUserMessage(text, language),
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider, model: res.model };
}

// ============================================================
// Export for debug dashboard
// ============================================================
export { DEFAULT_OPENROUTER_MODELS, getOpenRouterModels };
