/**
 * src/config/env.ts
 * Typed accessor for Env. Validates required secrets at boot.
 */

import type { Env } from "../types";

export function assertEnv(env: unknown): asserts env is Env {
  const e = env as Record<string, unknown>;
  const missing: string[] = [];
  if (!e.BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!e.WEBHOOK_SECRET) missing.push("WEBHOOK_SECRET");
  if (!e.GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
  if (!e.OPENROUTER_API_KEY) missing.push("OPENROUTER_API_KEY");
  if (!e.ADMIN_ID) missing.push("ADMIN_ID");
  if (!e.TARGET_CHANNEL) missing.push("TARGET_CHANNEL");
  if (!e.DB) missing.push("DB (D1 binding)");
  if (!e.KV) missing.push("KV (KV binding)");
  if (!e.QUEUE) missing.push("QUEUE (Queue binding)");
  if (missing.length > 0) {
    throw new Error(
      `[env] Missing required bindings/vars: ${missing.join(", ")}. ` +
        `Set them in wrangler.toml or Cloudflare dashboard.`,
    );
  }
}

export function isDebug(env: Env): boolean {
  return env.DEBUG_MODE === "true";
}

export function ownerUserId(env: Env): number {
  return Number(env.ADMIN_ID);
}

export function targetChannel(env: Env): string {
  return env.TARGET_CHANNEL;
}
