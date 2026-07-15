import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateCommand,
  sanitizePath,
  validateSudoUser,
  getSshAuthMode,
  buildConnectOpts,
  sshExec,
  type SshAuthMode,
} from "../ssh-executor.js";

const FAKE_KEY = Buffer.from("fake-key-bytes");

describe("validateCommand", () => {
  it("allows whitelisted commands", () => {
    expect(validateCommand("ls -la /apps_ux")).toBe(true);
    expect(validateCommand("cat /etc/hosts")).toBe(true);
    expect(validateCommand("grep -r tomcat /sw_ux")).toBe(true);
    expect(validateCommand("df -h")).toBe(true);
    expect(validateCommand("rpm -qa")).toBe(true);
    expect(validateCommand("mount")).toBe(true);
    expect(validateCommand("ps aux")).toBe(true);
  });

  it("allows newly added read-only commands", () => {
    expect(validateCommand("jstat -gc 12345 1 1")).toBe(true);
    expect(validateCommand("sort /tmp/out.txt")).toBe(true);
    expect(validateCommand("uniq -c /tmp/out.txt")).toBe(true);
    expect(validateCommand("tr -s ' ' /tmp/out.txt")).toBe(true);
    expect(validateCommand("cut -d: -f1 /tmp/out.txt")).toBe(true);
    expect(validateCommand("diff /tmp/a.txt /tmp/b.txt")).toBe(true);
    expect(validateCommand("which jstat")).toBe(true);
    expect(validateCommand("strings /apps_ux/RRS/rrs-api.jar")).toBe(true);
    expect(validateCommand("lsof -p 12345")).toBe(true);
  });

  it("still rejects sed and awk", () => {
    expect(validateCommand("sed -i 's/foo/bar/' file.txt")).toBe(false);
    expect(validateCommand("awk '{print $1}' file.txt")).toBe(false);
  });

  it("rejects non-whitelisted commands", () => {
    expect(validateCommand("rm -rf /")).toBe(false);
    expect(validateCommand("chmod 777 /etc/passwd")).toBe(false);
    expect(validateCommand("wget http://evil.com")).toBe(false);
    expect(validateCommand("curl http://evil.com")).toBe(false);
    expect(validateCommand("ssh other-server")).toBe(false);
    expect(validateCommand("sudo rm -rf /")).toBe(false);
  });

  it("rejects shell injection attempts", () => {
    expect(validateCommand("ls; rm -rf /")).toBe(false);
    expect(validateCommand("ls && rm -rf /")).toBe(false);
    expect(validateCommand("ls | rm -rf /")).toBe(false);
    expect(validateCommand("ls `whoami`")).toBe(false);
    expect(validateCommand("ls $(whoami)")).toBe(false);
  });
});

describe("validateSudoUser", () => {
  it("allows known service accounts", () => {
    expect(validateSudoUser("wwwsvr")).toBe(true);
    expect(validateSudoUser("oracle")).toBe(true);
    expect(validateSudoUser("tomcat")).toBe(true);
    expect(validateSudoUser("wildfly")).toBe(true);
    expect(validateSudoUser("midtadm")).toBe(true);
  });

  it("rejects accounts not in the allowlist", () => {
    expect(validateSudoUser("root")).toBe(false);
    expect(validateSudoUser("admin")).toBe(false);
    expect(validateSudoUser("postgres")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(validateSudoUser("")).toBe(false);
  });

  it("rejects injection attempts", () => {
    expect(validateSudoUser("wwwsvr; rm -rf /")).toBe(false);
    expect(validateSudoUser("oracle$(id)")).toBe(false);
  });

  it("rejects usernames with uppercase or special chars", () => {
    expect(validateSudoUser("WWWSVR")).toBe(false);
    expect(validateSudoUser("www-svr")).toBe(false);
  });
});

describe("sanitizePath", () => {
  it("allows valid absolute paths", () => {
    expect(sanitizePath("/apps_ux/pub#rrs/config.xml")).toBe("/apps_ux/pub#rrs/config.xml");
    expect(sanitizePath("/sw_ux/tomcat-9.0.71/conf/server.xml")).toBe("/sw_ux/tomcat-9.0.71/conf/server.xml");
  });

  it("rejects relative paths", () => {
    expect(() => sanitizePath("relative/path")).toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => sanitizePath("/apps_ux/../etc/passwd")).toThrow();
  });

  it("rejects shell metacharacters", () => {
    expect(() => sanitizePath("/apps_ux/$(whoami)")).toThrow();
    expect(() => sanitizePath("/apps_ux/`id`")).toThrow();
    expect(() => sanitizePath("/apps_ux/foo;bar")).toThrow();
  });
});

