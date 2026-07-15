/**
 * Valid Bitbucket project keys — placeholder sample.
 *
 * Replace these with your organization's Bitbucket project keys. The list is
 * used only to avoid searching non-existent projects; an empty or partial set
 * merely narrows what the pipeline searches — it never throws.
 */
export const BITBUCKET_PROJECT_KEYS = new Set([
  "PROJA", "PROJB", "PROJC", "PROJD", "PROJE",
  "DEMO", "EXAMPLE", "SANDBOX",
]);

/** Check if a project key is valid. */
export function isValidProject(key: string): boolean {
  return BITBUCKET_PROJECT_KEYS.has(key);
}
