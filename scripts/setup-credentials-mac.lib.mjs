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

/**
 * Normalize one prompt answer before it is stored. Sensitive answers
 * (passwords, tokens) are kept verbatim — leading/trailing whitespace can be
 * part of the real secret — except for a trailing "\r" that some terminals
 * leave on the line; readline's `question` callback already strips the
 * newline itself. Non-sensitive answers are trimmed as before.
 */
export function normalizeAnswer(answer, { sensitive = false } = {}) {
  if (sensitive) {
    return answer.endsWith("\r") ? answer.slice(0, -1) : answer;
  }
  return answer.trim();
}

/**
 * Validation errors for the merged credential record, checked after every
 * prompt has resolved so a value kept from the keychain (blank answer) is
 * covered as well as one just typed. Returns an empty array when valid.
 */
export function validateRecord(record) {
  const errors = [];
  if (!record.ATLASSIAN_BASE_URL || !record.ATLASSIAN_EMAIL || !record.ATLASSIAN_PASSWORD) {
    errors.push("ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD are required.");
  }
  if (record.GITHUB_TOKEN && !record.GITHUB_REPOSITORY_ALLOWLIST) {
    errors.push("GITHUB_REPOSITORY_ALLOWLIST is required when configuring GITHUB_TOKEN.");
  }
  return errors;
}
