/**
 * ai/profiles/index.js
 * Profile loader — loads all profiles and provides access.
 *
 * When a profile is active, it replaces individual settings (personality,
 * rewrite_mode, edit_intensity, emoji_level) with the profile's
 * soul + style + rules.
 *
 * Available profiles:
 *   - "ilivir3" — the default ILIVIR3 channel admin
 *
 * To add a new profile:
 *   1. Create ai/profiles/<name>/ with soul.js, style.js, rules.js
 *   2. Import and register it below
 */

import { SOUL as ILIVIR3_SOUL } from "./ilivir3/soul.js";
import { STYLE as ILIVIR3_STYLE } from "./ilivir3/style.js";
import { RULES as ILIVIR3_RULES } from "./ilivir3/rules.js";

// Profile registry
const PROFILES = {
  ilivir3: {
    name: "ILIVIR3",
    description: "Default ILIVIR3 channel admin — professional, calm, developer-focused",
    soul: ILIVIR3_SOUL,
    style: ILIVIR3_STYLE,
    rules: ILIVIR3_RULES,
    // Default settings when this profile is active
    settings: {
      rewrite_mode: "normal",
      edit_intensity: 60,
      emoji_level: 20,
      personality_mode: "friendly",
      language_mode: "auto",
    },
  },
};

/**
 * Get a profile by name.
 * Returns null if not found.
 */
export function getProfile(name) {
  if (!name) return null;
  return PROFILES[name] || null;
}

/**
 * Get all available profile names.
 */
export function getProfileNames() {
  return Object.keys(PROFILES);
}

/**
 * Get all profiles with metadata (for admin panel display).
 */
export function getAllProfiles() {
  return Object.entries(PROFILES).map(([key, profile]) => ({
    key,
    name: profile.name,
    description: profile.description,
  }));
}

/**
 * Build the full system prompt for the Editor stage using a profile.
 * When a profile is active, soul + style + rules REPLACE the individual
 * knowledge base rules.
 */
export function buildProfileEditorPrompt(basePrompt, profileName) {
  const profile = getProfile(profileName);
  if (!profile) return null;

  return [
    basePrompt,
    "",
    "=== PROFILE: " + profile.name + " ===",
    "",
    "--- SOUL (who am I?) ---",
    profile.soul,
    "",
    "--- STYLE (how do I write?) ---",
    profile.style,
    "",
    "--- RULES (what must I never do?) ---",
    profile.rules,
    "",
    "=== END PROFILE ===",
  ].join("\n");
}

/**
 * Build the full system prompt for the Formatter stage using a profile.
 */
export function buildProfileFormatterPrompt(basePrompt, profileName) {
  const profile = getProfile(profileName);
  if (!profile) return null;

  return [
    basePrompt,
    "",
    "=== PROFILE: " + profile.name + " ===",
    "",
    "--- STYLE (how do I format?) ---",
    profile.style,
    "",
    "--- RULES (formatting rules) ---",
    profile.rules,
    "",
    "=== END PROFILE ===",
  ].join("\n");
}