describe("getSshAuthMode", () => {
  let tempDir: string;
  let existingKey: string;
  const missingKey = join(tmpdir(), "raven-test-does-not-exist-" + Date.now());

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "raven-imis-auth-"));
    existingKey = join(tempDir, "fake-key");
    writeFileSync(existingKey, "fake key contents", { mode: 0o600 });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns password mode when SSH_KEY_PATH is undefined", () => {
    const mode = getSshAuthMode("any-host", undefined, undefined);
    expect(mode).toEqual({ kind: "password" });
  });

  it("returns key mode when host IS in SSH_KEY_HOSTS", () => {
    const mode = getSshAuthMode("int01.example.internal", existingKey, "int01,test01");
    expect(mode).toEqual({ kind: "key", keyPath: existingKey });
  });

  it("returns password mode when host is NOT in SSH_KEY_HOSTS", () => {
    const mode = getSshAuthMode("int02.example.internal", existingKey, "int01,test01");
    expect(mode).toEqual({ kind: "password" });
  });

  it("returns error when SSH_KEY_PATH set but SSH_KEY_HOSTS unset", () => {
    const mode = getSshAuthMode("any-host", existingKey, undefined);
    expect(mode.kind).toBe("error");
    if (mode.kind === "error") {
      expect(mode.message).toContain("SSH_KEY_HOSTS");
    }
  });

  it("returns error when SSH_KEY_PATH points to a missing file", () => {
    const mode = getSshAuthMode("any-host", missingKey, "any-host");
    expect(mode.kind).toBe("error");
    if (mode.kind === "error") {
      expect(mode.message).toContain("does not exist");
    }
  });

  it("supports SSH_KEY_HOSTS=* as wildcard", () => {
    const mode = getSshAuthMode("any-host", existingKey, "*");
    expect(mode.kind).toBe("key");
  });

  it("preserves IPv4 addresses (does not strip past first dot)", () => {
    const mode = getSshAuthMode("192.168.1.10", existingKey, "192.168.1.10");
    expect(mode).toEqual({ kind: "key", keyPath: existingKey });
  });

  it("preserves IPv6 addresses (does not split on dots)", () => {
    const mode = getSshAuthMode("2001:db8::1", existingKey, "2001:db8::1");
    expect(mode).toEqual({ kind: "key", keyPath: existingKey });
  });

  it("does NOT match a partial IPv4 prefix", () => {
    const mode = getSshAuthMode("192.168.1.10", existingKey, "192");
    expect(mode).toEqual({ kind: "password" });
  });
});

describe("buildConnectOpts (single-method invariant)", () => {
  // connectOpts MUST have exactly one of `privateKey` or `password`,
  // never both. Routing happens upstream via getSshAuthMode.

  it("key mode (no passphrase): sets privateKey only — never password", () => {
    const opts = buildConnectOpts(
      "host", "user",
      { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
      "should-not-leak",
      undefined,
      FAKE_KEY,
    );
    expect(opts.privateKey).toBe(FAKE_KEY);
    expect(opts.password).toBeUndefined();
  });

  it("key mode (with passphrase): privateKey + passphrase, no password", () => {
    const opts = buildConnectOpts(
      "host", "user",
      { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
      "should-not-leak",
      "the-passphrase",
      FAKE_KEY,
    );
    expect(opts.privateKey).toBe(FAKE_KEY);
    expect(opts.passphrase).toBe("the-passphrase");
    expect(opts.password).toBeUndefined();
  });

  it("password mode: sets password only — never privateKey", () => {
    const opts = buildConnectOpts(
      "host", "user",
      { kind: "password" } as SshAuthMode,
      "the-password",
      "should-not-leak",
      Buffer.from("should-not-leak"),
    );
    expect(opts.password).toBe("the-password");
    expect(opts.privateKey).toBeUndefined();
    expect(opts.passphrase).toBeUndefined();
  });

  it("never sets `agent` or `tryKeyboard`", () => {
    const keyOpts = buildConnectOpts(
      "host", "user",
      { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
      undefined, undefined, FAKE_KEY,
    );
    expect(keyOpts.agent).toBeUndefined();
    expect(keyOpts.tryKeyboard).toBeUndefined();
  });

  it("throws if key mode is requested without privateKeyBytes", () => {
    expect(() =>
      buildConnectOpts(
        "host", "user",
        { kind: "key", keyPath: "/tmp/key" } as SshAuthMode,
        undefined, undefined, undefined,
      ),
    ).toThrow();
  });

  it("throws if password mode is requested without a password", () => {
    expect(() =>
      buildConnectOpts(
        "host", "user",
        { kind: "password" } as SshAuthMode,
        undefined, undefined, undefined,
      ),
    ).toThrow();
  });

  it("throws if error-mode authMode reaches buildConnectOpts", () => {
    expect(() =>
      buildConnectOpts(
        "host", "user",
        { kind: "error", message: "bad config" } as SshAuthMode,
        "p", undefined, undefined,
      ),
    ).toThrow(/error mode/);
  });
});

// ---------------------------------------------------------------------------
// sshExec defense-in-depth — validate command and sudoUser before connecting,
// so external consumers of @nrs/imis-mcp/client can't bypass validators by
// calling sshExec directly with shell-injection input.
// ---------------------------------------------------------------------------

describe("sshExec defense-in-depth validation", () => {
  it("rejects a command not in the allowlist before any SSH attempt", async () => {
    const result = await sshExec("any-host", "rm -rf /", undefined, 1_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Command rejected/);
    expect(result.stderr).toContain("rm");
    expect(result.stdout).toBe("");
  });

  it("rejects a command containing shell metacharacters", async () => {
    const result = await sshExec("any-host", "ls; rm -rf /", undefined, 1_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Command rejected/);
  });

  it("rejects an empty command", async () => {
    const result = await sshExec("any-host", "", undefined, 1_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Command rejected/);
  });

  it("rejects a sudoUser not in the allowlist before any SSH attempt", async () => {
    const result = await sshExec("any-host", "ls /tmp", "root", 1_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/sudoUser rejected/);
    expect(result.stderr).toContain("root");
  });

  it("rejects a sudoUser containing shell injection", async () => {
    const result = await sshExec("any-host", "ls /tmp", "wwwsvr; rm -rf /", 1_000);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/sudoUser rejected/);
  });
});
