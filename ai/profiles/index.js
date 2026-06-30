/**
 * ai/profiles/index.js
 * Profile system — v0.5.3
 */

import { ILIVIR3_PROFILE } from "./ilivir3/index.js";

const PROFILES = new Map();
PROFILES.set("ilivir3", ILIVIR3_PROFILE);

export function getProfile(key) {
  return PROFILES.get(key) || null;
}

export function getAllProfiles() {
  return Array.from(PROFILES.values()).map((p) => ({
    key: p.key,
    name: p.name,
    description: p.description,
  }));
}

export function buildProfileEditorPrompt(basePrompt, profileKey) {
  const profile = getProfile(profileKey);
  if (!profile) return null;

  return [
    basePrompt,
    "",
    "=== ACTIVE PROFILE ===",
    `Profile: ${profile.name}`,
    "",
    "=== PROFILE SOUL ===",
    profile.soul,
    "",
    "=== PROFILE STYLE ===",
    profile.style,
    "",
    "=== PROFILE RULES ===",
    profile.rules,
    "",
    "=== END PROFILE ===",
  ].join("\n");
}

export function buildProfileFormatterPrompt(basePrompt, profileKey) {
  const profile = getProfile(profileKey);
  if (!profile) return null;

  return [
    basePrompt,
    "",
    "=== ACTIVE PROFILE FORMATTING ===",
    profile.formatting || profile.rules,
    "",
    "=== END PROFILE FORMATTING ===",
  ].join("\n");
}
