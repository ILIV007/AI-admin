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
  "meta-llama/llama-3.1-8b-instruct:free",
  "poolside/laguna-m.1:free",
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
      maxOutputTokens: 3096,
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
    max_tokens: 3096,
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
// v0.5.6: CRITICAL FIX — Always include the OTHER provider as a fallback
// even when the user has explicitly chosen one provider.
//
// Why? If ai_provider="gemini" and Gemini is rate-limited (429), the old code
// had NO fallback — it would return "all providers failed" and the bot would
// fall back to "format only" mode. Users were confused why their bot wasn't
// using OpenRouter when Gemini was down.
//
// Now: preferred provider is added FIRST (priority), then the other provider
// is ALWAYS added as a fallback if its API key exists. Promise.any races them
// all in parallel, so the fastest successful response wins.
// ============================================================
export async function aiComplete(env, settings, params) {
  const providers = [];
  const preferred = settings?.ai_provider || env.DEFAULT_AI_PROVIDER || "openrouter";

  // v0.5.6: Build providers in PREFERRED order, but ALWAYS add the other as fallback
  const geminiProviders = [];
  const openRouterProviders = [];

  // 1. Gemini models
  if (env.GEMINI_API_KEY) {
    const geminiModels = [
      env.GEMINI_MODEL || "gemini-2.5-flash",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-2.0-flash",
    ];
    const uniqueGeminiModels = [...new Set(geminiModels)];
    for (const model of uniqueGeminiModels) {
      geminiProviders.push({
        name: "gemini",
        model: model,
        complete: () => geminiComplete(env.GEMINI_API_KEY, model, params),
      });
    }
  }

  // 2. OpenRouter models
  if (env.OPENROUTER_API_KEY) {
    const models = getOpenRouterModels(env);
    for (const model of models) {
      openRouterProviders.push({
        name: "openrouter",
        model: model,
        complete: () => openRouterComplete(env.OPENROUTER_API_KEY, model, params),
      });
    }
  }

  // v0.5.6: Order providers — preferred FIRST, then fallback
  if (preferred === "gemini") {
    providers.push(...geminiProviders, ...openRouterProviders);
  } else if (preferred === "openrouter") {
    providers.push(...openRouterProviders, ...geminiProviders);
  } else {
    // "auto" or unknown — race all in parallel (order doesn't matter for Promise.any)
    providers.push(...geminiProviders, ...openRouterProviders);
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
// v0.5.5: ULTRA-COMPACT PROMPT — self-contained, no external rules needed
// ============================================================
const COMPACT_REWRITE_PROMPT = `You are a Telegram channel content editor. Improve the text quality. Do NOT add HTML or emojis.

RULES:
- Keep input language. NEVER translate.
- PRESERVE: GitHub links, docs, APIs, commands, code blocks, filenames, version numbers.
- REMOVE: spam, ads, channel mentions (@xxx), "join/follow", attribution lines.
- PRESERVE functional emojis (📚🛠️⚡💡🔒🌐📦). Remove decorative (🔥😍😱🎉🤣).
- PRESERVE number emojis (1️⃣2️⃣3️⃣).
- Preserve the author's emotional tone. Don't flatten excitement or urgency.
- Output plain text with markdown (**bold**, *italic*, \`code\`, \`\`\`code blocks\`\`\`).
- Do NOT add footer. Do NOT add explanations. Do NOT add HTML tags.
- Write each URL on its OWN line.`;

const COMPACT_SUMMARIZE_PROMPT = `You are a Telegram channel content editor. The post is too long for Telegram. TRIM it (don't summarize into bullet points).

RULES:
- Keep input language. NEVER translate.
- PRESERVE EVERY URL, link, and download link. Do NOT remove ANY.
- PRESERVE code blocks and commands.
- Remove only: redundancy, fluff, repetition, filler words.
- Output should be 80-90% of original length (NOT 30-50%!).
- Keep original structure and flow.
- Output plain text with markdown. Do NOT add HTML or footer.`;

function buildCompactPrompt(mode) {
  return mode === "summary" ? COMPACT_SUMMARIZE_PROMPT : COMPACT_REWRITE_PROMPT;
}

// ============================================================
// REWRITE
// ============================================================
export async function aiRewrite(env, settings, text, mode, language, personality, editIntensity, emojiLevel) {
  const { buildProfileEditorPrompt, getProfile } = await import("../ai/profiles/index.js");

  // v0.5.5: Ultra-compact prompt — ~300 tokens instead of ~1700
  let fullSystemPrompt;
  if (settings.active_profile) {
    const pp = buildProfileEditorPrompt(buildCompactPrompt("rewrite"), settings.active_profile);
    fullSystemPrompt = pp || buildCompactPrompt("rewrite");
  } else {
    fullSystemPrompt = buildCompactPrompt("rewrite");
  }

  const profile = settings.active_profile ? getProfile(settings.active_profile) : null;
  const effMode = profile ? profile.settings.rewrite_mode : mode;
  const effIntensity = profile ? profile.settings.edit_intensity : editIntensity;
  const effEmoji = profile ? profile.settings.emoji_level : emojiLevel;
  const effPersonality = profile ? profile.settings.personality_mode : personality;

  // Build user message inline (no import needed)
  const personalityGuide = {
    friendly: "Write like a REAL HUMAN. Conversational. Use contractions. For Persian: محاوره‌ای.",
    professional: "Clean, neutral, business-like.",
    technical: "Precise, terminology-friendly.",
    news: "Concise, fact-first.",
  };
  const userMsg = [
    `REWRITE_MODE: ${effMode}`,
    `LANGUAGE_MODE: ${language}`,
    `PERSONALITY: ${effPersonality} (${personalityGuide[effPersonality] || personalityGuide.friendly})`,
    ``,
    `POST TO PROCESS:`,
    `----`,
    text,
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
// SUMMARIZE
// ============================================================
export async function aiSummarize(env, settings, text, language) {
  const { buildProfileEditorPrompt } = await import("../ai/profiles/index.js");

  let fullSystemPrompt;
  if (settings.active_profile) {
    const pp = buildProfileEditorPrompt(buildCompactPrompt("summary"), settings.active_profile);
    fullSystemPrompt = pp || buildCompactPrompt("summary");
  } else {
    fullSystemPrompt = buildCompactPrompt("summary");
  }

  const userMsg = [
    `LANGUAGE_MODE: ${language}`,
    ``,
    `POST TO TRIM (too long for Telegram):`,
    `----`,
    text,
    `----`,
    ``,
    `Return ONLY the trimmed text. Keep 80-90% of original. Preserve ALL links.`,
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
