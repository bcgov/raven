import { describe, it, expect } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { parseKnownHosts, verifyHostKey } from "../known-hosts.js";

/**
 * RSEC-006 regression suite.
 *
 * Both SSH clients previously set `hostVerifier: () => true`, accepting any key
 * a host presented while sending the operator's SSH credential and piping the
 * sudo password over stdin.
 */

const KEY = Buffer.from("ssh-rsa-fake-public-key-blob");
const KEY_B64 = KEY.toString("base64");
const OTHER_KEY = Buffer.from("a-completely-different-key-blob");

/** Build a hashed known_hosts host field for a hostname, as `ssh-keygen -H` would. */
function hashedHostField(host: string): string {
  const salt = randomBytes(20);
  const mac = createHmac("sha1", salt);
  mac.update(host);
  return `|1|${salt.toString("base64")}|${mac.digest("base64")}`;
}

describe("parseKnownHosts", () => {
  it("parses a plain entry with several host aliases", () => {
    const entries = parseKnownHosts(`prod01,prod01.example.gov.bc.ca ssh-rsa ${KEY_B64}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hosts).toEqual(["prod01", "prod01.example.gov.bc.ca"]);
    expect(entries[0]!.key).toBe(KEY_B64);
  });

  it("skips comments and blank lines, and tags marker lines", () => {
    const contents = [
      "# a comment",
      "",
      `@cert-authority *.example.gov.bc.ca ssh-rsa ${KEY_B64}`,
      `@revoked * ssh-rsa ${KEY_B64}`,
      `prod01 ssh-rsa ${KEY_B64}`,
    ].join("\n");
    const entries = parseKnownHosts(contents);
    // Marker lines are retained and tagged rather than dropped. @revoked has to
    // survive parsing to be enforced; @cert-authority survives only so it can
    // be ignored deliberately at authorization time, since honouring it would
    // widen trust to anything that CA signs.
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.marker)).toEqual(["cert-authority", "revoked", "none"]);
    expect(entries[2]!.hosts).toEqual(["prod01"]);
  });

  it("parses a hashed entry", () => {
    const entries = parseKnownHosts(`${hashedHostField("prod01")} ssh-rsa ${KEY_B64}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hosts).toEqual([]);
    expect(entries[0]!.hashSalt).not.toBeNull();
  });
});

describe("verifyHostKey", () => {
  it("accepts a key that matches a plain entry", () => {
    const v = verifyHostKey("prod01", KEY, `prod01 ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(true);
  });

  it("accepts a key that matches a hashed entry", () => {
    const v = verifyHostKey("prod01", KEY, `${hashedHostField("prod01")} ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(true);
  });

  it("matches a host alias within a comma-separated list", () => {
    const v = verifyHostKey("prod01.example.gov.bc.ca", KEY, `prod01,prod01.example.gov.bc.ca ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(true);
  });

  it("rejects a mismatched key for a known host", () => {
    const v = verifyHostKey("prod01", OTHER_KEY, `prod01 ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("key-mismatch");
      // The message must not suggest the override — a mismatch is the one case
      // where working around it defeats the entire control.
      expect(v.message).toContain("Do not set");
    }
  });

  it("rejects a host absent from the file", () => {
    const v = verifyHostKey("unknown01", KEY, `prod01 ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("host-not-found");
  });

  it("rejects when no known_hosts file exists, and says how to proceed", () => {
    const v = verifyHostKey("prod01", KEY, null);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.reason).toBe("no-known-hosts-file");
      expect(v.message).toContain("RAVEN_SSH_INSECURE_HOST_KEYS");
    }
  });

  it("does not let one host's key authorize another host", () => {
    const contents = [
      `prod01 ssh-rsa ${KEY_B64}`,
      `test01 ssh-rsa ${OTHER_KEY.toString("base64")}`,
    ].join("\n");
    expect(verifyHostKey("test01", KEY, contents).ok).toBe(false);
    expect(verifyHostKey("prod01", KEY, contents).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR review follow-up: @revoked is an explicit deny, and host fields are
// patterns. sshd(8): a @revoked key "must not ever be accepted".
// ---------------------------------------------------------------------------

describe("verifyHostKey — revocation and host patterns", () => {
  it("rejects a key marked @revoked", () => {
    const v = verifyHostKey("prod01", KEY, `@revoked prod01 ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("revoked");
  });

  it("lets revocation override a stale positive entry for the same host and key", () => {
    // This is the case the marker exists for: the key is still listed as good
    // further down the file, and must not be accepted anyway.
    const contents = [
      `@revoked prod01 ssh-rsa ${KEY_B64}`,
      `prod01 ssh-rsa ${KEY_B64}`,
    ].join("\n");
    const v = verifyHostKey("prod01", KEY, contents);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("revoked");
  });

  it("honours the documented wildcard revocation form", () => {
    // sshd(8) documents `@revoked * ssh-rsa ...` to revoke a key everywhere.
    const v = verifyHostKey("anything01", KEY, `@revoked * ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("revoked");
  });

  it("does not let a @cert-authority line authorize a key", () => {
    const v = verifyHostKey("prod01", KEY, `@cert-authority prod01 ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("host-not-found");
  });

  it("matches a wildcard host pattern in a positive entry", () => {
    const v = verifyHostKey("prod01.example.gov.bc.ca", KEY, `*.example.gov.bc.ca ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(true);
  });

  it("honours a negated host pattern", () => {
    const contents = `*.example.gov.bc.ca,!secret01.example.gov.bc.ca ssh-rsa ${KEY_B64}`;
    expect(verifyHostKey("ordinary01.example.gov.bc.ca", KEY, contents).ok).toBe(true);
    expect(verifyHostKey("secret01.example.gov.bc.ca", KEY, contents).ok).toBe(false);
  });

  it("treats a wildcard as a pattern, not a literal hostname", () => {
    const v = verifyHostKey("*", KEY, `prod01 ssh-rsa ${KEY_B64}`);
    expect(v.ok).toBe(false);
  });
});
