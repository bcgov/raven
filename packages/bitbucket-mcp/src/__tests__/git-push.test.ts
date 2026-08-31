import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushRepo, type GitExec } from "../git-push.js";

const HOST = "bwa.example.gov.bc.ca";
const AUTH = "Authorization: Basic Zm9vOmJhcg==";

/**
 * Fake git. Answers rev-parse/symbolic-ref/remote lookups from `state` and
 * records every invocation; `push` returns state.pushOutput.
 */
function fakeGit(state: {
  toplevel: string;
  currentBranch?: string;
  remoteUrl?: string;
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
      if (!state.remoteUrl) throw new Error(`fatal: No such remote '${args[3]}'`);
      return state.remoteUrl + "\n";
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
    expect(push.args).toEqual(["push", "origin", "refs/heads/feature/x:refs/heads/feature/x"]);
  });

  it("passes credentials via GIT_CONFIG_* env, never argv", () => {
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
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: AUTH,
      GIT_TERMINAL_PROMPT: "0",
    });
    for (const call of git.calls) {
      expect(call.args.join(" ")).not.toContain("Basic");
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

  it("strips embedded userinfo from the reported remote URL", () => {
    const dir = repoDir();
    const git = fakeGit({
      toplevel: dir,
      currentBranch: "main",
      remoteUrl: `https://user:secret@${HOST}/scm/nrs/repo.git`,
      hasUpstream: true,
    });
    const result = pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec: git.exec });
    expect(result.remoteUrl).toBe(`https://${HOST}/scm/nrs/repo.git`);
    expect(result.remoteUrl).not.toContain("secret");
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
      if (args[0] === "rev-parse") return "origin/main\n";
      throw new Error("remote: rejected (pre-receive hook declined)");
    };
    expect(() => pushRepo({ dir, expectedHost: HOST, authHeader: AUTH, exec })).toThrow(
      /pre-receive hook declined/
    );
  });
});

// vi is imported for parity with the other suites; keep the linter satisfied.
void vi;
