import { afterAll, describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, realpathSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneRepo, defaultGitExec, gitCredentialEnv, pushRepo, type GitExec } from "../git-push.js";

const HOST = "bwa.example.gov.bc.ca";
const AUTH = "Authorization: Basic Zm9vOmJhcg==";
const DROPPED = ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSL_NO_VERIFY", "GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_PARAMETERS"];

/**
 * Fake git. Answers rev-parse/symbolic-ref/remote/config lookups from
 * `state` and records every invocation; `push` returns state.pushOutput,
 * `clone` returns state.cloneOutput. The system and global scopes always
 * carry credential helpers and a proxy, so every test implicitly checks
 * that only repository-LOCAL keys are refused.
 */
function fakeGit(state: {
  toplevel: string;
  currentBranch?: string;
  remoteUrl?: string;
  /** Additional configured push URLs beyond remoteUrl. */
  extraPushUrls?: string[];
  /** Keys present in the repository's local config (besides the usual core.*). */
  localConfigKeys?: string[];
  /** Global url.<base>.insteadOf rules: base -> prefix it replaces. */
  globalInsteadOf?: Record<string, string>;
  hasUpstream?: boolean;
  pushOutput?: string;
  cloneOutput?: string;
  /** Pretend the temp directory cloneRepo runs from sits inside a repository. */
  cwdInsideRepo?: boolean;
  /** Pretend the cloned repository is empty (HEAD unborn). */
  emptyRemote?: boolean;
}) {
  const calls: { args: string[]; env?: NodeJS.ProcessEnv; cwd: string }[] = [];
  const exec: GitExec = (args, opts) => {
    calls.push({ args, env: opts.env, cwd: opts.cwd });
    const cmd = args.join(" ");
    if (cmd === "rev-parse --show-toplevel") {
      if (opts.cwd === tmpdir() && !state.cwdInsideRepo) throw new Error("fatal: not a git repository");
      return state.toplevel + "\n";
    }
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
      expect(args.slice(0, 3)).toEqual(["config", "--list", "--show-scope"]);
      const nameOnly = args.includes("--name-only");
      const entries: [string, string, string][] = [
        ["system", "credential.helper", "osxkeychain"],
        ["global", "credential.helper", "manager"],
        ["global", "http.proxy", "http://proxy.example:3128"],
        ["global", "http.sslverify", "true"],
        ...Object.entries(state.globalInsteadOf ?? {}).map(
          ([base, prefix]): [string, string, string] => ["global", `url.${base}.insteadof`, prefix]
        ),
        ["local", "core.repositoryformatversion", "0"],
        ["local", "remote.origin.url", state.remoteUrl ?? ""],
        ...(state.localConfigKeys ?? []).map((k): [string, string, string] => ["local", k, "x"]),
      ];
      return entries.map(([s, k, v]) => (nameOnly ? `${s}\t${k}` : `${s}\t${k}=${v}`)).join("\n") + "\n";
    }
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") {
      if (!state.hasUpstream) throw new Error("fatal: no upstream configured");
      return `origin/${state.currentBranch}\n`;
    }
    if (cmd === "rev-parse --verify --quiet HEAD") {
      if (state.emptyRemote) throw new Error("git rev-parse exited with 1");
      return "0123456789abcdef0123456789abcdef01234567\n";
    }
    if (args[0] === "push") return state.pushOutput ?? "";
    if (args[0] === "clone") return state.cloneOutput ?? "";
    if (cmd === "checkout") return "Your branch is up to date with 'origin/main'.\n";
    throw new Error(`fakeGit: unexpected command: ${cmd}`);
  };
  return { exec, calls };
}

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function repoDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "raven-push-")));
  tempDirs.push(dir);
  return dir;
}

