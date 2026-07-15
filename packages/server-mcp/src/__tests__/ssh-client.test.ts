import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildRemoteCommand,
  getSshAuthMode,
  buildConnectOpts,
  sshExecStream,
  type SshAuthMode,
} from "../ssh-client.js";

const FAKE_ENTRY = {
  name: "test",
  host: "test.example.com",
  sshUser: "testuser_a",
  sudoUser: "wwwsvr",
  role: "INT",
  description: "test",
  appsBase: "/apps_ux",
  logsBase: "/apps_ux/logs",
};
const FAKE_KEY = Buffer.from("fake-key-bytes");

describe("buildRemoteCommand", () => {
  it("wraps command in sudo when sudoUser is provided", () => {
    const cmd = buildRemoteCommand("ls /apps_ux", "appuser");
    // sudoUser is shell-escaped (single-quoted) as defense-in-depth.
    expect(cmd).toContain("sudo -S -p '' -u 'appuser'");
    expect(cmd).toContain("bash -c");
    expect(cmd).toContain("ls /apps_ux");
    expect(cmd).toContain("unset HISTFILE");
  });

  it("shell-escapes a sudoUser containing special characters", () => {
    const cmd = buildRemoteCommand("ls", "ev'il");
    // The injected quote is neutralized: it cannot break out of the -u arg.
    expect(cmd).toContain("sudo -S -p '' -u 'ev'\\''il'");
    expect(cmd).not.toContain("-u ev'il");
  });

  it("skips sudo when sudoUser is empty", () => {
    const cmd = buildRemoteCommand("grep ERROR /sw_ux/httpd01/logs/hot/test.log", "");
    expect(cmd).not.toContain("sudo");
    expect(cmd).not.toContain("bash -c");
    expect(cmd).toContain("grep ERROR /sw_ux/httpd01/logs/hot/test.log");
    expect(cmd).toContain("unset HISTFILE");
  });

  it("always prepends nohist regardless of sudo", () => {
    const withSudo = buildRemoteCommand("ls", "appuser");
    const withoutSudo = buildRemoteCommand("ls", "");
    expect(withSudo).toMatch(/^unset HISTFILE; set \+o history/);
    expect(withoutSudo).toMatch(/^unset HISTFILE; set \+o history/);
  });
});

describe("getSshAuthMode", () => {
  let tempDir: string;
  let existingKey: string;
  const missingKey = join(tmpdir(), "raven-test-does-not-exist-" + Date.now());

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "raven-ssh-auth-"));
    existingKey = join(tempDir, "fake-key");
    writeFileSync(existingKey, "fake key contents", { mode: 0o600 });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns password mode when SSH_KEY_PATH is undefined (transparency invariant)", () => {
    const mode = getSshAuthMode("int01", undefined, undefined);
    expect(mode).toEqual({ kind: "password" });
  });

  it("returns password mode when SSH_KEY_PATH is empty string", () => {
    const mode = getSshAuthMode("int01", "", undefined);
    expect(mode).toEqual({ kind: "password" });
  });

  it("returns error when SSH_KEY_PATH points to a missing file", () => {
    const mode = getSshAuthMode("int01", missingKey, "int01");
    expect(mode.kind).toBe("error");
    if (mode.kind === "error") {
      expect(mode.message).toContain(missingKey);
      expect(mode.message).toContain("does not exist");
    }
  });

  it("returns error when SSH_KEY_PATH is set but SSH_KEY_HOSTS is not (forces explicitness)", () => {
    const mode = getSshAuthMode("int01", existingKey, undefined);
    expect(mode.kind).toBe("error");
    if (mode.kind === "error") {
      expect(mode.message).toContain("SSH_KEY_HOSTS");
      expect(mode.message).toContain("comma-separated");
    }
  });

  it("returns key mode when host IS in SSH_KEY_HOSTS", () => {
    const mode = getSshAuthMode("int01", existingKey, "int01,test01,prod01");
    expect(mode).toEqual({ kind: "key", keyPath: existingKey });
  });

  it("returns password mode when host is NOT in SSH_KEY_HOSTS", () => {
    const mode = getSshAuthMode("int02", existingKey, "int01,test01,prod01");
    expect(mode).toEqual({ kind: "password" });
  });

  it("normalizes FQDN to short name for matching", () => {
    const mode = getSshAuthMode("int01.example.internal", existingKey, "int01,test01");
    expect(mode).toEqual({ kind: "key", keyPath: existingKey });
  });

  it("matches case-insensitively", () => {
    const upper = getSshAuthMode("INT01", existingKey, "int01");
    expect(upper.kind).toBe("key");
    const mixedList = getSshAuthMode("int01", existingKey, "Int01,TEST01");
    expect(mixedList.kind).toBe("key");
  });

  it("trims whitespace in SSH_KEY_HOSTS list", () => {
    const mode = getSshAuthMode("test01", existingKey, " int01 , test01 , prod01 ");
    expect(mode.kind).toBe("key");
  });

  it("supports SSH_KEY_HOSTS=* as wildcard for all hosts", () => {
    const mode = getSshAuthMode("any-host-anywhere", existingKey, "*");
    expect(mode).toEqual({ kind: "key", keyPath: existingKey });
  });

  it("preserves IPv4 addresses (does not strip past first dot)", () => {
    // Without IP detection, "192.168.1.10".split(".")[0] would be "192", and
    // SSH_KEY_HOSTS=192.168.1.10 would never match. servers.conf.example
    // explicitly permits IP-based hosts, so this must work.
    const mode = getSshAuthMode("192.168.1.10", existingKey, "192.168.1.10");
    expect(mode).toEqual({ kind: "key", keyPath: existingKey });
  });

  it("preserves IPv6 addresses (does not split on dots)", () => {
    const mode = getSshAuthMode("2001:db8::1", existingKey, "2001:db8::1");
    expect(mode).toEqual({ kind: "key", keyPath: existingKey });
  });

  it("does NOT match a partial IPv4 prefix", () => {
    // Sanity check: SSH_KEY_HOSTS=192 must NOT match 192.168.1.10
    const mode = getSshAuthMode("192.168.1.10", existingKey, "192");
    expect(mode).toEqual({ kind: "password" });
  });

  it("does NOT auto-detect ~/.ssh/id_ed25519 — strict opt-in only", () => {
    // Even on a developer machine that has ~/.ssh/id_ed25519 present,
    // password mode must be returned when no key is configured.
    const mode = getSshAuthMode("int01", undefined, "int01");
    expect(mode.kind).toBe("password");
  });
});

