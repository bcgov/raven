import type { SessionManager } from "./session-manager.js";
import type { AuthenticatedFetch } from "./types.js";
import { wrapFetchWithLimits, atlassianLimiterOpts } from "./rate-limit.js";

function setCookie(headers: Headers, name: string, value: string): void {
  const parts = (headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => {
      const separator = part.indexOf("=");
      return separator <= 0 || part.slice(0, separator).toLowerCase() !== name.toLowerCase();
    });
  parts.push(`${name}=${value}`);
  headers.set("Cookie", parts.join("; "));
}

/**
 * Create an authenticated fetch function using HTTP Basic Auth.
 * Used with the BWA URL that bypasses SiteMinder.
 *
 * No session management, no caching, no Playwright — just adds
 * the Authorization header to every request.
 *
 * The returned fetch is wrapped with a per-host rate limiter and 429/
 * Retry-After handling. See `rate-limit.ts`. Tunable via env vars
 * (RATE_LIMIT_ATLASSIAN_BURST, RATE_LIMIT_ATLASSIAN_RPS, etc.).
 *
 * @param email - IDIR email address (e.g., "Jane.Smith@gov.bc.ca")
 * @param password - IDIR password
 * @returns A fetch-like function with Basic Auth header attached
 */
export function createBasicAuthFetch(
  email: string,
  password: string
): AuthenticatedFetch {
  const credentials = btoa(`${email}:${password}`);

  // Wrap the global fetch with rate limiting. The auth-attaching layer
  // sits OUTSIDE the limiter so that 429 retries don't re-add headers.
  const limitedFetch = wrapFetchWithLimits(fetch, atlassianLimiterOpts());

  return async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Basic ${credentials}`);

    return limitedFetch(url, {
      ...init,
      headers,
    });
  };
}

/**
 * Check if a response indicates the SMSESSION has expired.
 * SiteMinder redirects to a login page on expiry.
 *
 * Ported from confluence_mcp.py is_session_expired() (lines 259-266).
 */
export function isSessionExpired(response: Response): boolean;
export function isSessionExpired(body: string): boolean;
export function isSessionExpired(input: Response | string): boolean {
  if (typeof input === "string") {
    const lower = input.toLowerCase();
    return (
      lower.includes("logon") ||
      input.includes("302") ||
      input.includes("fedLaunch")
    );
  }

  // HTTP redirect to login page
  if (input.status === 302 || input.status === 301) {
    const location = input.headers.get("location") ?? "";
    return (
      location.toLowerCase().includes("logon") ||
      location.includes("fedLaunch")
    );
  }

  return false;
}

/**
 * Create an authenticated fetch function that attaches the SMSESSION
 * cookie and handles session expiry with automatic retry.
 *
 * @param sessionManager - The session manager to get cookies from
 * @param baseUrl - Base URL for requests (used for session validation)
 * @returns A fetch-like function with auth cookie attached
 */
export async function createAuthenticatedFetch(
  sessionManager: SessionManager
): Promise<AuthenticatedFetch> {
  const cookie = await sessionManager.getSession();
  // Wrap the global fetch with rate limiting. Session-management retries
  // (re-fetch on session expiry) sit OUTSIDE this so the limiter sees
  // exactly one outbound request per Atlassian round-trip.
  const limitedFetch = wrapFetchWithLimits(fetch, atlassianLimiterOpts());

  const authenticatedFetch: AuthenticatedFetch = async (
    url: string,
    init?: RequestInit
  ): Promise<Response> => {
    const currentCookie = await sessionManager.getSession();

    const headers = new Headers(init?.headers);
    setCookie(headers, "SMSESSION", currentCookie);
    headers.set("User-Agent", sessionManager.userAgent);

    const response = await limitedFetch(url, {
      ...init,
      headers,
      redirect: "manual", // Don't follow redirects (to detect SiteMinder login)
    });

    // Check for session expiry
    if (isSessionExpired(response)) {
      // Invalidate and retry once
      await sessionManager.invalidate();
      const freshCookie = await sessionManager.getSession();

      const retryHeaders = new Headers(init?.headers);
      setCookie(retryHeaders, "SMSESSION", freshCookie);
      retryHeaders.set("User-Agent", sessionManager.userAgent);

      const retryResponse = await limitedFetch(url, {
        ...init,
        headers: retryHeaders,
        redirect: "manual",
      });

      if (isSessionExpired(retryResponse)) {
        throw new Error(
          "Session expired and re-authentication failed. Please try again."
        );
      }

      return retryResponse;
    }

    return response;
  };

  // Eagerly validate the session works
  void cookie;

  return authenticatedFetch;
}