describe("gitCredentialEnv", () => {
  it("injects the header and resets credential programs, TLS bypass and repo redirection", () => {
    const env = gitCredentialEnv(AUTH, `https://${HOST}/scm/nrs/repo.git`, {
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy.example:3128",
      GIT_ASKPASS: "/x",
      SSH_ASKPASS: "/y",
      GIT_SSL_NO_VERIFY: "1",
      GIT_DIR: "/z",
      GIT_WORK_TREE: "/w",
      GIT_CONFIG_PARAMETERS: "'a.b=c'",
    });
    expect(env).toMatchObject({
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy.example:3128", // the user's own proxy is kept
      GIT_TERMINAL_PROMPT: "0",
      GIT_TRACE_REDACT: "1",
      GIT_CONFIG_COUNT: "5",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: AUTH,
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
      GIT_CONFIG_KEY_2: "core.askpass",
      GIT_CONFIG_VALUE_2: "",
      GIT_CONFIG_KEY_3: "http.sslVerify",
      GIT_CONFIG_VALUE_3: "true",
      // A URL-scoped key beats a plain one in git, so a global
      // http.<host>.sslVerify=false must be out-specified for the target.
      GIT_CONFIG_KEY_4: `http.https://${HOST}/scm/nrs/repo.git.sslVerify`,
      GIT_CONFIG_VALUE_4: "true",
    });
    for (const key of DROPPED) expect(env).not.toHaveProperty(key);
    expect(Object.values(env).join(" ")).not.toContain("/x");
  });

  it("drops controlled variables whatever their case, as Windows resolves names case-insensitively", () => {
    const env = gitCredentialEnv(AUTH, `https://${HOST}/scm/nrs/repo.git`, {
      Path: "C:\\bin",
      Git_AskPass: "C:\\evil\\askpass.exe",
      ssh_askpass: "C:\\evil\\askpass.exe",
      git_ssl_no_verify: "1",
      Git_Config_Count: "9",
      git_config_key_0: "http.proxy",
      GIT_CONFIG_VALUE_9: "leftover",
      git_terminal_prompt: "1",
      GIT_CONFIG_GLOBAL: "C:\\work\\.gitconfig", // the user's own config file choice is kept
    });
    const names = Object.keys(env).map((k) => k.toUpperCase());
    for (const gone of ["GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSL_NO_VERIFY", "GIT_CONFIG_VALUE_9"]) {
      expect(names.filter((n) => n === gone)).toHaveLength(0);
    }
    for (const once of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_TERMINAL_PROMPT"]) {
      expect(names.filter((n) => n === once)).toHaveLength(1);
    }
    expect(env).toMatchObject({ Path: "C:\\bin", GIT_CONFIG_GLOBAL: "C:\\work\\.gitconfig", GIT_CONFIG_COUNT: "5", GIT_TERMINAL_PROMPT: "0" });
    expect(Object.values(env).join(" ")).not.toContain("evil");
  });
});

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

  it("runs only the push with the credential env, never argv, and the plumbing without it", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "main",
      remoteUrl: `https://${HOST}/scm/nrs/repo.git`,
      hasUpstream: true,
    });
    pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    const push = git.calls.at(-1)!;
    // clone_repo uses the same helper, so the two invocations cannot drift.
    expect(push.env).toEqual(gitCredentialEnv(AUTH, `https://${HOST}/scm/nrs/repo.git`));
    expect(push.env?.["GIT_CONFIG_VALUE_0"]).toBe(AUTH);
    for (const call of git.calls) {
      expect(call.args.join(" ")).not.toContain("Basic");
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
        /refusing to send credentials there/
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
      /is not a URL/
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

describe("cloneRepo", () => {
  const URL_OK = `https://${HOST}/int/stash/scm/nrs/repo.git`;

  it("clones from a neutral cwd with the credential env and pinned argv", () => {
    const dest = join(repoDir(), "clone");
    const git = fakeGit({ toplevel: "/unused", cloneOutput: "Cloning into 'clone'...\n" });
    const out = cloneRepo({ url: URL_OK, dest, shallow: true, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    expect(out).toContain("Cloning");
    expect(out).toContain("up to date");
    expect(git.calls.map((c) => c.args[0])).toEqual(["rev-parse", "config", "clone", "rev-parse", "checkout"]);
    expect(git.calls[1]!.args).toEqual(["config", "--list", "--show-scope"]);
    const clone = git.calls[2]!;
    expect(clone.args).toEqual(["clone", "--no-checkout", "--depth=1", URL_OK, dest]);
    expect(clone.env).toEqual(gitCredentialEnv(AUTH, URL_OK));
    expect(clone.cwd).toBe(tmpdir()); // never the server's own cwd
    for (const call of git.calls) {
      if (call.args[0] === "clone") continue;
      expect(call.env).toBeUndefined(); // only the network step carries the credential
    }
    // The working tree is populated afterwards, inside the clone, without the credential.
    expect(git.calls.slice(3).map((c) => c.cwd)).toEqual([dest, dest]);
    expect(git.calls.at(-1)!.args).toEqual(["checkout"]);
  });

  it("refuses when a url.*.insteadOf rule would rewrite the clone URL, and never runs clone", () => {
    const git = fakeGit({
      toplevel: "/unused",
      globalInsteadOf: { "https://attacker.example.com/": `https://${HOST}/int/stash/` },
    });
    expect(() =>
      cloneRepo({ url: URL_OK, dest: join(tmpdir(), "x"), shallow: false, expectedHost: HOST, authHeader: AUTH, exec: git.exec })
    ).toThrow(/insteadOf.*refusing to clone/);
    expect(git.calls.some((c) => c.args[0] === "clone")).toBe(false);
  });

  it("refuses an insteadOf rule with an EMPTY prefix, which git applies to every URL", () => {
    const git = fakeGit({
      toplevel: "/unused",
      globalInsteadOf: { "https://attacker.example.com/": "" },
    });
    expect(() =>
      cloneRepo({ url: URL_OK, dest: join(tmpdir(), "x"), shallow: false, expectedHost: HOST, authHeader: AUTH, exec: git.exec })
    ).toThrow(/rewrites every URL to https:\/\/attacker\.example\.com\//);
    expect(git.calls.some((c) => c.args[0] === "clone")).toBe(false);
  });

  it("refuses to run when the temp directory sits inside a repository", () => {
    const git = fakeGit({ toplevel: "/home/u/dotfiles", cwdInsideRepo: true });
    expect(() =>
      cloneRepo({ url: URL_OK, dest: join(tmpdir(), "x"), shallow: false, expectedHost: HOST, authHeader: AUTH, exec: git.exec })
    ).toThrow(/inside the git repository \/home\/u\/dotfiles/);
    expect(git.calls.map((c) => c.args[0])).toEqual(["rev-parse"]);
  });

  it("ignores insteadOf rules whose prefix does not match the clone URL", () => {
    const git = fakeGit({
      toplevel: "/unused",
      globalInsteadOf: { "ssh://git@github.com/": "https://github.com/" },
    });
    cloneRepo({ url: URL_OK, dest: join(tmpdir(), "x"), shallow: false, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    expect(git.calls.find((c) => c.args[0] === "clone")!.args).toEqual(["clone", "--no-checkout", URL_OK, join(tmpdir(), "x")]);
  });

  it("skips the checkout step for an empty repository (HEAD unborn)", () => {
    const git = fakeGit({ toplevel: "/unused", emptyRemote: true, cloneOutput: "warning: You appear to have cloned an empty repository.\n" });
    const out = cloneRepo({ url: URL_OK, dest: join(tmpdir(), "x"), shallow: false, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    expect(out).toContain("empty repository");
    expect(git.calls.map((c) => c.args[0])).toEqual(["rev-parse", "config", "clone", "rev-parse"]);
  });

  it("refuses a clone URL off the configured host, or with a relative dest, before any git runs", () => {
    const git = fakeGit({ toplevel: "/unused" });
    expect(() =>
      cloneRepo({ url: "https://attacker.example.com/x.git", dest: join(tmpdir(), "x"), shallow: false, expectedHost: HOST, authHeader: AUTH, exec: git.exec })
    ).toThrow(/not the configured Bitbucket host/);
    expect(() =>
      cloneRepo({ url: URL_OK, dest: "relative", shallow: false, expectedHost: HOST, authHeader: AUTH, exec: git.exec })
    ).toThrow(/absolute path/);
    expect(git.calls).toHaveLength(0);
  });
});

describe("cloneRepo checkout split (real git)", () => {
  it("keeps a template post-checkout hook from observing the header, unlike a plain clone", () => {
    if (process.platform === "win32") return; // the hook is a shell script
    const root = repoDir();
    const src = join(root, "src");
    const bare = join(root, "bare.git");
    const tmpl = join(root, "tmpl");
    const marker = join(root, "marker.txt");
    const g = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => defaultGitExec(args, { cwd, env, timeoutMs: 30_000 });
    g(["init", "-q", "-b", "main", src], root);
    writeFileSync(join(src, "a.txt"), "hi\n");
    g(["add", "a.txt"], src);
    g(["-c", "user.email=a@b.c", "-c", "user.name=a", "commit", "-q", "-m", "one"], src);
    g(["clone", "-q", "--bare", src, bare], root);
    mkdirSync(join(tmpl, "hooks"), { recursive: true });
    writeFileSync(
      join(tmpl, "hooks", "post-checkout"),
      `#!/bin/sh\necho "saw: \${GIT_CONFIG_VALUE_0:-<unset>}" >> "${marker}"\n`,
      { mode: 0o755 }
    );
    const url = `file://${bare}`;
    const base = { ...process.env, GIT_TEMPLATE_DIR: tmpl };

    // Control: a plain clone runs the template hook inside the credentialed process.
    g(["clone", "-q", url, join(root, "plain")], root, gitCredentialEnv(AUTH, url, base));
    expect(readFileSync(marker, "utf-8")).toContain(AUTH);
    rmSync(marker);

    // The split cloneRepo performs: credentialed --no-checkout, then a credential-free checkout.
    const dest = join(root, "split");
    g(["clone", "-q", "--no-checkout", url, dest], root, gitCredentialEnv(AUTH, url, base));
    expect(existsSync(marker)).toBe(false); // no checkout happened with the credential
    g(["checkout"], dest, base);
    expect(existsSync(join(dest, "a.txt"))).toBe(true);
    expect(readFileSync(marker, "utf-8")).toBe("saw: <unset>\n"); // hook ran, saw nothing
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
    const full = defaultGitExec(["config", "--list", "--show-scope"], { cwd: dir, timeoutMs: 30_000 });
    expect(full).toContain("local\thttp.proxy=http://127.0.0.1:1");
  });
});

describe("gitCredentialEnv (real git)", () => {
  it("keeps an inherited GIT_ASKPASS / SSH_ASKPASS program from running on a credential prompt", () => {
    if (process.platform === "win32") return; // the marker program is a shell script
    const dir = repoDir();
    const marker = join(dir, "askpass-ran");
    const script = join(dir, "askpass.sh");
    writeFileSync(script, `#!/bin/sh\necho ran >> "${marker}"\necho secret\n`, { mode: 0o755 });
    // `git credential fill` prompts exactly the way a 401 on clone/push does,
    // without needing a server: helpers first, then askpass, then terminal.
    const fill = (env: NodeJS.ProcessEnv) =>
      spawnSync("git", ["credential", "fill"], {
        cwd: dir,
        encoding: "utf-8",
        input: "protocol=https\nhost=example.invalid\n\n",
        env,
        timeout: 30_000,
      });

    // Control: with only the terminal prompt disabled, git runs GIT_ASKPASS.
    const control = fill({ ...process.env, GIT_ASKPASS: script, GIT_TERMINAL_PROMPT: "0" });
    expect(existsSync(marker)).toBe(true);
    expect(control.stdout).toContain("password=secret");
    rmSync(marker);

    // Guarded: the same inherited programs never run, and git fails instead.
    const guarded = fill(gitCredentialEnv(AUTH, "https://example.invalid/x.git", { ...process.env, GIT_ASKPASS: script, SSH_ASKPASS: script }));
    expect(guarded.status).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(guarded.stdout).not.toContain("secret");
  });
});

// vi is imported for parity with the other suites; keep the linter satisfied.
void vi;
