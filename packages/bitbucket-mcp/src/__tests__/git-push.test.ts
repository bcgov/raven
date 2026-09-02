import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitExec, pushRepo, type GitExec } from "../git-push.js";

const HOST = "bwa.example.gov.bc.ca";
const AUTH = "Authorization: Basic Zm9vOmJhcg==";

/**
 * Fake git. Answers rev-parse/symbolic-ref/remote/config lookups from
 * `state` and records every invocation; `push` returns state.pushOutput.
 * The global scope always carries a credential helper and a proxy, so every
 * test implicitly checks that only repository-LOCAL keys are refused.
 */
function fakeGit(state: {
  toplevel: string;
  currentBranch?: string;
  remoteUrl?: string;
  /** Additional configured push URLs beyond remoteUrl. */
  extraPushUrls?: string[];
  /** Keys present in the repository's local config (besides the usual core.*). */
  localConfigKeys?: string[];
  hasUpstream?: boolean;
  pushOutput?: string;
}) {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const exec: GitExec = (args, opts) => {
    calls.push({ args, env: opts.env });
    const cmd = args.join(" ");
    if (cmd === "rev-parse --show-toplevel") return state.toplevel + "\n";
    if (cmd === "symbolic-ref --short HEAD") {
      if (!state.currentBranch) throw new Error("fatal: ref HEAD is not a symbolic ref");
      return state.currentBranch + "\n";
    }
    if (args[0] === "remote") {
      expect(args.slice(0, 3)).toEqual(["remote", "get-url", "--push"]);
      expect(args).toContain("--all");
      if (!state.remoteUrl) throw new Error(`fatal: No such remote '${args[4]}'`);
      return [state.remoteUrl, ...(state.extraPushUrls ?? [])].join("\n") + "\n";
    }
    if (args[0] === "config") {
      expect(args).toEqual(["config", "--list", "--show-scope", "--name-only"]);
      const lines = [
        "system\tcredential.helper",
        "global\tcredential.helper",
        "global\thttp.proxy",
        "global\thttp.sslverify",
        "local\tcore.repositoryformatversion",
        "local\tremote.origin.url",
        ...(state.localConfigKeys ?? []).map((k) => `local\t${k}`),
      ];
      return lines.join("\n") + "\n";
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      if (!state.hasUpstream) throw new Error("fatal: no upstream configured");
      return `origin/${state.currentBranch}\n`;
    }
    if (args[0] === "push") return state.pushOutput ?? "";
    throw new Error(`fakeGit: unexpected command: ${cmd}`);
  };
  return { exec, calls };
}

function repoDir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "raven-push-")));
}

