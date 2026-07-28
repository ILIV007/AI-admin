/**
 * src/admin/addadmin.ts
 * -----------------------------------------------------------------------------
 * Add-admin reply flow.
 *
 * The owner starts the flow by clicking "➕ Add Admin" (callback
 * `addadmin`). The callback router:
 *   1. Re-checks `isOwner` (V1 bug #4: any admin could add admins).
 *   2. Sets a short-lived KV flag `addadmin_next:{ownerUserId}` with TTL 120s.
 *   3. Replies: "Send the user numeric ID".
 *
 * The webhook/queue consumer must call `handleAddAdminReply(env, message)`
 * BEFORE routing the message through the content pipeline. If the KV flag is
 * set, we treat the message text as add-admin input:
 *   - First token must be a numeric Telegram user ID.
 *   - Optional second token is a role name (viewer/editor/reviewer). Owner
 *     role CANNOT be granted here — only `env.ADMIN_ID` is the owner, ever.
 *   - On success: `upsertAdmin`, reply "✅ Admin added", delete the KV
 *     flag, return true so the caller skips the pipeline.
 *   - On parse failure: reply with a usage hint, delete the flag, return true
 *     (still consumed — don't let a typo leak into the channel pipeline).
 *
 * Returns false when the KV flag is absent, so the caller routes the message
 * normally.
 * -----------------------------------------------------------------------------
 */

import type { AdminRecord, Env, Role, TelegramMessage } from "../types";
import { sendMessage } from "../telegram/client";
import { log } from "../observability/logger";
import { audit, upsertAdmin } from "../storage/repositories/admins";
import { nowMs } from "../storage/d1";

const KV_FLAG_PREFIX = "addadmin_next:";
const KV_FLAG_TTL_SEC = 120; // 2 minutes to type an ID

const VALID_ROLES: Role[] = ["editor", "reviewer", "viewer"];

/**
 * Inspect `message` for an in-flight add-admin flow.
 *
 * @returns true  if the message was consumed by the add-admin flow (caller
 *                 should NOT route to the pipeline).
 *          false if no add-admin flow is active for this user.
 */
export async function handleAddAdminReply(
  env: Env,
  message: TelegramMessage,
): Promise<boolean> {
  const fromId = message.from?.id;
  if (fromId == null) return false;

  const flagKey = `${KV_FLAG_PREFIX}${fromId}`;
  let flagValue: string | null = null;
  try {
    flagValue = await env.AI_ADMIN_KV.get(flagKey);
  } catch (e) {
    log("warn", "addadmin.handleAddAdminReply", "KV get failed", {
      error: String(e),
    });
    return false;
  }

  if (!flagValue) return false;

  // Always delete the flag — the flow is single-shot, even on parse error.
  try {
    await env.AI_ADMIN_KV.delete(flagKey);
  } catch (e) {
    log("warn", "addadmin.handleAddAdminReply", "KV delete failed", {
      error: String(e),
    });
  }

  const text = (message.text ?? "").trim();
  const tokens = text.split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    await reply(env, message.chat.id, "⚠️ Empty input. Try /admins again.");
    return true;
  }

  // First token must be numeric.
  const userIdNum = Number(tokens[0]);
  if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
    await reply(
      env,
      message.chat.id,
      "⚠️ ID must be a number.\nExample: <code>123456789 editor</code>",
    );
    return true;
  }

  // Optional role (default viewer).
  let role: Role = "viewer";
  if (tokens.length >= 2) {
    const r = tokens[1].toLowerCase();
    if (!VALID_ROLES.includes(r as Role)) {
      await reply(
        env,
        message.chat.id,
        "⚠️ Invalid role. Options: <code>editor</code>, <code>reviewer</code>, <code>viewer</code>.\n" +
          "Note: owner role is set via ADMIN_ID env var.",
      );
      return true;
    }
    role = r as Role;
  }

  // Upsert via the admins repository. upsertAdmin takes a full AdminRecord.
  try {
    const rec: AdminRecord = {
      userId: userIdNum,
      role,
      addedAt: nowMs(),
      addedBy: fromId,
    };
    await upsertAdmin(env, rec);
  } catch (e) {
    log("error", "addadmin.handleAddAdminReply", "upsertAdmin failed", {
      error: String(e),
      targetUserId: userIdNum,
    });
    await reply(
      env,
      message.chat.id,
      "❌ Failed to save admin. Try again later.",
    );
    return true;
  }

  // Audit log the role grant so there is a tamper-evident record of who added
  // which admin and with what role. Matches the convention used by /reset,
  // /webhook, and /broadcast (action snake_case, target = new admin id,
  // detail = role).
  try {
    await audit(env, fromId, "add_admin", String(userIdNum), role);
  } catch (e) {
    log("warn", "addadmin.handleAddAdminReply", "audit log failed", {
      error: String(e),
      targetUserId: userIdNum,
    });
  }

  log("info", "addadmin.handleAddAdminReply", "admin added", {
    actorId: fromId,
    newAdminId: userIdNum,
    role,
  });

  await reply(
    env,
    message.chat.id,
    `✅ Admin added.\nآیدی: <code>${userIdNum}</code>\nنقش: <b>${roleFa(role)}</b>`,
  );
  return true;
}

/**
 * Set the add-admin KV flag for the given owner. Called by the callback
 * router when the owner clicks "➕ Add Admin".
 */
export async function setAddAdminFlag(
  env: Env,
  ownerId: number,
): Promise<void> {
  try {
    await env.AI_ADMIN_KV.put(`${KV_FLAG_PREFIX}${ownerId}`, "1", {
      expirationTtl: KV_FLAG_TTL_SEC,
    });
  } catch (e) {
    log("warn", "addadmin.setAddAdminFlag", "KV put failed", {
      error: String(e),
    });
  }
}

// ============================================================
// Internal helpers
// ============================================================

function roleFa(role: Role): string {
  switch (role) {
    case "owner":
      return "مالک";
    case "editor":
      return "ویراستار";
    case "reviewer":
      return "بازبین";
    case "viewer":
      return "بیننده";
  }
}

async function reply(env: Env, chatId: number, text: string): Promise<void> {
  try {
    await sendMessage(env.BOT_TOKEN, { chat_id: chatId, text });
  } catch (e) {
    log("warn", "addadmin.reply", "sendMessage failed", { error: String(e) });
  }
}
