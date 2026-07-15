/** Cached session data persisted to ~/.workflow-suite/session.json */
export interface SessionData {
  smsession: string;
  cachedAt: number;
  capturedFor: string;
}

/** Configuration for the auth module */
export interface AuthConfig {
  /** Base URL for the Atlassian service to authenticate against */
  targetUrl: string;
  /** Path to the session cache file */
  cachePath: string;
  /** Session TTL in seconds (default: 1500 = 25 minutes) */
  sessionTtlSeconds: number;
}

/** Result from the Playwright auth subprocess */
export interface AuthResult {
  status: "ok" | "error";
  smsession?: string;
  message?: string;
}

/** A fetch-like function with authentication attached */
export type AuthenticatedFetch = (
  url: string,
  init?: RequestInit
) => Promise<Response>;

/** Configuration for Basic Auth (email + IDIR password via BWA URL) */
export interface BasicAuthConfig {
  email: string;
  password: string;
}
