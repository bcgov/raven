import type {
  CssClientConfig,
  CssEnvironment,
  CssIntegration,
  CssRole,
  CssUser,
  IdirSearch,
} from "./types.js";

/** Refresh the token this long before CSS says it expires. */
const TOKEN_EXPIRY_BUFFER_MS = 30_000;
/** Used when the token response carries no `expires_in`. */
const DEFAULT_TOKEN_LIFETIME_MS = 5 * 60_000;
/** Longest error body echoed back to the caller. */
const MAX_ERROR_BODY = 500;

/**
 * Encode one path segment. `@` is left as-is: it is legal in a path segment
 * and is part of every federated username (`<guid>@azureidir`).
 */
function seg(value: string | number): string {
  return encodeURIComponent(String(value)).replace(/%40/g, "@");
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

  /**
   * @param config - API account credentials and endpoint URLs.
   * @param fetchFn - Optional fetch implementation, for tests.
   */
  constructor(config: CssClientConfig, fetchFn?: typeof globalThis.fetch) {
    this.config = { ...config, apiUrl: config.apiUrl.replace(/\/+$/, "") };
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  /** Lists the Gold integrations owned by the API account's team. */
  async listIntegrations(): Promise<CssIntegration[]> {
    return this.getList<CssIntegration>("/integrations");
  }

  /** Lists the roles defined on one integration environment. */
  async listRoles(integrationId: number, env: CssEnvironment): Promise<CssRole[]> {
    return this.getList<CssRole>(`/integrations/${seg(integrationId)}/${seg(env)}/roles`);
  }

  /** Lists the users holding one role. */
  async listRoleUsers(integrationId: number, env: CssEnvironment, roleName: string): Promise<CssUser[]> {
    return this.getList<CssUser>(
      `/integrations/${seg(integrationId)}/${seg(env)}/roles/${seg(roleName)}/users`,
    );
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
    return (body as CssRole | null) ?? { name: roleName };
  }

  /**
   * Assigns roles to a user. Uses `roles-new`, which verifies the username
   * against the identity provider and creates the user record if needed, so
   * it works before the user's first login. Only `azureidir` and
   * `bceidbusiness` usernames are accepted by CSS.
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

  private async getList<T>(path: string): Promise<T[]> {
    const body = (await this.request("GET", path)) as { data?: T[] | null } | null;
    return body?.data ?? [];
  }

  private async request(method: string, path: string, payload?: unknown): Promise<unknown> {
    let resp = await this.send(method, path, payload);
    if (resp.status === 401) {
      // A token revoked or expired early: fetch a fresh one and retry once.
      this.token = null;
      resp = await this.send(method, path, payload);
    }

    const text = await resp.text().catch(() => "");
    if (!resp.ok) {
      const route = path.split("?")[0];
      throw new Error(
        `CSS API ${resp.status} ${resp.statusText} on ${method} ${route}: ${text.slice(0, MAX_ERROR_BODY)}`,
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  private async send(method: string, path: string, payload?: unknown): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      Accept: "application/json",
    };
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    return this.fetchFn(`${this.config.apiUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const resp = await this.fetchFn(this.config.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
    });
    if (!resp.ok) {
      // The token endpoint's body can echo request details; report status only.
      throw new Error(
        `CSS token request failed: ${resp.status} ${resp.statusText}. Check CSS_API_CLIENT_ID / CSS_API_CLIENT_SECRET.`,
      );
    }
    const json = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new Error("CSS token response contained no access_token.");

    const lifetime = json.expires_in ? json.expires_in * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + lifetime - TOKEN_EXPIRY_BUFFER_MS;
    return this.token;
  }
}
