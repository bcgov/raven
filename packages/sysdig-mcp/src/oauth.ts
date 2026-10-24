import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const execFileAsync = promisify(execFile);
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface PendingCallback {
  expectedState: string;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class SysdigOAuthCallback {
  private server: HttpServer | undefined;
  private redirectUri: string | undefined;
  private pending: PendingCallback | undefined;

  async listen(): Promise<string> {
    if (this.server && this.redirectUri) return this.redirectUri;

    this.server = createServer((request, response) => this.handleRequest(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        this.server!.off("error", reject);
        resolve();
      });
    });

    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start the local Sysdig OAuth callback.");
    }
    this.redirectUri = `http://127.0.0.1:${address.port}/callback`;
    return this.redirectUri;
  }

  waitForCode(expectedState: string): Promise<string> {
    if (this.pending) throw new Error("A Sysdig OAuth callback is already pending.");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = undefined;
        reject(new Error("Sysdig OAuth authorization timed out."));
      }, CALLBACK_TIMEOUT_MS);
      timeout.unref();
      this.pending = { expectedState, resolve, reject, timeout };
    });
  }

  async close(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending.timeout);
      this.pending.reject(new Error("Sysdig OAuth callback server closed."));
      this.pending = undefined;
    }
    const server = this.server;
    this.server = undefined;
    this.redirectUri = undefined;
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  private handleRequest(request: IncomingMessage, response: import("node:http").ServerResponse): void {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || requestUrl.pathname !== "/callback" || !this.pending) {
      response.writeHead(404);
      response.end();
      return;
    }

    if (requestUrl.searchParams.get("state") !== this.pending.expectedState) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("OAuth state mismatch.");
      return;
    }

    const error = requestUrl.searchParams.get("error");
    if (error) {
      this.settlePending(new Error("Sysdig OAuth authorization was denied."));
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Authorization was not completed. Return to Raven for details.");
      return;
    }

    const code = requestUrl.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("Missing authorization code.");
      return;
    }

    this.settlePending(undefined, code);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Sysdig connected</title><p>Sysdig sign-in complete. You can close this tab.</p>");
  }

  private settlePending(error?: Error, code?: string): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending = undefined;
    if (error) pending.reject(error);
    else if (code) pending.resolve(code);
  }
}

class EphemeralSysdigOAuthProvider implements OAuthClientProvider {
  private clientInfo: OAuthClientInformationMixed | undefined;
  private oauthTokens: OAuthTokens | undefined;
  private verifier: string | undefined;
  private discovery: OAuthDiscoveryState | undefined;
  private expectedState: string | undefined;
  private authorizationCode: Promise<string> | undefined;

  constructor(
    private readonly callback: SysdigOAuthCallback,
    private readonly callbackUrl: string,
  ) {}

  get redirectUrl(): string {
    return this.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Raven Sysdig Read-only MCP",
      redirect_uris: [this.callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    this.expectedState = randomBytes(32).toString("base64url");
    return this.expectedState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.clientInfo = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this.oauthTokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.oauthTokens = tokens;
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.verifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error("Sysdig OAuth code verifier is missing.");
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.expectedState) throw new Error("Sysdig OAuth state was not initialized.");
    this.authorizationCode = this.callback.waitForCode(this.expectedState);
    process.stderr.write("[sysdig-mcp] Opening browser for Sysdig OAuth sign-in.\n");
    try {
      await openBrowser(authorizationUrl.toString());
    } catch {
      process.stderr.write(
        `[sysdig-mcp] Could not launch a browser automatically. Open this URL to authorize:\n${authorizationUrl.toString()}\n`,
      );
    }
  }

  waitForAuthorizationCode(): Promise<string> {
    if (!this.authorizationCode) throw new Error("Sysdig OAuth authorization did not start.");
    return this.authorizationCode;
  }
}

async function openBrowser(url: string): Promise<void> {
  const wsl = Boolean(process.env["WSL_DISTRO_NAME"]);
  const command =
    process.platform === "win32" || wsl
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const args = command === "rundll32.exe" ? ["url.dll,FileProtocolHandler", url] : [url];
  await execFileAsync(command, args, { windowsHide: true });
}

export interface ConnectedSysdigClient {
  client: Client;
  close(): Promise<void>;
}

export async function connectSysdigClient(serverUrl: URL): Promise<ConnectedSysdigClient> {
  const callback = new SysdigOAuthCallback();
  let client: Client | undefined;
  try {
    const redirectUrl = await callback.listen();
    const authProvider = new EphemeralSysdigOAuthProvider(callback, redirectUrl);
    client = new Client({ name: "raven-sysdig-readonly-proxy", version: "0.2.0" }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(serverUrl, { authProvider });

    try {
      await client.connect(transport);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const authorizationCode = await authProvider.waitForAuthorizationCode();
      await transport.finishAuth(authorizationCode);
      await client.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider }));
    }

    return {
      client,
      close: async () => {
        await client?.close();
        await callback.close();
      },
    };
  } catch (error) {
    await client?.close().catch(() => {});
    await callback.close().catch(() => {});
    throw error;
  }
}
