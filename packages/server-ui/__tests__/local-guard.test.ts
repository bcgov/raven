import { describe, it, expect } from "vitest";
import { checkLocalRequest, allowedHosts, allowedOrigins } from "../src/lib/local-guard.js";

/**
 * RSEC-005 regression suite.
 *
 * Binding to 127.0.0.1 is not access control. Before this guard, any web page
 * the operator visited could read the internal server inventory or overwrite
 * ~/bin/servers.conf via a cross-origin request to the dashboard API.
 */
const PORT = 3777;
const OK_HOST = `127.0.0.1:${PORT}`;
const OK_ORIGIN = `http://127.0.0.1:${PORT}`;

describe("allowedHosts / allowedOrigins", () => {
  it("covers the loopback spellings the browser may use", () => {
    expect(allowedHosts(PORT)).toEqual(new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]));
    expect(allowedOrigins(PORT).has(`http://localhost:${PORT}`)).toBe(true);
  });

  it("is port-specific", () => {
    expect(allowedHosts(PORT).has("127.0.0.1:9999")).toBe(false);
  });
});

describe.each(["localhost", "127.0.0.1", "[::1]"])("HTTP port 80 — %s", (loopback) => {
  const url = new URL(`http://${loopback}:80/`);
  const explicitHost = `${loopback}:80`;
  const explicitOrigin = `http://${explicitHost}`;

  it("accepts browser-canonical reads and writes while retaining explicit :80 clients", () => {
    expect(url.host).toBe(loopback);
    expect(url.origin).toBe(`http://${loopback}`);
    expect(checkLocalRequest("GET", url.host, undefined, false, 80, "same-origin")).toBeNull();
    for (const host of [url.host, explicitHost]) {
      for (const origin of [url.origin, explicitOrigin]) {
        for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
          expect(checkLocalRequest(method, host, origin, false, 80, "same-origin")).toBeNull();
        }
      }
    }
  });

  it("does not allow a missing port on a nondefault listener", () => {
    expect(checkLocalRequest("GET", url.host, undefined, false, PORT)).toBe("Invalid Host header");
    expect(checkLocalRequest("PUT", `${loopback}:${PORT}`, url.origin, false, PORT))
      .toBe("Cross-origin request denied");
  });

  it("continues rejecting foreign ports and HTTPS origins", () => {
    expect(checkLocalRequest("GET", `${loopback}:${PORT}`, undefined, false, 80))
      .toBe("Invalid Host header");
    for (const origin of [`http://${loopback}:${PORT}`, `https://${loopback}`, `https://${loopback}:80`]) {
      expect(checkLocalRequest("PUT", url.host, origin, false, 80)).toBe("Cross-origin request denied");
    }
  });

  it("still requires positive caller proof for writes and rejects cross-site reads", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(checkLocalRequest(method, url.host, undefined, false, 80)).toContain("requires an Origin header");
      expect(checkLocalRequest(method, url.host, undefined, true, 80)).toBeNull();
    }
    for (const site of ["cross-site", "same-site"]) {
      expect(checkLocalRequest("GET", url.host, undefined, false, 80, site)).toBe("Cross-site request denied");
    }
  });
});

describe("HTTP port 80 — exact loopback allowlists", () => {
  it("adds only portless loopback spellings", () => {
    const hosts = ["localhost", "127.0.0.1", "[::1]"];
    expect(allowedHosts(80)).toEqual(new Set(hosts.flatMap((host) => [host, `${host}:80`])));
    expect(allowedOrigins(80)).toEqual(new Set(hosts.flatMap((host) => [`http://${host}`, `http://${host}:80`])));
  });

  it.each(["evil.example", "localhost.evil.example", "127.0.0.1.evil.example"])("denies rebinding host %s", (host) => {
    expect(checkLocalRequest("PUT", host, `http://${host}`, false, 80)).toBe("Invalid Host header");
  });

  it.each(["http://localhost:080", "http://localhost/", "http://user@localhost", "http://127.1", " http://localhost"])("does not normalize an unlisted Origin: %s", (origin) => {
    expect(checkLocalRequest("PUT", "localhost", origin, false, 80)).toBe("Cross-origin request denied");
  });
});

