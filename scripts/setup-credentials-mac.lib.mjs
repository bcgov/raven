// Pure helpers for setup-credentials-mac.mjs, split out for unit testing
// (same pattern as gen-inventory.lib.mjs).

/** Mask a secret for display: first/last two chars, or **** when short. */
export function mask(value) {
  if (value.length <= 4) return "****";
  return value.slice(0, 2) + "*".repeat(value.length - 4) + value.slice(-2);
}

/**
 * Defaults offered at each prompt (kept when the answer is blank).
 * Existing keychain values win over ~/.raven/.env values, and only the
 * prompted credential keys are imported from .env — non-credential tuning
 * config (RATE_LIMIT_*, SMTP_*, …) stays in the plain-text file, where later
 * edits still take effect. Extra keys already in the keychain are preserved.
 */
export function seedDefaults(promptedKeys, envValues, keychainValues) {
  const defaults = {};
  for (const key of promptedKeys) {
    if (envValues[key]) defaults[key] = envValues[key];
  }
  return { ...defaults, ...keychainValues };
}