describe("sshExecStream (fast-fail before connect)", () => {
  // log-download relies on sshExecStream rejecting BEFORE any byte flows when
  // the environment is misconfigured, so the route can still send a clean
  // error status before committing response headers. Forcing SSH_KEY_PATH to
  // a missing file makes getSshAuthMode return error mode deterministically,
  // regardless of whether SERVER_A_PASSWORD happens to be set locally.
  it("rejects synchronously-resolved promise without opening a connection", async () => {
    const prev = process.env.SSH_KEY_PATH;
    process.env.SSH_KEY_PATH = join(tmpdir(), "raven-stream-missing-key-" + Date.now());
    try {
      await expect(
        sshExecStream(FAKE_ENTRY, "cat /tmp/whatever"),
      ).rejects.toThrow(/does not exist/);
    } finally {
      if (prev === undefined) delete process.env.SSH_KEY_PATH;
      else process.env.SSH_KEY_PATH = prev;
    }
  });
});

describe("buildConnectOpts (single-method invariant)", () => {
  // The strict invariant: connectOpts MUST have exactly one of `privateKey`
  // or `password`, never both. Combined with the host-aware getSshAuthMode,
  // this guarantees one auth attempt per connection — a rejected publickey
  // does NOT trigger a fallback password attempt.

  it("key mode (no passphrase): sets privateKey only — never password", () => {
    const opts = buildConnectOpts(
      FAKE_ENTRY,
      { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
      "should-not-leak",
      undefined,
      FAKE_KEY,
    );
    expect(opts.privateKey).toBe(FAKE_KEY);
    expect(opts.password).toBeUndefined();
    expect(opts.passphrase).toBeUndefined();
  });

  it("key mode (with passphrase): sets privateKey + passphrase, no password", () => {
    const opts = buildConnectOpts(
      FAKE_ENTRY,
      { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
      "should-not-leak",
      "the-passphrase",
      FAKE_KEY,
    );
    expect(opts.privateKey).toBe(FAKE_KEY);
    expect(opts.passphrase).toBe("the-passphrase");
    expect(opts.password).toBeUndefined();
  });

  it("password mode: sets password only — never privateKey or passphrase", () => {
    const opts = buildConnectOpts(
      FAKE_ENTRY,
      { kind: "password" } as SshAuthMode,
      "the-password",
      "should-not-leak",
      Buffer.from("should-not-leak"),
    );
    expect(opts.password).toBe("the-password");
    expect(opts.privateKey).toBeUndefined();
    expect(opts.passphrase).toBeUndefined();
  });

  it("never sets `agent` (no ssh-agent auto-discovery)", () => {
    const keyOpts = buildConnectOpts(
      FAKE_ENTRY,
      { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
      undefined, undefined, FAKE_KEY,
    );
    const passOpts = buildConnectOpts(
      FAKE_ENTRY,
      { kind: "password" } as SshAuthMode,
      "p", undefined, undefined,
    );
    expect(keyOpts.agent).toBeUndefined();
    expect(passOpts.agent).toBeUndefined();
  });

  it("never sets `tryKeyboard` (no keyboard-interactive fallback)", () => {
    const keyOpts = buildConnectOpts(
      FAKE_ENTRY,
      { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
      undefined, undefined, FAKE_KEY,
    );
    expect(keyOpts.tryKeyboard).toBeUndefined();
  });

  it("throws if key mode is requested without privateKeyBytes", () => {
    expect(() =>
      buildConnectOpts(
        FAKE_ENTRY,
        { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
        undefined, undefined, undefined,
      ),
    ).toThrow();
  });

  it("throws if password mode is requested without a password", () => {
    // Mirrors the privateKey check — keeps the single-method invariant
    // honest if a future caller forgets to validate password upstream.
    expect(() =>
      buildConnectOpts(
        FAKE_ENTRY,
        { kind: "password" } as SshAuthMode,
        undefined, undefined, undefined,
      ),
    ).toThrow();
  });

  it("throws if error-mode authMode reaches buildConnectOpts", () => {
    // Production callers must early-return on error mode. This test
    // ensures the function refuses to silently produce a no-auth-method
    // ConnectConfig if a future caller forgets that early-return.
    expect(() =>
      buildConnectOpts(
        FAKE_ENTRY,
        { kind: "error", message: "bad config" } as SshAuthMode,
        "p", undefined, undefined,
      ),
    ).toThrow(/error mode/);
  });
});
