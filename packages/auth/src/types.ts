import type { AuthLockOptions } from "./auth-lock.js";

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
  /** Cross-process lock serialising captures on the shared browser profile (default: beside the profile) */
  lockPath?: string;
  /** Tuning for that lock: stale limit, how long to wait for another login, poll interval */
  lockOptions?: AuthLockOptions;
}

/** Options for a manager's `authenticate()`. */
export interface AuthenticateOptions {
  /**
   * True for an explicit request from a person (the `raven-auth` command):
   * a login that failed in the last 30 seconds does not stop it, and a login
   * that cannot be cached is an error, because leaving a session in the cache
   * for the other tools is the point of the command. Unattended callers
   * (`getSession()`) leave it unset: they honour the cooldown, and keep a
   * login they could not cache for their own process.
   */
  readonly interactive?: boolean;
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

/** SharePoint Online auth cookie pair captured from a browser login. */
export interface SpoCookies {
  fedAuth: string;
  rtFa: string;
}

/** Cached SPO session data persisted to ~/.workflow-suite/spo-session.json */
export interface SpoSessionData {
  fedAuth: string;
  rtFa: string;
  cachedAt: number;
  capturedFor: string;
}

/** Configuration for SharePoint Online auth. */
export interface SpoAuthConfig {
  /** SharePoint tenant root URL (e.g. https://example.sharepoint.com) */
  targetUrl: string;
  /** Path to the SPO session cache file */
  cachePath: string;
  /** Session TTL in seconds (default: 28800 = 8 hours) */
  sessionTtlSeconds: number;
  /** Cross-process lock serialising captures on the shared browser profile (default: beside the profile) */
  lockPath?: string;
  /** Tuning for that lock: stale limit, how long to wait for another login, poll interval */
  lockOptions?: AuthLockOptions;
}