describe("pushRepo", () => {
  it("pushes the current branch with an explicit non-forcing refspec", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "feature/x",
      remoteUrl: `https://${HOST}/int/stash/scm/nrs/repo.git`,
      hasUpstream: true,
      pushOutput: "Everything up-to-date",
    });
    const result = pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    expect(result).toMatchObject({
      branch: "feature/x",
      remote: "origin",
      setUpstream: false,
      output: "Everything up-to-date",
    });
    const push = git.calls.at(-1)!;
    expect(push.args).toEqual([
      "push",
      "--no-verify",
      "origin",
      "refs/heads/feature/x:refs/heads/feature/x",
    ]);
  });

  it("refuses a remote with more than one push URL and never runs push", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "main",
      remoteUrl: `https://${HOST}/scm/nrs/repo.git`,
      extraPushUrls: ["https://attacker.example.com/scm/x/mirror.git"],
    });
    expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec })).toThrow(
      /2 push URLs/
    );
    expect(git.calls.some((c) => c.args[0] === "push")).toBe(false);
  });

  it("passes credentials via GIT_CONFIG_* env, never argv, and resets credential programs", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "main",
      remoteUrl: `https://${HOST}/scm/nrs/repo.git`,
      hasUpstream: true,
    });
    pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    const push = git.calls.at(-1)!;
    expect(push.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: AUTH,
      // A 401 must fail, not run a helper with the header in its environment.
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "core.askpass",
      GIT_CONFIG_VALUE_2: "",
    });
    for (const call of git.calls) {
      expect(call.args.join(" ")).not.toContain("Basic");
      // Only the push carries the credential; the plumbing runs without it.
      if (call.args[0] !== "push") expect(call.env).toBeUndefined();
    }
  });

  it("adds --set-upstream only when the branch has no upstream", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "new-branch",
      remoteUrl: `https://${HOST}/scm/nrs/repo.git`,
      hasUpstream: false,
    });
    const result = pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    expect(result.setUpstream).toBe(true);
    expect(git.calls.at(-1)!.args).toEqual([
      "push",
      "--no-verify",
      "--set-upstream",
      "origin",
      "refs/heads/new-branch:refs/heads/new-branch",
    ]);
  });

  it("refuses a remote on a foreign host and never runs push", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "main",
      remoteUrl: "https://attacker.example.com/scm/nrs/repo.git",
    });
    expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec })).toThrow(
      /not the configured Bitbucket host/
    );
    expect(git.calls.some((c) => c.args[0] === "push")).toBe(false);
  });

  it("refuses a backslash in the authority, which curl reads as userinfo", () => {
    // WHATWG turns the backslash into a path separator, so `new URL().host`
    // is the pinned host for every one of these — but git/curl connect to
    // attacker.example.com and send the credential there. The raw-string
    // check must catch them before the parsed host is consulted.
    const dir = repoDir();
    for (const remoteUrl of [
      `https://${HOST}\\@attacker.example.com/scm/nrs/repo.git`,
      `https://${HOST}\\\\@attacker.example.com/scm/nrs/repo.git`,
      `https://${HOST}:443\\@attacker.example.com/scm/nrs/repo.git`,
    ]) {
      expect(new URL(remoteUrl).host).toBe(HOST); // the parser differential
      const git = fakeGit({ toplevel: dir, currentBranch: "main", remoteUrl });
      expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec })).toThrow(
        /not a plain https:\/\/host\/path URL/
      );
      expect(git.calls.some((c) => c.args[0] === "push")).toBe(false);
    }
  });

  it("refuses embedded userinfo rather than stripping it", () => {
    const dir = repoDir();
    for (const remoteUrl of [
      `https://user:secret@${HOST}/scm/nrs/repo.git`,
      `https://${HOST}@attacker.example.com/scm/nrs/repo.git`,
    ]) {
      const git = fakeGit({ toplevel: dir, currentBranch: "main", remoteUrl });
      expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec })).toThrow(
        /not a plain https:\/\/host\/path URL|not the configured Bitbucket host/
      );
      expect(git.calls.some((c) => c.args[0] === "push")).toBe(false);
    }
  });

  it("accepts the configured host in any case and with an explicit :443", () => {
    const dir = repoDir();
    for (const remoteUrl of [
      `https://${HOST.toUpperCase()}/scm/nrs/repo.git`,
      `https://${HOST}:443/scm/nrs/repo.git`,
    ]) {
      const git = fakeGit({ toplevel: dir, currentBranch: "main", remoteUrl, hasUpstream: true });
      const result = pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
      expect(result.remoteUrl).toBe(`https://${HOST}/scm/nrs/repo.git`);
      expect(git.calls.at(-1)!.args[0]).toBe("push");
    }
  });

  it("refuses non-HTTPS remotes (ssh and http)", () => {
    const dir = repoDir();
    for (const remoteUrl of [
      `http://${HOST}/scm/nrs/repo.git`,
      `ssh://git@${HOST}:7999/nrs/repo.git`,
    ]) {
      const git = fakeGit({ toplevel: dir, currentBranch: "main", remoteUrl });
      expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec })).toThrow(
        /refusing to push credentials|not the configured Bitbucket host/
      );
    }
  });

  it("refuses scp-style remotes that are not URLs at all", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "main",
      remoteUrl: `git@${HOST}:nrs/repo.git`,
    });
    expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec })).toThrow(
      /non-URL push target/
    );
  });

  it("refuses repository-local proxy, TLS and credential-program config and never runs push", () => {
    const dir = repoDir();
    for (const key of [
      "http.proxy",
      "http.sslverify",
      "http.sslcainfo",
      "http.https://bwa.example.gov.bc.ca/.proxy",
      "http.curloptresolve",
      "credential.helper",
      "credential.https://bwa.example.gov.bc.ca.helper",
      "core.askpass",
      "core.gitproxy",
      "remote.origin.proxy",
      "remote.origin.proxyauthmethod",
    ]) {
      const git = fakeGit({
        toplevel: dir,
        currentBranch: "main",
        remoteUrl: `https://${HOST}/scm/nrs/repo.git`,
        localConfigKeys: [key],
      });
      expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec })).toThrow(
        new RegExp(`repository-local git config.*${key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`)
      );
      expect(git.calls.some((c) => c.args[0] === "push")).toBe(false);
    }
  });

  it("ignores harmless local keys, another remote's proxy, and every global/system key", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "main",
      remoteUrl: `https://${HOST}/scm/nrs/repo.git`,
      localConfigKeys: ["user.email", "core.filemode", "remote.upstream.proxy", "url.https://x/.insteadof"],
      hasUpstream: true,
    });
    pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    expect(git.calls.at(-1)!.args[0]).toBe("push");
  });

  it("refuses option- or refspec-shaped branch and remote names", () => {
    const dir = repoDir();
    for (const branch of ["-danger", "+main", "a:b", "a b"]) {
      const git = fakeGit({
        toplevel: dir,
        remoteUrl: `https://${HOST}/scm/nrs/repo.git`,
      });
      expect(() =>
        pushRepo({ dir, branch, expectedHost: HOST, authHeader: AUTH, exec: git.exec })
      ).toThrow(/Refusing branch name/);
      expect(git.calls.some((c) => c.args[0] === "push")).toBe(false);
    }
    const git = fakeGit({ toplevel: dir, remoteUrl: `https://${HOST}/x.git` });
    expect(() =>
      pushRepo({ dir, branch: "main", remote: "--mirror", expectedHost: HOST, authHeader: AUTH, exec: git.exec })
    ).toThrow(/Refusing remote name/);
  });

  it("refuses a relative dir and a subdirectory of a repository", () => {
    expect(() =>
      pushRepo({ dir: "relative/path", expectedHost: HOST, authHeader: AUTH, exec: fakeGit({ toplevel: "/x" }).exec })
    ).toThrow(/absolute path/);

    const top = repoDir();
    const sub = join(top, "packages");
    mkdirSync(sub);
    const git = fakeGit({ toplevel: top, currentBranch: "main", remoteUrl: `https://${HOST}/x.git` });
    expect(() =>
      pushRepo({ dir: sub, expectedHost: HOST, authHeader: AUTH, exec: git.exec })
    ).toThrow(/top level/);
  });

  it("fails with git's message on a detached HEAD", () => {
    const dir = repoDir();
    const git = fakeGit({ toplevel: dir, remoteUrl: `https://${HOST}/x.git` });
    expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec })).toThrow(
      /symbolic ref/
    );
  });

  it("push failures propagate (exec throws)", () => {
    const dir = repoDir();
    const calls: string[][] = [];
    const exec: GitExec = (args) => {
      calls.push(args);
      const cmd = args.join(" ");
      if (cmd === "rev-parse --show-toplevel") return dir + "\n";
      if (cmd === "symbolic-ref --short HEAD") return "main\n";
      if (args[0] === "remote") return `https://${HOST}/scm/nrs/repo.git\n`;
      if (args[0] === "config") return "local\tcore.bare\n";
      if (args[0] === "rev-parse") return "origin/main\n";
      throw new Error("remote: rejected (pre-receive hook declined)");
    };
    expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec })).toThrow(
      /pre-receive hook declined/
    );
  });
});

