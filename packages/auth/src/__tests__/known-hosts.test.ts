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

  it("skips comments, blank lines and marker lines", () => {
    const contents = [
      "# a comment",
      "",
      `@cert-authority *.example.gov.bc.ca ssh-rsa ${KEY_B64}`,
      `prod01 ssh-rsa ${KEY_B64}`,
    ].join("\n");
    const entries = parseKnownHosts(contents);
    // The cert-authority line is deliberately ignored — honouring it would
    // widen trust to anything that CA signs.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hosts).toEqual(["prod01"]);
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
