/**
 * src/ai/openrouter.ts
 * OpenRouter chat-completions provider.
 *
 * Docs: https://openrouter.ai/docs
 *
 * OpenRouter returns 429 with a `Retry-After` header when the underlying
 * upstream is rate-limited. We honor that header with a single retry inside
 * this provider (the task spec explicitly requires it). All other failure
 * modes are surfaced to the orchestrator.
 */

import type { AIRequest, AIResult, Env } from "../types";
import { AI_BUDGET } from "../config/defaults";
import {
  errResult,
  fetchWithTimeout,
  isRetryableError,
  okResult,
  parseRetryAfter,
  sleep,
  type AIProvider,
} from "./provider";
import { buildSystemPrompt, buildUserPrompt } from "./prompts";

const DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const REFERER = "https://ilivir3.bot";
const X_TITLE = "AI Admin V2";

interface OpenRouterResponse {
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { code?: number; message?: string };
}

interface OpenRouterErrorBody {
  error?: { code?: number; message?: string };
}

export const openrouterProvider: AIProvider = {
  name: "openrouter",

  async call(req: AIRequest, env: Env, modelOverride?: string): Promise<AIResult> {
    const startedAt = Date.now();
    const model = (modelOverride ?? req.settings.openrouterModel ?? DEFAULT_MODEL).trim();

    const systemPrompt = buildSystemPrompt(req.profile, req.settings, req.mode);
    const userPrompt = buildUserPrompt(req.text, req.classification, req.mode, req.instructionOverride);

    const body = {
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      // E: lower temperature for more deterministic formatting output.
      temperature: 0.3,
      max_tokens: 4096,
    };

    const init: RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": REFERER,
        "X-Title": X_TITLE,
      },
      body: JSON.stringify(body),
    };

    // First attempt.
    let res = await fetchWithTimeout(ENDPOINT, init, AI_BUDGET.TIMEOUT_MS);

    // Handle 429 once: respect Retry-After (parseRetryAfter returns SECONDS),
    // convert to ms, cap at TIMEOUT_MS, then retry once.
    if (res !== null && res.status === 429) {
      const waitSec = parseRetryAfter(res.headers);
      const waitMs = waitSec > 0 ? waitSec * 1000 : AI_BUDGET.BACKOFF_MS;
      // Drain the body so the connection can be reused / closed cleanly.
      try {
        await res.text();
      } catch {
        // ignore
      }
      await sleep(Math.min(waitMs, AI_BUDGET.TIMEOUT_MS));
      res = await fetchWithTimeout(ENDPOINT, init, AI_BUDGET.TIMEOUT_MS);
    }

    if (res === null) {
      return errResult(
        "openrouter",
        model,
        `request timed out after ${AI_BUDGET.TIMEOUT_MS}ms`,
        startedAt,
      );
    }

    if (!res.ok) {
      let errBody: OpenRouterErrorBody | null = null;
      try {
        errBody = (await res.json()) as OpenRouterErrorBody;
      } catch {
        // ignore JSON parse errors
      }
      const apiMsg = errBody?.error?.message;
      const code = errBody?.error?.code ?? res.status;
      const error = `openrouter ${code}: ${apiMsg ?? res.statusText}`.trim();
      return errResult("openrouter", model, error, startedAt);
    }

    let payload: OpenRouterResponse;
    try {
      payload = (await res.json()) as OpenRouterResponse;
    } catch (err) {
      return errResult(
        "openrouter",
        model,
        `invalid JSON response (${(err as Error).message})`,
        startedAt,
      );
    }

    const text = payload.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim().length === 0) {
      const reason = payload.choices?.[0]?.finish_reason ?? "unknown";
      return errResult(
        "openrouter",
        model,
        `empty response (finish_reason=${reason})`,
        startedAt,
      );
    }

    return okResult(
      "openrouter",
      model,
      text,
      startedAt,
      payload.usage?.prompt_tokens,
      payload.usage?.completion_tokens,
    );
  },
};

export { isRetryableError };
