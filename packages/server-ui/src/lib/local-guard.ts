/**
 * Local-origin guard for the Server Monitor API (RSEC-005).
 *
 * The dashboard binds to 127.0.0.1, which is not an access control. Two attacks
 * reach a loopback API from an ordinary web page the operator happens to visit:
 *
 * - **CSRF.** A page at evil.example can issue a cross-origin request to
 *   `http://127.0.0.1:3777/api/servers`. Before this guard, that request was
 *   served with the operator's full privileges — enough to read the internal
 *   server inventory (hostnames, SSH usernames, sudo accounts) or to overwrite
 *   `~/bin/servers.conf`.
 * - **DNS rebinding.** A hostname the attacker controls is re-resolved to
 *   127.0.0.1 after the page loads, so the browser treats subsequent requests
 *   as same-origin and sends no cross-origin `Origin` at all. Only the `Host`
 *   header still reveals the deception.
 *
 * The guard therefore checks three headers.
 *
 * - `Host` defeats rebinding.
 * - `Origin` defeats CSRF for fetch/XHR and for every state-changing method.
 * - `Sec-Fetch-Site` covers what `Origin` cannot: browsers omit `Origin` on
 *   no-cors requests (`<img src>`, `<script src>`, `<form method=get>`), which
 *   the Same-Origin Policy keeps unreadable but does not keep from *executing*.
 *   Two GET routes here do SSH work on request, so a blind cross-site GET is a
 *   real trigger. Modern browsers send `Sec-Fetch-Site` on every request; when
 *   it says `cross-site` or `same-site` the request is rejected. When the
 *   header is absent, reads require an acceptable Origin or the custom client
 *   header instead. Missing metadata never grants access by itself.
 *
 * Dashboard fetch calls send `X-Raven-UI: 1`. Native EventSource connections
 * and download links use the browser's `Sec-Fetch-Site: same-origin` metadata.
 */
import type { Request, Response, NextFunction } from "express";

/** Methods that change state and therefore require a positively-verified caller. */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Header a non-browser client may send instead of `Origin`.
 *
 * A browser cannot attach this to a cross-origin request without triggering a
 * CORS preflight, and no preflight is answered here, so it is not a CSRF
 * bypass. It exists so `curl` and scripted checks keep working.
 */
const CLIENT_HEADER = "x-raven-ui";

/**
 * Build the set of `Host` values this server answers to.
 *
 * @param port - Port the dashboard listens on.
 * @returns Acceptable Host header values.
 */
export function allowedHosts(port: number): Set<string> {
  return new Set([
    `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`,
    // Browsers omit HTTP's default port; retain explicit :80 for other clients.
    ...(port === 80 ? ["localhost", "127.0.0.1", "[::1]"] : []),
  ]);
}

/**
 * Build the set of acceptable `Origin` values.
 *
 * @param port - Port the dashboard listens on.
 * @returns Acceptable Origin header values.
 */
export function allowedOrigins(port: number): Set<string> {
  return new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    `http://[::1]:${port}`,
    ...(port === 80 ? ["http://localhost", "http://127.0.0.1", "http://[::1]"] : []),
  ]);
}

/**
 * Decide whether a request may proceed.
 *
 * Exported separately from the middleware so the policy is unit-testable
 * without standing up an Express app.
 *
 * @param method - HTTP method.
 * @param host - Value of the Host header, if any.
 * @param origin - Value of the Origin header, if any.
 * @param hasClientHeader - Whether the custom client header was supplied.
 * @param port - Port the dashboard listens on.
 * @param secFetchSite - Value of the Sec-Fetch-Site header, if any.
 * @returns Null when the request is allowed, otherwise the rejection reason.
 */
export function checkLocalRequest(
  method: string,
  host: string | undefined,
  origin: string | undefined,
  hasClientHeader: boolean,
  port: number,
  secFetchSite?: string,
): string | null {
  // Host is mandatory and must name this loopback listener. This is the
  // rebinding defense: an attacker-controlled hostname fails here even when
  // it resolves to 127.0.0.1.
  if (!host || !allowedHosts(port).has(host.toLowerCase())) {
    return "Invalid Host header";
  }

  // Any request that carries an Origin must carry an acceptable one. This
  // covers fetch/XHR reads and every write; it cannot see no-cors embeds,
  // which carry no Origin at all.
  if (origin !== undefined && !allowedOrigins(port).has(origin.toLowerCase())) {
    return "Cross-origin request denied";
  }

  // No-cors embeds are caught here. `same-site` is rejected too: for a
  // loopback listener that means another local port, which is a different
  // origin and must not be able to drive this one.
  if (secFetchSite !== undefined) {
    const site = secFetchSite.toLowerCase();
    if (site === "cross-site" || site === "same-site") {
      return "Cross-site request denied";
    }
  }

  // A state change needs positive proof of a local caller, not merely the
  // absence of a bad signal.
  if (STATE_CHANGING.has(method.toUpperCase()) && origin === undefined && !hasClientHeader) {
    return `State-changing request requires an Origin header or ${CLIENT_HEADER}: 1`;
  }

  if (origin === undefined && !hasClientHeader && secFetchSite?.toLowerCase() !== "same-origin") {
    return `API request requires an Origin header, same-origin fetch metadata, or ${CLIENT_HEADER}: 1`;
  }

  return null;
}

/**
 * Express middleware enforcing {@link checkLocalRequest}.
 *
 * @param port - Port the dashboard listens on.
 * @returns Middleware that rejects non-local callers with HTTP 403.
 */
export function localGuard(port: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const reason = checkLocalRequest(
      req.method,
      req.headers.host,
      req.headers.origin,
      req.headers[CLIENT_HEADER] !== undefined,
      port,
      req.headers["sec-fetch-site"] as string | undefined,
    );
    if (reason) {
      res.status(403).json({ error: `Forbidden: ${reason}` });
      return;
    }
    next();
  };
}
