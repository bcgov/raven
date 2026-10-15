import { limiterOptsFromEnv, parseRetryAfter, wrapFetchWithLimits } from "@nrs/auth";
import type {
  CssClientConfig,
  CssEnvironment,
  CssIntegration,
  CssRole,
  CssUser,
  CssUserList,
  IdirSearch,
} from "./types.js";

/** Refresh the token this long before CSS says it expires. */
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
/** Used when the token response carries no usable `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_MS = 5 * 60_000;
/** After the token endpoint rejects the credentials, do not present them again for this long. */
const TOKEN_REJECTION_COOLDOWN_MS = 60_000;
/** Longest error body echoed back to the caller. */
const MAX_ERROR_BODY = 500;
/** Per-request deadline; CSS answers in well under a second normally. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** CSS pages role holders 50 at a time; this is its documented default page size. */
export const ROLE_USERS_PAGE_SIZE = 50;
/** Hard stop on a page walk, so a misbehaving upstream cannot spin the client. */
export const MAX_ROLE_USER_PAGES = 20;

/** Statuses the shared limiter puts on its own synthetic 429s. */
const LOCAL_LIMIT_STATUS = new Set(["Local Throttle", "Circuit Open"]);

/**
 * Per-host limiter for the CSS API. No wrapper-level 429 retries: they would
 * reuse this client's per-request timeout signal across their sleeps, and the
 * client already reports Retry-After itself.
 */
function cssLimiterOpts() {
  return { ...limiterOptsFromEnv("CSS", { burst: 10, rps: 5 }), maxRetriesOn429: 0 };
}

/**
 * Flatten upstream text before it reaches an assistant: control and format
 * characters (bidi overrides, zero-width joiners and the like) and backticks
 * become spaces, so a crafted name cannot break out of a code span, render
 * reversed, or add lines to a listing. One helper for both tool output and
 * error bodies, so the two cannot drift.
 */
export function stripUnsafe(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}`]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate an endpoint URL. HTTPS only, and nothing but scheme, host and
 * path: every request carries either the client secret or a bearer token.
 *
 * @param value - URL from configuration.
 * @param name - Setting name, for the error message.
 * @returns The URL without trailing slashes.
 */
export function requireHttpsUrl(value: string, name: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`${name} must be a valid absolute HTTPS URL.`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`${name} must use HTTPS; refusing to send credentials over an insecure connection.`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, a query string or a fragment.`);
  }
  return trimmed;
}

/**
 * The team secret only ever goes to BC Gov hosts. A local test double needs
 * the explicit `allowAnyHost` opt-out, so a tampered or mistyped URL cannot
 * redirect it, whoever constructs the client.
 */
export function assertTrustedHost(url: string, name: string): void {
  const host = new URL(url).hostname.toLowerCase();
  if (host !== "gov.bc.ca" && !host.endsWith(".gov.bc.ca")) {
    throw new Error(
      `${name} must point at a *.gov.bc.ca host (got ${host}). Set CSS_ALLOW_ANY_HOST=true only for a local test double.`,
    );
  }
}

/**
 * Encode one path segment. `@` is left as-is: it is legal in a path segment
 * and is part of every federated username (`<guid>@azureidir`). Dot segments
 * are refused outright, because the URL parser would fold them into the path
 * and move the request to a different route.
 */
function seg(value: string | number): string {
  const s = String(value);
  if (s === "." || s === "..") throw new Error("Invalid path segment.");
  return encodeURIComponent(s).replace(/%40/g, "@");
}

/** The route without its query string, for error messages. */
const route = (path: string): string => path.split("?")[0];

/** An upstream body fit for an error message. */
const snippet = (text: string): string => stripUnsafe(text.slice(0, MAX_ERROR_BODY));

function retryAfterText(resp: Response): string {
  const ms = parseRetryAfter(resp.headers.get("retry-after"));
  return ms !== undefined && ms >= 0 ? ` after ${Math.ceil(ms / 1000)} s` : " later";
}

/** Release a body we will not read, so the connection can be reused. */
async function discard(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // best effort
  }
}

/**
 * REST client for the CSS (Common Hosted Single Sign-On) API.
 *
 * Authenticates with a team API account via client credentials. The account
 * reaches only the Gold integrations owned by its team. Endpoint paths follow
 * those bcgov/nr-fam calls in production, which differ from the older
 * sso-requests proposal doc for user-role operations.
 */
export class CssClient {
  private readonly config: CssClientConfig;
  private readonly fetchFn: typeof globalThis.fetch;
  private token: string | null = null;
  private tokenExpiresAt = 0;
  private tokenPromise: Promise<string> | null = null;
  private tokenRejectedUntil = 0;
  private tokenRejection = "";

