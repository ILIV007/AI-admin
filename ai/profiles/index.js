/**
 * ai/profiles/index.js
 * Profile loader.
 */
import { SOUL as ILIVIR3_SOUL } from "./ilivir3/soul.js";
import { STYLE as ILIVIR3_STYLE } from "./ilivir3/style.js";
import { RULES as ILIVIR3_RULES } from "./ilivir3/rules.js";

const PROFILES = {
  ilivir3: {
    name: "ILIVIR3",
    description: "Default ILIVIR3 channel admin — professional, calm, developer-focused",
    soul: ILIVIR3_SOUL,
    style: ILIVIR3_STYLE,
    rules: ILIVIR3_RULES,
    settings: {
      rewrite_mode: "normal",
      edit_intensity: 60,
      emoji_level: 20,
      personality_mode: "friendly",
      language_mode: "auto",
    },
  },
};

export function getProfile(name) {
  if (!name) return null;
  return PROFILES[name] || null;
}

export function getProfileNames() {
  return Object.keys(PROFILES);
}

export function getAllProfiles() {
  return Object.entries(PROFILES).map(([key, profile]) => ({
    key,
    name: profile.name,
    description: profile.description,
  }));
}

export function buildProfileEditorPrompt(basePrompt, profileName) {
  const profile = getProfile(profileName);
  if (!profile) return null;
  return [
    basePrompt,
    "",
    "=== PROFILE: " + profile.name + " ===",
    "",
    "--- SOUL ---",
    profile.soul,
    "",
    "--- STYLE ---",
    profile.style,
    "",
    "--- RULES ---",
    profile.rules,
    "",
    "=== END PROFILE ===",
  ].join("\n");
}
