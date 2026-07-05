/**
 * src/ai.js
 * Unified AI client with MULTI-MODEL fallback — v0.5.9
 *
 * v0.5.9 changes (TASK 3):
 *   - Added AbortController to aiComplete(): when the first provider succeeds,
 *     all other in-flight requests are ABORTED. This prevents wasting tokens
 *     and CPU on the 9 other models that are still running.
 *   - Hard rule: ONLY use COMPACT_REWRITE_PROMPT / COMPACT_SUMMARIZE_PROMPT
 *     for API calls (under 800 tokens). Never pass buildEditorPrompt() output.
 *   - aiSummarize accepts targetCharLimit to fit Telegram limits.
 *   - Static import of profiles (was dynamic — failed in CF Workers bundler).
 *   - Always include BOTH providers as fallback (preferred first).
 */

// v0.5.7: STATIC import (dynamic import was failing in Cloudflare Workers bundler)
import { buildProfileEditorPrompt, getProfile } from "../ai/profiles/index.js";

const REQUEST_TIMEOUT_MS = 15_000;

// ============================================================
// DEFAULT FREE MODELS on OpenRouter
// ============================================================
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
      maxOutputTokens: 3096,
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
// UNIFIED complete() — v0.5.9: AbortController cancels losers
// ============================================================
// CRITICAL FIX (TASK 3): Previously, when Promise.any resolved with the
// first successful response, the other 9 fetch requests kept running in
// the background — wasting tokens, CPU, and bandwidth. Now we create a
// shared AbortController. The moment ANY provider succeeds, we call
// controller.abort() to cancel all others. Losers get a CANCELLED error
// which we silently ignore (it's intentional, not a real failure).
// ============================================================
export async function aiComplete(env, settings, params) {
  const providers = [];
  const preferred = settings?.ai_provider || env.DEFAULT_AI_PROVIDER || "openrouter";

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
      });
    }
  }

  // Order providers — preferred FIRST, then fallback
  if (preferred === "gemini") {
    providers.push(...geminiProviders, ...openRouterProviders);
  } else if (preferred === "openrouter") {
    providers.push(...openRouterProviders, ...geminiProviders);
  } else {
    providers.push(...geminiProviders, ...openRouterProviders);
  }

  if (providers.length === 0) {
    const errMsg = !env.GEMINI_API_KEY && !env.OPENROUTER_API_KEY
      ? "No AI providers configured (need GEMINI_API_KEY or OPENROUTER_API_KEY)"
      : !env.OPENROUTER_API_KEY
        ? `OPENROUTER_API_KEY is missing (preferred=${preferred}). Set it as a secret in Cloudflare dashboard.`
        : `GEMINI_API_KEY is missing (preferred=${preferred}). Set it as a secret in Cloudflare dashboard.`;
    console.error(`[AI] NO PROVIDERS AVAILABLE: ${errMsg}`);
    return { ok: false, error: errMsg };
  }

  console.log(`[AI] v0.5.9 racing ${providers.length} providers (preferred=${preferred}):`);
  providers.forEach((p) => console.log(`[AI]   - ${p.name}/${p.model}`));

  // v0.5.9: Shared AbortController — the moment ANY provider wins,
  // abort ALL others to save tokens/CPU/bandwidth.
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
          // v0.5.9: Silently ignore CANCELLED errors (intentional abort when another provider won)
          if (e.message === "CANCELLED" || e.message.includes("CANCELLED")) {
            throw new Error("CANCELLED (another provider won)");
          }
          throw e;
        }
        const ms = Date.now() - start;
        console.log(`[AI] ✓ ${p.name}/${p.model} OK in ${ms}ms (${text.length} chars) — aborting others`);
        // CRITICAL: Abort all other in-flight requests to save tokens
        winnerController.abort();
        return { ok: true, text, provider: p.name, model: p.model, ms };
      })
    );
    console.log(`[AI] WINNER: ${result.provider}/${result.model}`);
    return result;
  } catch (aggErr) {
    // All providers failed (or were cancelled). Collect real errors only.
    const errors = providers.map((p, i) => {
      const errMsg = aggErr.errors?.[i]?.message || "unknown";
      // Don't report CANCELLED as a real error
      if (errMsg.includes("CANCELLED")) return { provider: p.name, model: p.model, error: "cancelled (another provider won)" };
      return { provider: p.name, model: p.model, error: errMsg };
    });
    const realErrors = errors.filter((e) => !e.error.includes("cancelled"));
    console.error(`[AI] ALL ${providers.length} providers failed (${realErrors.length} real errors, ${errors.length - realErrors.length} cancelled):`);
    realErrors.forEach((e) => console.error(`[AI]   ✗ ${e.provider}/${e.model}: ${e.error}`));

    return {
      ok: false,
      error: realErrors.length > 0
        ? realErrors.map((e) => `${e.provider}/${e.model}: ${e.error}`).join(" | ")
        : "All providers cancelled (should not happen)",
      details: realErrors,
    };
  }
}

// ============================================================
// v0.5.5: ULTRA-COMPACT PROMPTS — self-contained, under 800 tokens
// v0.5.9 HARD RULE: ONLY these prompts are sent to the API.
// Never pass buildEditorPrompt() / buildFormatterPrompt() output.
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
// REWRITE — v0.5.9: ONLY use compact prompt (never buildEditorPrompt)
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
// SUMMARIZE — v0.5.9: accepts targetCharLimit to fit Telegram limits
// ============================================================
export async function aiSummarize(env, settings, text, language, targetCharLimit = 3500) {
  let fullSystemPrompt;
  if (settings.active_profile) {
    const pp = buildProfileEditorPrompt(buildCompactPrompt("summary"), settings.active_profile);
    fullSystemPrompt = pp || buildCompactPrompt("summary");
  } else {
    fullSystemPrompt = buildCompactPrompt("summary");
  }

  // Tell the AI the EXACT target character limit so output fits Telegram
  const userMsg = [
    `LANGUAGE_MODE: ${language}`,
    `TARGET: Fit the output within ${targetCharLimit} characters (including spaces).`,
    `This is a HARD LIMIT — the output MUST be under ${targetCharLimit} chars.`,
    ``,
    `POST TO TRIM (too long for Telegram — current length: ${text.length} chars):`,
    `----`,
    text,
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