  /**
   * @param config - API account credentials and endpoint URLs.
   * @param fetchFn - Optional fetch implementation, for tests. Production
   *   traffic goes through the shared per-host rate limiter.
   */
  constructor(config: CssClientConfig, fetchFn?: typeof globalThis.fetch) {
    const apiUrl = requireHttpsUrl(config.apiUrl, "CSS_API_URL");
    const tokenUrl = requireHttpsUrl(config.tokenUrl, "CSS_TOKEN_URL");
    if (!config.allowAnyHost) {
      assertTrustedHost(apiUrl, "CSS_API_URL");
      assertTrustedHost(tokenUrl, "CSS_TOKEN_URL");
    }
    this.config = { ...config, apiUrl, tokenUrl };
    this.fetchFn = fetchFn ?? wrapFetchWithLimits(globalThis.fetch, cssLimiterOpts());
  }

  /** Lists the Gold integrations owned by the API account's team. */
  async listIntegrations(): Promise<CssIntegration[]> {
    return this.getList<CssIntegration>("/integrations");
  }

  /** Lists the roles defined on one integration environment. */
  async listRoles(integrationId: number, env: CssEnvironment): Promise<CssRole[]> {
    return this.getList<CssRole>(`/integrations/${seg(integrationId)}/${seg(env)}/roles`);
  }

  /**
   * Lists the users holding one role, walking CSS's pages until a short page
   * or `limit` rows. `more` is true when more holders may exist beyond what
   * was returned.
   */
  async listRoleUsers(
    integrationId: number,
    env: CssEnvironment,
    roleName: string,
    limit = ROLE_USERS_PAGE_SIZE * MAX_ROLE_USER_PAGES,
  ): Promise<CssUserList> {
    const base = `/integrations/${seg(integrationId)}/${seg(env)}/roles/${seg(roleName)}/users`;
    const users: CssUser[] = [];
    for (let page = 1; page <= MAX_ROLE_USER_PAGES; page++) {
      const batch = await this.getList<CssUser>(`${base}?page=${page}&max=${ROLE_USERS_PAGE_SIZE}`);
      users.push(...batch);
      if (users.length >= limit) {
        // At the limit: rows beyond it, or a full page, mean more may exist.
        return { users: users.slice(0, limit), more: users.length > limit || batch.length >= ROLE_USERS_PAGE_SIZE };
      }
      if (batch.length < ROLE_USERS_PAGE_SIZE) return { users, more: false };
    }
    return { users: users.slice(0, limit), more: true };
  }

  /** Lists the roles one user holds on one integration environment. */
  async listUserRoles(integrationId: number, env: CssEnvironment, username: string): Promise<CssRole[]> {
    return this.getList<CssRole>(
      `/integrations/${seg(integrationId)}/${seg(env)}/users/${seg(username)}/roles`,
    );
  }

