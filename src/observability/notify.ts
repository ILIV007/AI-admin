/**
 * src/observability/notify.ts
 * Send error/critical notifications to the admin's private Telegram chat.
 * Best-effort: never throws, logs failures but doesn't break the flow.
 */

import type { Env } from "../types";
import { sendMessage } from "../telegram/client";
import { log } from "./logger";

/**
 * Send a notification message to the admin (env.ADMIN_ID) private chat.
 * Best-effort: catches all errors, never throws.
 */
export async function notifyAdmin(env: Env, text: string): Promise<void> {
  try {
    if (!env.ADMIN_ID || !env.BOT_TOKEN) return;
    const adminId = Number(env.ADMIN_ID);
    if (!adminId || isNaN(adminId)) return;

    // Truncate to avoid Telegram 4096 limit
    const safeText = text.length > 4000 ? text.slice(0, 4000) + "\n…(truncated)" : text;

    await sendMessage(env.BOT_TOKEN, {
      chat_id: adminId,
      text: safeText,
      parse_mode: "HTML",
    });
  } catch (e) {
    // Best-effort: log but don't throw
    log("warn", "notify", "failed to notify admin", { error: String(e) });
  }
}

/**
 * Notify admin of a critical error with context.
 */
export async function notifyError(
  env: Env,
  scope: string,
  error: string,
  context?: Record<string, unknown>,
): Promise<void> {
  const ctxStr = context ? `\n\n<b>Context:</b>\n<pre>${escapeHtmlSafe(JSON.stringify(context, null, 2))}</pre>` : "";
  const text = `🚨 <b>Critical Error</b>\n\n<b>Scope:</b> ${escapeHtmlSafe(scope)}\n<b>Error:</b> <pre>${escapeHtmlSafe(error)}</pre>${ctxStr}`;
  await notifyAdmin(env, text);
}

/**
 * Notify admin of a webhook authentication failure (403).
 * Only sends once per hour to avoid spam (uses KV TTL).
 */
export async function notifyWebhookAuthFailure(env: Env, remoteIp?: string): Promise<void> {
  try {
    // Throttle: only once per hour
    const throttleKey = "notify:webhook403";
    const recent = await env.AI_ADMIN_KV.get(throttleKey);
    if (recent) return; // already notified recently
    await env.AI_ADMIN_KV.put(throttleKey, "1", { expirationTtl: 3600 });

    const text = `⚠️ <b>Webhook Authentication Failed</b>\n\nThe Worker received a webhook request with a missing or mismatched <code>WEBHOOK_SECRET</code>.\n\n<b>To fix:</b>\n1. Go to Cloudflare Dashboard → Workers → ai-admin → Settings → Variables\n2. Add a Secret named <code>WEBHOOK_SECRET</code>\n3. Set its value to the SAME secret you used when calling <code>setWebhook</code>\n4. Redeploy if needed\n\n<b>Pending updates:</b> Telegram is retrying — they'll process once the secret is set.${remoteIp ? `\n<b>Remote IP:</b> <code>${escapeHtmlSafe(remoteIp)}</code>` : ""}`;
    await notifyAdmin(env, text);
  } catch {
    /* ignore */
  }
}

function escapeHtmlSafe(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
