/** Identify dashboard requests even when the browser omits fetch metadata. */
export function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  headers.set('X-Raven-UI', '1');
  return fetch(url, { ...options, headers });
}