  /** Searches the IDIR (Azure AD) directory for the given environment. */
  async searchIdirUsers(env: CssEnvironment, criteria: IdirSearch): Promise<CssUser[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(criteria)) {
      if (value) params.set(key, value);
    }
    if ([...params.keys()].length === 0) {
      throw new Error("Provide at least one of firstName, lastName, email or guid.");
    }
    return this.getList<CssUser>(`/${seg(env)}/azure-idir/users?${params.toString()}`);
  }

  /** Creates a role on one integration environment. */
  async createRole(integrationId: number, env: CssEnvironment, roleName: string): Promise<CssRole> {
    const body = await this.request(
      "POST",
      `/integrations/${seg(integrationId)}/${seg(env)}/roles`,
      { name: roleName },
    );
    const name = (body as { name?: unknown } | null)?.name;
    return typeof name === "string" && name ? (body as CssRole) : { name: roleName };
  }

  /**
   * Assigns roles to a user. Uses `roles-new`, which verifies the username
   * against the identity provider and creates the user record if needed, so
   * it works before the user's first login. Only `azureidir` and
   * `bceidbusiness` usernames are accepted by CSS. Callers should re-read the
   * user's roles afterwards: the response says nothing about what was applied.
   */
  async assignUserRoles(
    integrationId: number,
    env: CssEnvironment,
    username: string,
    roleNames: string[],
  ): Promise<void> {
    await this.request(
      "POST",
      `/integrations/${seg(integrationId)}/${seg(env)}/users/${seg(username)}/roles-new`,
      roleNames.map((name) => ({ name })),
    );
  }

  /** Removes one role from one user. The role stays defined on the integration. */
  async removeUserRole(
    integrationId: number,
    env: CssEnvironment,
    username: string,
    roleName: string,
  ): Promise<void> {
    await this.request(
      "DELETE",
      `/integrations/${seg(integrationId)}/${seg(env)}/users/${seg(username)}/roles/${seg(roleName)}`,
    );
  }

  /** GET a collection. Every CSS list route wraps its rows in `data`; anything else is an error, not an empty list. */
  private async getList<T>(path: string): Promise<T[]> {
    const body = await this.request("GET", path);
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) {
      throw new Error(`Unexpected response shape on GET ${route(path)}: expected a "data" array.`);
    }
    return data as T[];
  }

  private async request(method: string, path: string, payload?: unknown): Promise<unknown> {
    const token = await this.accessToken();
    let resp = await this.send(method, path, token, payload);
    if (resp.status === 401) {
      // A token revoked or expired early: release this response and retry once with a fresh one.
      await discard(resp);
      // Only drop the cached token if it is still the one that just failed; a parallel caller may have minted a new one.
      if (this.token === token) this.token = null;
      resp = await this.send(method, path, await this.accessToken(), payload);
    }

    const r = route(path);
    if (resp.status >= 300 && resp.status < 400) {
      // Never follow a redirect with the bearer token attached.
      await discard(resp);
      throw new Error(`CSS API returned an unexpected redirect (${resp.status}) on ${method} ${r}.`);
    }
    if (resp.status === 429) {
      const local = LOCAL_LIMIT_STATUS.has(resp.statusText);
      const wait = retryAfterText(resp);
      await discard(resp);
      throw new Error(
        local
          ? `RAVEN's local rate limiter refused ${method} ${r} (${resp.statusText}); wait a few seconds and retry.`
          : `CSS API rate limited (429 ${resp.statusText}) on ${method} ${r}; retry${wait}.`,
      );
    }

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      throw new Error(`CSS API ${resp.status} ${resp.statusText} on ${method} ${r}: ${snippet(text)}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      // A proxy or maintenance page answering 200 must not read as an empty result.
      throw new Error(
        `CSS API returned a non-JSON ${resp.status} response on ${method} ${r} (content-type: ${resp.headers.get("content-type") ?? "unknown"}).`,
      );
    }
  }

  private async send(method: string, path: string, token: string, payload?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    return this.fetchFn(`${this.config.apiUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * A valid bearer token: cached until near expiry, fetched once however many
   * callers arrive together, and not re-requested for a while after the
   * endpoint has rejected the credentials.
   */
  private accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return Promise.resolve(this.token);
    if (Date.now() < this.tokenRejectedUntil) return Promise.reject(new Error(this.tokenRejection));
    this.tokenPromise ??= this.fetchToken().finally(() => {
      this.tokenPromise = null;
    });
    return this.tokenPromise;
  }

  private async fetchToken(): Promise<string> {
    const resp = await this.fetchFn(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // The token endpoint's body can echo request details; report status only.
    if (resp.status >= 300 && resp.status < 400) {
      await discard(resp);
      throw new Error("CSS token endpoint returned an unexpected redirect; check CSS_TOKEN_URL.");
    }
    if (resp.status === 400 || resp.status === 401) {
      // Keycloak names the reason in `error` (e.g. invalid_client); that word is safe to show, the rest of the body is not.
      const text = await resp.text().catch(() => "");
      let code = "";
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string" && /^[a-z_]+$/.test(parsed.error)) code = ` ${parsed.error}`;
      } catch {
        // not JSON
      }
      this.tokenRejection =
        `CSS token request was rejected (${resp.status}${code}). Check CSS_API_CLIENT_ID / CSS_API_CLIENT_SECRET; ` +
        `not retrying for ${TOKEN_REJECTION_COOLDOWN_MS / 1000} s.`;
      this.tokenRejectedUntil = Date.now() + TOKEN_REJECTION_COOLDOWN_MS;
      throw new Error(this.tokenRejection);
    }
    if (!resp.ok) {
      const wait = retryAfterText(resp);
      await discard(resp);
      throw new Error(`CSS token endpoint unavailable (${resp.status} ${resp.statusText}); retry${wait}.`);
    }

    const text = await resp.text().catch(() => "");
    let json: { access_token?: unknown; expires_in?: unknown };
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("CSS token response was not JSON; check CSS_TOKEN_URL.");
    }
    if (typeof json.access_token !== "string" || !json.access_token) {
      throw new Error("CSS token response contained no access_token.");
    }

    const lifetime =
      typeof json.expires_in === "number" && json.expires_in > 0
        ? json.expires_in * 1000
        : DEFAULT_TOKEN_LIFETIME_MS;
    // Refresh ahead of expiry, but keep even a short-lived token for half its life
    // rather than minting one per request.
    const ttl = Math.max(lifetime - TOKEN_EXPIRY_BUFFER_MS, Math.floor(lifetime / 2));
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + ttl;
    this.tokenRejectedUntil = 0;
    return this.token;
  }
}
