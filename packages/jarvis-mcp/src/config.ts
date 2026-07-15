/**
 * Pure configuration helpers for the Jarvis proxy.
 *
 * Kept free of side effects (no env loading, no network, no process.exit) so
 * the resolution logic can be unit-tested in isolation from the server
 * entrypoint in index.ts.
 */

/**
 * Default remote Jarvis base host used when JARVIS_BASE_URL is unset.
 * The `/mcp` path is appended by resolveJarvisBaseUrl, so base URLs stay
 * path-free unless a proxy requires otherwise.
 */
export const DEFAULT_JARVIS_BASE_URL = "https://jarvis-api.example.gov.bc.ca";

/**
 * Resolve the Jarvis base URL from the environment, falling back to the
 * default endpoint when JARVIS_BASE_URL is unset or empty.
 *
 * @param env Environment to read from (defaults to process.env).
 */
export function resolveJarvisBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  let url = env.JARVIS_BASE_URL || DEFAULT_JARVIS_BASE_URL;
  while (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
  if (!url.endsWith("/mcp")) {
    url = `${url}/mcp`;
  }
  return url;
}
