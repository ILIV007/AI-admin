/**
 * src/ai.js
 * Unified AI client with two providers and automatic fallback.
 *
 * Providers:
 *   - Google Gemini (free tier: 15 RPM, 1500/day) — primary
 *   - OpenRouter   (has free models)              — fallback
 *
 * All providers expose the same signature:
 *   complete({ system, user, jsonMode }) -> string
 *
 * If the primary provider fails (network, 4xx, 5xx, timeout), we fall back.
 * If both fail, we throw — the caller MUST handle this gracefully (FORMAT_ONLY).
 */

const REQUEST_TIMEOUT_MS = 8_000; // 8s — must stay well under Cloudflare's 30s wall time limit

/** Race a fetch against a timeout using AbortController */
async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
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

      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`GEMINI_${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
      if (!text) throw new Error("GEMINI_EMPTY_RESPONSE");
      return text.trim();
    },
  };
}

// ============================================================
// OPENROUTER PROVIDER (OpenAI-compatible /chat/completions)
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

      const res = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://ilivir3.workers.dev",
          "X-Title": "ILIVIR3 AI Admin",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`OPENROUTER_${res.status}: ${errText.slice(0, 300)}`);
      }

      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content ?? "";
      if (!text) throw new Error("OPENROUTER_EMPTY_RESPONSE");
      return text.trim();
    },
  };
}

// ============================================================
// FACTORY: build a provider chain based on settings + env
// ============================================================
export function buildAIChain(env, settings) {
  const gemini = geminiProvider({
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL || "gemini-2.0-flash",
  });

  const openrouter = openRouterProvider({
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL || "google/gemini-2.0-flash-exp:free",
  });

  // Primary provider based on settings; fallback is always the other one
  const primary = settings?.ai_provider === "openrouter" ? openrouter : gemini;
  const fallback = settings?.ai_provider === "openrouter" ? gemini : openrouter;

  return { primary, fallback };
}

// ============================================================
// UNIFIED complete() — tries primary, then fallback
// ============================================================
export async function aiComplete(env, settings, params) {
  const { primary, fallback } = buildAIChain(env, settings);

  try {
    return { text: await primary.complete(params), provider: primary.name, ok: true };
  } catch (e1) {
    console.warn(`[AI] primary (${primary.name}) failed: ${e1.message}. Trying fallback…`);
    try {
      return { text: await fallback.complete(params), provider: fallback.name, ok: true, fellBack: true };
    } catch (e2) {
      console.error(`[AI] fallback (${fallback.name}) also failed: ${e2.message}`);
      return { ok: false, error: e2.message, primaryError: e1.message };
    }
  }
}

// ============================================================
// CLASSIFY — returns a normalized decision object
// ============================================================
export async function aiClassify(env, settings, text) {
  const { CLASSIFY_PROMPT, buildClassifyUserMessage } = await import("./prompts.js");
  const res = await aiComplete(env, settings, {
    system: CLASSIFY_PROMPT,
    user: buildClassifyUserMessage(text),
    jsonMode: true,
  });

  if (!res.ok) return { ok: false, error: res.error };

  // Parse JSON robustly (strip code fences if model added them)
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
