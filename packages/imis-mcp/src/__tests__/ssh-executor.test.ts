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
  deriveSshUser,
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

describe("deriveSshUser", () => {
  it("returns IMIS_SSH_USER verbatim when set", () => {
    expect(deriveSshUser("JSMITH", "svc_proxy_a")).toBe("svc_proxy_a");
  });

  it("lowercases a mixed-case Windows OS username when no override is configured", () => {
    expect(deriveSshUser("JSMITH", undefined)).toBe("jsmith_a");
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

// ---------------------------------------------------------------------------
// RSEC-002 / RSEC-003 regression: newline and carriage-return bypass.
//
// SHELL_META blocked `|` and `;` but not \n or \r, while
// command.trim().split(/\s+/) treats a newline as ordinary whitespace — so
// firstToken resolved to the harmless allowlisted binary and the payload
// survived on a second line. buildRemoteCommand then concatenated the string
// straight into the remote shell, where a newline separates statements.
// ---------------------------------------------------------------------------

describe("validateCommand — control-character hardening (RSEC-002)", () => {
  it("rejects a newline-separated second command", () => {
    expect(validateCommand("cat /etc/hosts\nid")).toBe(false);
  });

  it("rejects a carriage-return-separated second command", () => {
    expect(validateCommand("cat /etc/hosts\rid")).toBe(false);
  });

  it("still rejects pipe and semicolon", () => {
    expect(validateCommand("cat /etc/hosts | id")).toBe(false);
    expect(validateCommand("cat /etc/hosts; id")).toBe(false);
  });

  it("still accepts an ordinary allowlisted command", () => {
    expect(validateCommand("cat /etc/hosts")).toBe(true);
    expect(validateCommand("head -n 200 /var/log/app.log")).toBe(true);
  });
});

describe("sanitizePath — control-character hardening (RSEC-003)", () => {
  it("rejects a newline in the path", () => {
    expect(() => sanitizePath("/var/log/x\nid")).toThrow();
  });

  it("rejects a carriage return in the path", () => {
    expect(() => sanitizePath("/var/log/x\rid")).toThrow();
  });

  it("rejects a single quote in the path", () => {
    expect(() => sanitizePath("/var/log/it's.log")).toThrow();
  });

  it("rejects a double quote in the path", () => {
    expect(() => sanitizePath('/var/log/a"b.log')).toThrow();
  });

  it("still rejects traversal and relative paths", () => {
    expect(() => sanitizePath("/var/../etc/passwd")).toThrow();
    expect(() => sanitizePath("var/log/app.log")).toThrow();
  });

  it("still accepts an ordinary absolute path", () => {
    expect(sanitizePath("/var/log/app.log")).toBe("/var/log/app.log");
    expect(sanitizePath("/apps_ux/logs/RRS/rrs-api")).toBe("/apps_ux/logs/RRS/rrs-api");
  });
});

// ---------------------------------------------------------------------------
// PR review follow-up: allowlisting the binary does not make the tool
// read-only. Several allowlisted utilities execute programs or mutate the
// filesystem through their own options, with no shell metacharacter involved.
// ---------------------------------------------------------------------------

describe("validateCommand — argument policy for allowlisted binaries", () => {
  it("rejects find -exec, which runs an arbitrary program", () => {
    expect(validateCommand("find /tmp -exec rm -rf /tmp/x +")).toBe(false);
    expect(validateCommand("find /tmp -execdir rm {} +")).toBe(false);
    expect(validateCommand("find /tmp -ok rm {} ;".replace(";", ""))).toBe(false);
  });

  it("rejects find options that delete or write", () => {
    expect(validateCommand("find /tmp -name x -delete")).toBe(false);
    expect(validateCommand("find /tmp -fprintf /tmp/out %p")).toBe(false);
    expect(validateCommand("find /tmp -fprint /tmp/out")).toBe(false);
    expect(validateCommand("find /tmp -fls /tmp/out")).toBe(false);
  });

  it("rejects sort -o, which overwrites a file", () => {
    expect(validateCommand("sort -o /etc/hosts /etc/hosts")).toBe(false);
    expect(validateCommand("sort -o/etc/hosts /etc/hosts")).toBe(false);
    expect(validateCommand("sort --output=/etc/hosts /etc/hosts")).toBe(false);
  });

  it("accepts rpm only in query mode", () => {
    expect(validateCommand("rpm -e somepackage")).toBe(false);
    expect(validateCommand("rpm -U somepackage.rpm")).toBe(false);
    // Bare `rpm` prints usage and exits. Under the allowlist policy an empty
    // argument list is vacuously acceptable — the same property that lets
    // bare `mount` through. The earlier rejection was an artifact of the
    // "some -q flag must be present" design, not a security property.
    expect(validateCommand("rpm")).toBe(true);
    expect(validateCommand("rpm -qa")).toBe(true);
    expect(validateCommand("rpm -qi somepackage")).toBe(true);
  });

  it("accepts mount only with no arguments", () => {
    expect(validateCommand("mount /dev/sda1 /mnt")).toBe(false);
    expect(validateCommand("mount")).toBe(true);
  });

  it("still accepts ordinary read-only usage", () => {
    expect(validateCommand("find /apps_ux/logs -name app.log")).toBe(true);
    expect(validateCommand("sort /tmp/a.txt")).toBe(true);
    expect(validateCommand("cat /etc/hosts")).toBe(true);
    expect(validateCommand("grep -n ERROR /var/log/app.log")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review follow-up (Issue 1): the argument policy had the wrong shape. A
// presence check ("some arg starts with -q") restricts nothing else on the
// line; rpm --pipe is a popen() and composes with -q. And uniq, date, hostname
// were never in the policy at all. Per-command rules are now allowlists.
// ---------------------------------------------------------------------------

describe("validateCommand — rpm accepts only query flags and package/path positionals", () => {
  it("rejects --pipe in every position and form (popen)", () => {
    expect(validateCommand("rpm -qa --pipe id")).toBe(false);
    expect(validateCommand("rpm --pipe id -qa")).toBe(false);
    expect(validateCommand("rpm -q --pipe=id somepkg")).toBe(false);
    expect(validateCommand("rpm -qa --dbpath /tmp/x --pipe id")).toBe(false);
  });

  it("rejects macro and config options that can evaluate or load code", () => {
    expect(validateCommand("rpm -qa --eval %{_bindir}")).toBe(false);
    expect(validateCommand("rpm -qa --define x")).toBe(false);
    expect(validateCommand("rpm -qa --macros /tmp/m")).toBe(false);
    expect(validateCommand("rpm -qa --rcfile /tmp/rc")).toBe(false);
  });

  it("rejects any long option at all — the allowed set is short query flags only", () => {
    expect(validateCommand("rpm -qa --queryformat %{NAME}")).toBe(false);
    expect(validateCommand("rpm --query --all")).toBe(false);
  });

  it("still rejects mutating modes", () => {
    expect(validateCommand("rpm -e somepackage")).toBe(false);
    expect(validateCommand("rpm -U somepackage.rpm")).toBe(false);
    expect(validateCommand("rpm -qa -e somepackage")).toBe(false);
  });

  it("accepts ordinary query usage", () => {
    expect(validateCommand("rpm -qa")).toBe(true);
    expect(validateCommand("rpm -qi somepackage")).toBe(true);
    expect(validateCommand("rpm -ql somepackage")).toBe(true);
    expect(validateCommand("rpm -qf /usr/bin/java")).toBe(true);
    expect(validateCommand("rpm -qip somepackage-1.0-1.el8.x86_64.rpm")).toBe(true);
  });
});

describe("validateCommand — uniq, date, hostname, sort mutation paths", () => {
  it("rejects uniq with an output positional (POSIX: uniq [input [output]])", () => {
    expect(validateCommand("uniq /etc/hosts /tmp/evil")).toBe(false);
    expect(validateCommand("uniq -c /etc/hosts /tmp/evil")).toBe(false);
  });

  it("accepts uniq with at most one input positional", () => {
    expect(validateCommand("uniq /tmp/a.txt")).toBe(true);
    expect(validateCommand("uniq -c /tmp/a.txt")).toBe(true);
    expect(validateCommand("uniq")).toBe(true);
  });

  it("rejects date -s / --set (sets the clock)", () => {
    expect(validateCommand("date -s 2020-01-01")).toBe(false);
    expect(validateCommand("date --set=2020-01-01")).toBe(false);
    expect(validateCommand("date --set 2020-01-01")).toBe(false);
  });

  it("accepts date display forms", () => {
    expect(validateCommand("date")).toBe(true);
    expect(validateCommand("date +%Y-%m-%d")).toBe(true);
    expect(validateCommand("date -u")).toBe(true);
  });

  it("rejects hostname with a name or a -F file (sets the hostname)", () => {
    expect(validateCommand("hostname pwned")).toBe(false);
    expect(validateCommand("hostname -F /tmp/name")).toBe(false);
    expect(validateCommand("hostname --file /tmp/name")).toBe(false);
  });

  it("accepts hostname display forms", () => {
    expect(validateCommand("hostname")).toBe(true);
    expect(validateCommand("hostname -f")).toBe(true);
    expect(validateCommand("hostname -I")).toBe(true);
  });

  it("rejects sort --compress-program, which executes a program", () => {
    expect(validateCommand("sort --compress-program=id /tmp/a")).toBe(false);
    expect(validateCommand("sort --compress-program id /tmp/a")).toBe(false);
  });
});

describe("validateCommand — file -C writes a compiled magic database", () => {
  it("rejects -C, the bundled -Cm form, and --compile", () => {
    expect(validateCommand("file -C -m /tmp/x")).toBe(false);
    expect(validateCommand("file -Cm /tmp/x")).toBe(false);
    expect(validateCommand("file --compile /tmp/x")).toBe(false);
  });

  it("accepts ordinary read-only usage, including lowercase -c", () => {
    expect(validateCommand("file /usr/bin/java")).toBe(true);
    expect(validateCommand("file -b /usr/bin/java")).toBe(true);
    expect(validateCommand("file -i /usr/bin/java")).toBe(true);
    expect(validateCommand("file -c /usr/bin/java")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Self-review follow-up: every `forbid` pattern anchors at the start of the
// argument, so it only sees a short option that comes first in its token.
// Classic getopt clustering puts the dangerous flag last, where it still
// consumes the following word as its value. Both were verified against real
// binaries before this test was written:
//
//   $ sort -uo canary.txt in.txt   # wrote canary.txt — BSD sort and GNU sort
//   $ date -us '2020-01-01'        # GNU: "cannot set date: Operation not
//                                  # permitted" — parsed, reached the syscall
// ---------------------------------------------------------------------------

describe("validateCommand — dangerous short options hidden in a cluster", () => {
  it("rejects a clustered sort -o, which still overwrites the file", () => {
    expect(validateCommand("sort -uo /etc/hosts /etc/hosts")).toBe(false);
    expect(validateCommand("sort -buo /etc/hosts /etc/hosts")).toBe(false);
    expect(validateCommand("sort -ro/etc/hosts /etc/hosts")).toBe(false);
  });

  it("rejects a clustered date -s, which still sets the clock", () => {
    expect(validateCommand("date -us 2020-01-01")).toBe(false);
    expect(validateCommand("date -Rus 2020-01-01")).toBe(false);
  });

  it("keeps accepting a value-taking flag whose value contains the letter", () => {
    // Expansion stops at the first flag that consumes the rest of its token,
    // so these stay legal: -I takes an optional attached format, -t takes the
    // field separator, -k takes the key spec.
    expect(validateCommand("date -Iseconds")).toBe(true);
    expect(validateCommand("sort -to /etc/passwd")).toBe(true);
    expect(validateCommand("sort -k2,2 -t: /etc/passwd")).toBe(true);
  });
});
