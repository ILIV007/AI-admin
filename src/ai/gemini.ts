/**
 * src/ai/gemini.ts
 * Google Gemini provider (Generative Language API v1beta).
 *
 * Docs: https://ai.google.dev/api/rest/v1beta/models/generateContent
 *
 * The provider does NOT retry on its own. The fallback orchestrator decides
 * retry / fallback strategy. We only honor an explicit 429 by surfacing the
 * error so the orchestrator can pick a different model.
 */

import type { AIRequest, AIResult, Env } from "../types";
import { AI_BUDGET } from "../config/defaults";
import {
  errResult,
  fetchWithTimeout,
  isRetryableError,
  okResult,
  type AIProvider,
} from "./provider";
import { buildSystemPrompt, buildUserPrompt } from "./prompts";

const DEFAULT_MODEL = "gemini-2.5-flash";

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { code?: number; message?: string; status?: string };
}

export const geminiProvider: AIProvider = {
  name: "gemini",

  async call(req: AIRequest, env: Env, modelOverride?: string): Promise<AIResult> {
    const startedAt = Date.now();
    const model = (modelOverride ?? req.settings.geminiModel ?? DEFAULT_MODEL).trim();

    const systemPrompt = buildSystemPrompt(req.profile, req.settings, req.mode);
    const userPrompt = buildUserPrompt(req.text, req.classification, req.mode);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model,
    )}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

    const body = {
      contents: [
        {
          role: "user",
          parts: [{ text: userPrompt }],
        },
      ],
      systemInstruction: {
        parts: [{ text: systemPrompt }],
      },
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    };

    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      AI_BUDGET.TIMEOUT_MS,
    );

    if (res === null) {
      return errResult(
        "gemini",
        model,
        `request timed out after ${AI_BUDGET.TIMEOUT_MS}ms`,
        startedAt,
      );
    }

    if (!res.ok) {
      let payload: GeminiResponse | null = null;
      try {
        payload = (await res.json()) as GeminiResponse;
      } catch {
        // ignore JSON parse errors
      }
      const apiMsg = payload?.error?.message;
      const status = payload?.error?.code ?? res.status;
      const error = `gemini ${status}: ${apiMsg ?? res.statusText}`.trim();
      return errResult("gemini", model, error, startedAt);
    }

    let payload: GeminiResponse;
    try {
      payload = (await res.json()) as GeminiResponse;
    } catch (err) {
      return errResult(
        "gemini",
        model,
        `invalid JSON response (${(err as Error).message})`,
        startedAt,
      );
    }

    const text = payload.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      const reason = payload.candidates?.[0]?.finishReason ?? "unknown";
      return errResult(
        "gemini",
        model,
        `empty response (finishReason=${reason})`,
        startedAt,
      );
    }

    return okResult(
      "gemini",
      model,
      text,
      startedAt,
      payload.usageMetadata?.promptTokenCount,
      payload.usageMetadata?.candidatesTokenCount,
    );
  },
};

// Exported so the orchestrator can decide retryability without re-importing
// the helper from provider.ts in some call sites.
export { isRetryableError };
