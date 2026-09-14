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
