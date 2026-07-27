/**
 * src/domain/roles.ts
 * -----------------------------------------------------------------------------
 * Role authorization matrix.
 *
 * Roles (descending privilege): owner > editor > reviewer > viewer.
 *
 *   owner     — full control. The only role that can manage admins. Fixes V1
 *               bug #4 where any admin could add/remove other admins.
 *   editor    — publish/approve/reject/schedule, change settings + footer,
 *               edit channel posts, view stats. Cannot manage admins.
 *   reviewer  — approve/reject + view stats only. Cannot publish directly,
 *               cannot change settings, cannot schedule.
 *   viewer    — view stats only.
 *
 * `can(role, permission)` is the single source of truth for authorization.
 * A `null` role (unknown / non-admin user) has NO permissions — public
 * commands (/start, /help) are gated separately by the caller, not by `can`.
 *
 * Permission strings are stable identifiers used across the codebase:
 *   manage_admins, change_settings, change_footer, publish, approve, reject,
 *   schedule, view_stats, edit_channel, use_debug.
 * -----------------------------------------------------------------------------
 */

import type { Role } from "../types";

// ============================================================
// Permission catalog
// ============================================================

/**
 * Full set of permissions granted to the owner. Editors and reviewers get a
 * strict subset; viewers get the smallest. Adding a new permission means
 * appending to the owner set and (optionally) to one of the subsets.
 */
export const ALL_PERMISSIONS: readonly string[] = [
  "manage_admins",
  "change_settings",
  "change_footer",
  "publish",
  "approve",
  "reject",
  "schedule",
  "view_stats",
  "edit_channel",
  "use_debug",
] as const;

/**
 * The authorization matrix. Each role maps to the set of permissions it
 * grants. Roles are NOT cumulative — e.g. a reviewer does not automatically
 * get editor permissions even though both have `view_stats`.
 */
export const ROLE_PERMISSIONS: Record<Role, Set<string>> = {
  owner: new Set<string>(ALL_PERMISSIONS),
  editor: new Set<string>([
    "publish",
    "approve",
    "reject",
    "schedule",
    "change_settings",
    "change_footer",
    "edit_channel",
    "view_stats",
  ]),
  reviewer: new Set<string>(["approve", "reject", "view_stats"]),
  viewer: new Set<string>(["view_stats"]),
};

// ============================================================
// Authorization predicate
// ============================================================

/**
 * Check whether a role grants the given permission.
 *
 * @param role       The user's role, or `null` if unknown / non-admin.
 * @param permission One of the strings in ALL_PERMISSIONS.
 * @returns          true iff the role is non-null AND its permission set
 *                   contains `permission`. A `null` role NEVER has any
 *                   permission — this is the central security guarantee.
 *
 * Public commands (/start, /help) are NOT gated by `can`; they are gated by
 * the command dispatcher itself, which always allows them.
 */
export function can(role: Role | null, permission: string): boolean {
  if (role === null) return false;
  const perms = ROLE_PERMISSIONS[role];
  if (!perms) return false;
  return perms.has(permission);
}

// ============================================================
// Human-readable labels (Persian)
// ============================================================

const ROLE_LABELS_FA: Record<Role, string> = {
  owner: "مالک",
  editor: "ویراستار",
  reviewer: "بازبین",
  viewer: "بیننده",
};

/**
 * Return the Persian label for a role. Used in admin lists, help text, and
 * audit logs.
 */
export function roleLabel(role: Role): string {
  return ROLE_LABELS_FA[role] ?? role;
}