describe("defaultGitExec (real git)", () => {
  const opts = { cwd: repoDir(), timeoutMs: 30_000 };

  it("returns stdout for plumbing commands", () => {
    expect(defaultGitExec(["--version"], opts)).toContain("git version");
  });

  it("captures stderr on success — the stream git push reports on", () => {
    // `git checkout -b` announces the switch on stderr with exit 0, the
    // same shape as a push summary; execFileSync would return "" here.
    const dir = repoDir();
    defaultGitExec(["init", "-q"], { cwd: dir, timeoutMs: 30_000 });
    const out = defaultGitExec(["checkout", "-b", "feature/x"], { cwd: dir, timeoutMs: 30_000 });
    expect(out).toContain("feature/x");
  });

  it("throws with git's stderr on a non-zero exit", () => {
    const dir = repoDir();
    defaultGitExec(["init", "-q"], { cwd: dir, timeoutMs: 30_000 });
    expect(() => defaultGitExec(["rev-parse", "--verify", "does-not-exist"], { cwd: dir, timeoutMs: 30_000 })).toThrow(
      /exited with 128/
    );
  });

  it("lists config keys with their scope, so local keys can be told from global ones", () => {
    const dir = repoDir();
    defaultGitExec(["init", "-q"], { cwd: dir, timeoutMs: 30_000 });
    defaultGitExec(["config", "--local", "http.proxy", "http://127.0.0.1:1"], { cwd: dir, timeoutMs: 30_000 });
    const out = defaultGitExec(["config", "--list", "--show-scope", "--name-only"], { cwd: dir, timeoutMs: 30_000 });
    expect(out).toContain("local\thttp.proxy");
  });
});

// vi is imported for parity with the other suites; keep the linter satisfied.
void vi;
