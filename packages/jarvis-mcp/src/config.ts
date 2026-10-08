/**
 * Pure configuration helpers for the Jarvis proxy.
 *
 * Kept free of side effects (no env loading, no network, no process.exit) so
 * the resolution logic can be unit-tested in isolation from the server
 * entrypoint in index.ts.
 */

/**
 * Resolve the configured Jarvis base URL, appending `/mcp` if necessary.
 *
 * @param env Environment to read from (defaults to process.env).
 */
export function resolveJarvisBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  let url = env.JARVIS_BASE_URL?.trim();
  if (!url) {
    throw new Error("JARVIS_BASE_URL is required when JARVIS_TOKEN is set.");
  }
  while (url.endsWith("/")) {
    url = url.slice(0, -1);
  }
  if (!url.endsWith("/mcp")) {
    url = `${url}/mcp`;
  }
  return url;
}