describe("checkLocalRequest — reads", () => {
  it("allows a same-origin GET", () => {
    expect(checkLocalRequest("GET", OK_HOST, OK_ORIGIN, false, PORT)).toBeNull();
  });

  it("allows a GET with no Origin, which browsers omit for same-origin reads", () => {
    expect(checkLocalRequest("GET", OK_HOST, undefined, false, PORT)).toBeNull();
  });

  it("denies a cross-origin GET", () => {
    expect(checkLocalRequest("GET", OK_HOST, "https://evil.example", false, PORT))
      .toBe("Cross-origin request denied");
  });
});

describe("checkLocalRequest — DNS rebinding", () => {
  it("denies a request whose Host is an attacker hostname", () => {
    // The hostname resolves to 127.0.0.1, so the browser believes it is
    // same-origin and sends no cross-origin Origin. Only Host gives it away.
    expect(checkLocalRequest("GET", "evil.example", undefined, false, PORT))
      .toBe("Invalid Host header");
  });

  it("denies a request with no Host at all", () => {
    expect(checkLocalRequest("GET", undefined, undefined, false, PORT))
      .toBe("Invalid Host header");
  });

  it("denies a rebound request even when it carries a matching Origin", () => {
    expect(checkLocalRequest("POST", "evil.example", "http://evil.example", false, PORT))
      .toBe("Invalid Host header");
  });
});

describe("checkLocalRequest — state changes (CSRF)", () => {
  it("allows a same-origin PUT, which the dashboard sends with an Origin", () => {
    expect(checkLocalRequest("PUT", OK_HOST, OK_ORIGIN, false, PORT)).toBeNull();
  });

  it("denies a cross-origin POST", () => {
    expect(checkLocalRequest("POST", OK_HOST, "https://evil.example", false, PORT))
      .toBe("Cross-origin request denied");
  });

  it("denies a state change that carries no Origin and no client header", () => {
    const reason = checkLocalRequest("DELETE", OK_HOST, undefined, false, PORT);
    expect(reason).toContain("requires an Origin header");
  });

  it("allows a non-browser client that opts in with the custom header", () => {
    expect(checkLocalRequest("DELETE", OK_HOST, undefined, true, PORT)).toBeNull();
  });

  it("covers every state-changing verb", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "delete"]) {
      expect(checkLocalRequest(method, OK_HOST, "https://evil.example", false, PORT))
        .toBe("Cross-origin request denied");
    }
  });
});

// ---------------------------------------------------------------------------
// Review follow-up (Issue 4): browsers omit Origin on no-cors requests
// (<img src>, <script src>, <form method=get>), so those passed on Host alone
// and could trigger GET routes that do SSH work. Sec-Fetch-Site is the
// signal that survives.
// ---------------------------------------------------------------------------

describe("checkLocalRequest — Sec-Fetch-Site (no-cors embeds)", () => {
  it("denies a cross-site no-cors GET that carries no Origin", () => {
    expect(checkLocalRequest("GET", OK_HOST, undefined, false, PORT, "cross-site"))
      .toBe("Cross-site request denied");
  });

  it("denies same-site (another local port) too", () => {
    expect(checkLocalRequest("GET", OK_HOST, undefined, false, PORT, "same-site"))
      .toBe("Cross-site request denied");
  });

  it("allows same-origin and user-initiated navigations", () => {
    expect(checkLocalRequest("GET", OK_HOST, undefined, false, PORT, "same-origin")).toBeNull();
    expect(checkLocalRequest("GET", OK_HOST, undefined, false, PORT, "none")).toBeNull();
  });

  it("fails open when the header is absent, since Origin still governs writes", () => {
    expect(checkLocalRequest("GET", OK_HOST, undefined, false, PORT, undefined)).toBeNull();
  });

  it("applies to state changes as well", () => {
    expect(checkLocalRequest("POST", OK_HOST, OK_ORIGIN, false, PORT, "cross-site"))
      .toBe("Cross-site request denied");
  });
});
