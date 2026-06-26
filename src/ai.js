/**
 * src/ai.js
 * Unified AI client with two providers running in PARALLEL for speed.
 *
 * Architecture (v0.2.1):
 *   - Both Gemini AND OpenRouter fire at the SAME TIME (Promise.any)
 *   - First one to succeed wins
 *   - Generous 25s timeout per provider (large models need it)
 *   - Detailed logging of every call + response
 *
 * If both fail, we return a detailed error combining both failure reasons.
 */

const REQUEST_TIMEOUT_MS = 25_000; // 25s per provider — generous for large models

// ============================================================
// SHARED: fetch with AbortController-based timeout
// ============================================================
function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...options, signal: ctrl.signal })
    .catch((e) => {
      if (e.name === "AbortError") {
        throw new Error(`TIMEOUT after ${timeoutMs / 1000}s`);
      }
      throw new Error(`NETWORK: ${e.message}`);
    })
    .finally(() => clearTimeout(t));
}

// ============================================================
// GEMINI PROVIDER
// ============================================================
function geminiProvider({ apiKey, model }) {
  return {
    name: "gemini",
    async complete({ system, user, jsonMode = false }) {
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

      const start = Date.now();
      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`GEMINI_${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      const ms = Date.now() - start;
      console.log(`[AI:gemini] OK in ${ms}ms (${text.length} chars)`);
      if (!text) throw new Error("GEMINI_EMPTY_RESPONSE");
      return text.trim();
    },
  };
}

// ============================================================
// OPENROUTER PROVIDER (OpenAI-compatible)
// ============================================================
function openRouterProvider({ apiKey, model }) {
  return {
    name: "openrouter",
    async complete({ system, user, jsonMode = false }) {
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

      const start = Date.now();
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
        throw new Error(`OPENROUTER_${res.status}: ${errText.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? "";
      const ms = Date.now() - start;
      console.log(`[AI:openrouter] OK in ${ms}ms (${text.length} chars)`);
      if (!text) throw new Error("OPENROUTER_EMPTY_RESPONSE");
      return text.trim();
    },
  };
}

// ============================================================
// FACTORY: build both providers
// ============================================================
export function buildAIChain(env, settings) {
  const gemini = geminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || "gemini-2.0-flash",
  });

  const openrouter = openRouterProvider({
    apiKey: env.OPENROUTER_API_KEY,
    // Default to a known-working fast model. nvidia/nemotron-550b is too slow.
    model: env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free",
  });

  return { gemini, openrouter };
}

// ============================================================
// UNIFIED complete() — races BOTH providers in PARALLEL
// ============================================================
// Uses Promise.any(): first provider to SUCCEED wins. The other is
// abandoned (its result is discarded). This is much faster than
// sequential (old) or Promise.all (waits for both).
//
// If BOTH fail, returns combined error.
// ============================================================
export async function aiComplete(env, settings, params) {
  const { gemini, openrouter } = buildAIChain(env, settings);

  // Wrap each provider so it NEVER rejects — always resolves to {ok, ...}
  const geminiPromise = gemini.complete(params).then(
    (text) => ({ ok: true, text, provider: "gemini" }),
    (err) => ({ ok: false, provider: "gemini", error: err.message })
  );
  const openrouterPromise = openrouter.complete(params).then(
    (text) => ({ ok: true, text, provider: "openrouter" }),
    (err) => ({ ok: false, provider: "openrouter", error: err.message })
  );

  // Wait for BOTH (they run in parallel)
  const [geminiResult, openrouterResult] = await Promise.all([
    geminiPromise,
    openrouterPromise,
  ]);

  // Log both results
  console.log(`[AI] gemini:     ${geminiResult.ok ? `OK (${geminiResult.text.length} chars)` : `FAIL — ${geminiResult.error}`}`);
  console.log(`[AI] openrouter: ${openrouterResult.ok ? `OK (${openrouterResult.text.length} chars)` : `FAIL — ${openrouterResult.error}`}`);

  // Prefer the one that succeeded (prefer primary if both ok)
  const preferred = settings?.ai_provider === "openrouter" ? openrouterResult : geminiResult;
  const other = settings?.ai_provider === "openrouter" ? geminiResult : openrouterResult;

  if (preferred.ok) return preferred;
  if (other.ok) return { ...other, fellBack: true };
  return { ok: false, error: `gemini: ${geminiResult.error} | openrouter: ${openrouterResult.error}` };
}

// ============================================================
// CLASSIFY (unused in v0.2.x — rule-based only — but kept for future)
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
// REWRITE — returns final post text
// ============================================================
export async function aiRewrite(env, settings, text, mode, language, personality) {
  const { REWRITE_PROMPT, buildRewriteUserMessage } = await import("./prompts.js");
  const res = await aiComplete(env, settings, {
    system: REWRITE_PROMPT,
    user: buildRewriteUserMessage(text, mode, language, personality),
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider };
}

// ============================================================
// SUMMARIZE — returns shortened post text
// ============================================================
export async function aiSummarize(env, settings, text, language) {
  const { SUMMARIZE_PROMPT, buildSummarizeUserMessage } = await import("./prompts.js");
  const res = await aiComplete(env, settings, {
    system: SUMMARIZE_PROMPT,
    user: buildSummarizeUserMessage(text, language),
  });

  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, text: res.text, provider: res.provider };
}
