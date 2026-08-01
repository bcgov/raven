import type { SpoSessionManager } from "./spo-session-manager.js";
import type { AuthenticatedFetch } from "./types.js";
import { setCookieHeader } from "./http-client.js";
import { wrapFetchWithLimits, spoLimiterOpts } from "./rate-limit.js";

/**
 * Check whether a SharePoint Online response indicates an expired or missing
 * auth session (as opposed to a real 403 permission denial).
 *
 * SPO signals cookie expiry with a bare 401 (observed live on the REST API —
 * no WWW-Authenticate or X-Forms_Based_Auth_Required header), with 403 + the
 * X-Forms_Based_Auth_Required header, or by redirecting to the Entra login
 * page.
 */
export function isSpoSessionExpired(response: Response): boolean {
  // Every request through createSpoFetch carries the cookie pair, so an
  // unauthenticated response can only mean the pair is no longer valid.
  if (response.status === 401) return true;
  if (response.status === 403) {
    return response.headers.has("X-Forms_Based_Auth_Required");
  }
  if (response.status === 301 || response.status === 302) {
    const location = (response.headers.get("location") ?? "").toLowerCase();
    return (
      location.includes("login.microsoftonline.com") ||
      location.includes("/_forms/default.aspx")
    );
  }
  return false;
}

/**
 * Create an authenticated fetch that attaches the FedAuth/rtFa cookie pair
 * and handles session expiry with a single automatic re-auth + retry.
 * SPO twin of createAuthenticatedFetch (SMSESSION).
 */
export async function createSpoFetch(
  sessionManager: SpoSessionManager
): Promise<AuthenticatedFetch> {
  // Eagerly resolve once so auth problems surface at client construction.
  await sessionManager.getSession();

  // Session-expiry retries sit OUTSIDE the limiter so it sees exactly one
  // outbound request per SharePoint round-trip.
  const limitedFetch = wrapFetchWithLimits(fetch, spoLimiterOpts());

  const buildHeaders = (init: RequestInit | undefined, cookies: { fedAuth: string; rtFa: string }): Headers => {
    const headers = new Headers(init?.headers);
    setCookieHeader(headers, "FedAuth", cookies.fedAuth);
    setCookieHeader(headers, "rtFa", cookies.rtFa);
    headers.set("User-Agent", sessionManager.userAgent);
    return headers;
  };

  return async (url: string, init?: RequestInit): Promise<Response> => {
    const cookies = await sessionManager.getSession();

    const response = await limitedFetch(url, {
      ...init,
      headers: buildHeaders(init, cookies),
      redirect: "manual", // don't follow redirects (to detect login bounces)
    });

    if (!isSpoSessionExpired(response)) return response;

    await sessionManager.invalidate();
    const fresh = await sessionManager.getSession();

    const retryResponse = await limitedFetch(url, {
      ...init,
      headers: buildHeaders(init, fresh),
      redirect: "manual",
    });

    if (isSpoSessionExpired(retryResponse)) {
      throw new Error(
        "SharePoint session expired and re-authentication failed. " +
          "Run: npx raven-auth --sharepoint"
      );
    }

    return retryResponse;
  };
}
