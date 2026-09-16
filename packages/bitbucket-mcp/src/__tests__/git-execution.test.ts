import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGitExec, gitCredentialEnv, gitPlumbingEnv, pushRepo } from "../git-push.js";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const root = mkdtempSync(join(tmpdir(), "raven-git-execution-"));
const globalConfig = join(root, "global.config");
writeFileSync(globalConfig, "");
const env = {
  ...gitPlumbingEnv(),
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  NO_PROXY: "*",
  no_proxy: "*",
};
const auth = "Authorization: Basic c3ludGhldGljOnRlc3Q=";
const g = (args: string[], cwd = root, childEnv: NodeJS.ProcessEnv = env) =>
  defaultGitExec(args, { cwd, env: childEnv, timeoutMs: 5_000 });
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("Git credential isolation", () => {
  it("replaces inherited plain and URL-scoped HTTP headers on the wire", async () => {
    const received: { headers: string[] }[] = [];
    const server = createServer((req, res) => {
      received.push({ headers: req.rawHeaders });
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
    const config = join(root, "headers.config");
    try {
      for (const key of ["http.extraHeader", `http.${url}.extraHeader`]) {
        await g(["config", "--file", config, "--add", key, "Authorization: Basic stale"]);
        await g(["config", "--file", config, "--add", key, "Cookie: stale=1"]);
      }
      // HTTP is enabled only for the synthetic loopback fixture.
      await expect(g(["ls-remote", url], root, {
        ...gitCredentialEnv(auth, url, { ...env, GIT_CONFIG_GLOBAL: config }), GIT_ALLOW_PROTOCOL: "http",
      })).rejects.toThrow(/not found/);
      expect(received.length).toBeGreaterThan(0);
      for (const { headers } of received) {
        const sensitive = [];
        for (let i = 0; i < headers.length; i += 2) {
          if (["authorization", "cookie"].includes(headers[i].toLowerCase())) sensitive.push(`${headers[i]}: ${headers[i + 1]}`);
        }
        expect(sensitive).toEqual([auth]);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it.skipIf(process.platform === "win32")("disables repository-configured push signing", async () => {
    const src = join(root, "signed-source"), bare = join(root, "signed-remote.git");
    const marker = join(root, "signing-program-ran");
    const signer = join(root, "signer");
    await g(["init", "-q", "-b", "main", src]);
    await g(["config", "user.name", "Test"], src);
    await g(["config", "user.email", "test@example.invalid"], src);
    writeFileSync(join(src, "file.txt"), "one\n");
    await g(["add", "file.txt"], src);
    await g(["commit", "-qm", "one"], src);
    await g(["init", "-q", "--bare", bare]);
    await g(["config", "receive.certNonceSeed", "synthetic-test"], bare);
    await g(["remote", "add", "origin", "https://bitbucket.example/repo.git"], src);
    writeFileSync(signer, `#!/bin/sh\necho ran >> "${marker}"\nexit 1\n`, { mode: 0o700 });
    await g(["config", "gpg.program", signer], src);
    await g(["config", "push.gpgSign", "true"], src);
    const url = `file://${bare}`;
    const control = spawnSync("git", ["push", url, "refs/heads/main:refs/heads/main"], {
      cwd: src, env: { ...gitCredentialEnv(auth, url, env), GIT_ALLOW_PROTOCOL: "file" },
    });
    expect(control.status).not.toBe(0);
    expect(readFileSync(marker, "utf-8")).toContain("ran");
    rmSync(marker);
    await pushRepo({
      dir: src, branch: "main", expectedHost: "bitbucket.example", authHeader: auth,
      // Exercise the production push arguments against an offline bare repo.
      exec: (args, opts) => defaultGitExec(args[0] === "push" ? args.map(arg => arg === "origin" ? url : arg) : args, {
        ...opts, env: { ...opts.env, ...env, GIT_ALLOW_PROTOCOL: "file" },
      }),
    });
    expect(existsSync(marker)).toBe(false);
    expect(await g(["rev-parse", "main"], bare)).toBe(await g(["rev-parse", "main"], src));
  });

  it("keeps OS/CA/proxy settings but removes provider credentials in every case", () => {
    const base = {
      PATH: "/usr/bin", HOME: "/home/test", SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "http://proxy.example:8080", GIT_SSL_CAINFO: "/ca.pem",
      ATLASSIAN_PASSWORD: "synthetic", Atlassian_Password: "synthetic",
      SMSESSION: "synthetic", SONAR_TOKEN: "synthetic", JENKINS_PASSWORD: "synthetic",
      GIT_ALLOW_PROTOCOL: "file", GIT_CONFIG_COUNT: "1",
    };
    const plumbing = gitPlumbingEnv(base);
    expect(plumbing).toEqual({
      PATH: base.PATH, HOME: base.HOME, SystemRoot: base.SystemRoot,
      HTTPS_PROXY: base.HTTPS_PROXY, GIT_SSL_CAINFO: base.GIT_SSL_CAINFO,
    });
    const credentialed = gitCredentialEnv(auth, "https://bitbucket.example/repo.git", base);
    expect(credentialed.GIT_ALLOW_PROTOCOL).toBe("https");
    expect(Object.values(credentialed)).not.toContain("synthetic");
  });

  it("rejects an actual repository's custom remote transport before pushing", async () => {
    const dir = join(root, "transport");
    await g(["init", "-q", "-b", "main", dir]);
    await g(["remote", "add", "origin", "https://bitbucket.example/repo.git"], dir);
    await g(["config", "remote.origin.vcs", "ext"], dir);
    await expect(pushRepo({ dir, branch: "main", expectedHost: "bitbucket.example", authHeader: auth }))
      .rejects.toThrow(/repository-local git config.*remote\.origin\.vcs/);
    // The credential environment also blocks a command-scope override, which
    // bypasses the local-config check but must not enable another transport.
    await expect(g(["-c", "remote.origin.vcs=ext", "-c", "protocol.ext.allow=always", "ls-remote", "origin"], dir,
      { ...env, ...gitCredentialEnv(auth, "https://bitbucket.example/repo.git", env) }))
      .rejects.toThrow(/transport 'ext' not allowed/);
  });

  it("disables the reference-transaction hook during a successful push", async () => {
    if (process.platform === "win32") return; // shell hook fixture
    const src = join(root, "push-source"), bare = join(root, "push-remote.git");
    const marker = join(root, "reference-hook-ran");
    await g(["init", "-q", "-b", "main", src]);
    await g(["config", "user.name", "Test"], src);
    await g(["config", "user.email", "test@example.invalid"], src);
    writeFileSync(join(src, "file.txt"), "one\n");
    await g(["add", "file.txt"], src);
    await g(["commit", "-q", "-m", "one"], src);
    await g(["clone", "-q", "--bare", src, bare]);
    const url = `file://${bare}`;
    await g(["remote", "add", "origin", url], src);
    writeFileSync(join(src, ".git", "hooks", "reference-transaction"),
      `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
    writeFileSync(join(src, "file.txt"), "two\n");
    await g(["commit", "-qam", "two"], src);
    const args = ["push", "--no-verify", "--no-follow-tags", "--recurse-submodules=no", "--set-upstream", "origin", "refs/heads/main:refs/heads/main"];
    // Local transport is enabled only for this offline fixture.
    const fixtureEnv = { ...env, ...gitCredentialEnv(auth, url, env), GIT_ALLOW_PROTOCOL: "file" };
    const control = spawnSync("git", args, { cwd: src, env: fixtureEnv });
    expect(control.status).toBe(0);
    expect(readFileSync(marker, "utf-8")).toContain("ran");
    rmSync(marker);
    writeFileSync(join(src, "file.txt"), "three\n");
    await g(["commit", "-qam", "three"], src);
    await g(args, src, fixtureEnv);
    expect(existsSync(marker)).toBe(false);
    expect(await g(["rev-parse", "main"], bare)).toBe(await g(["rev-parse", "main"], src));
  });
});

describe("asynchronous Git execution", () => {
  it.skipIf(process.platform === "win32")("observes cancellation that happens while starting the process", async () => {
    const controller = new AbortController();
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(spawn).mockImplementationOnce(((...args: Parameters<typeof spawn>) => {
      const child = actual.spawn(...args);
      controller.abort();
      return child;
    }) as typeof spawn);
    await expect(defaultGitExec(["-c", "alias.wait=!sleep 10", "wait"], {
      cwd: root, env, timeoutMs: 250, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("shares the output ceiling across stdout and stderr", async () => {
    const dir = join(root, "combined-output-limit");
    await g(["init", "-q", dir]);
    writeFileSync(join(dir, "payload"), Buffer.alloc(9 * 1024 * 1024, "x"));
    // Each stream is below 16 MiB, but the invocation emits 18 MiB in total.
    const error = await g(["-c", "alias.emit=!cat payload; cat payload >&2", "emit"], dir)
      .then(() => undefined, (failure: Error) => failure);
    expect(error?.message).toMatch(/output limit/);
  });

  it("enforces the output ceiling while reading a large Git object", async () => {
    const dir = join(root, "output-limit");
    await g(["init", "-q", dir]);
    writeFileSync(join(dir, "large.txt"), Buffer.alloc(17 * 1024 * 1024, "x"));
    const object = (await g(["hash-object", "-w", "large.txt"], dir)).trim();
    await expect(g(["cat-file", "blob", object], dir)).rejects.toThrow(/output limit/);
  });

  it("serves a local response while Git is running", async () => {
    let served = false;
    const server = createServer((_req, res) => {
      served = true;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/missing.git`;
      await expect(g(["ls-remote", url])).rejects.toThrow(/not found/);
      expect(served).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("cancels an in-flight Git command and its network helper", async () => {
    let notifyRequest!: () => void;
    const received = new Promise<void>(resolve => { notifyRequest = resolve; });
    let disconnected = false;
    const server = createServer(req => {
      req.socket.once("close", () => { disconnected = true; });
      notifyRequest(); // response intentionally held
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const controller = new AbortController();
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pending.git`;
      const command = defaultGitExec(["ls-remote", url], { cwd: root, env, timeoutMs: 5_000, signal: controller.signal });
      const rejected = expect(command).rejects.toMatchObject({ name: "AbortError" });
      await received;
      controller.abort();
      await rejected;
      await expect.poll(() => disconnected).toBe(true);
    } finally {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("propagates cancellation between checks without reaching the push", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    await expect(pushRepo({
      dir: root, branch: "main", expectedHost: "bitbucket.example", authHeader: auth,
      signal: controller.signal,
      exec: async (args, opts) => {
        calls.push(args[0]!);
        expect(opts.signal).toBe(controller.signal);
        controller.abort();
        throw controller.signal.reason;
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toEqual(["rev-parse"]);
  });

  it("enforces the timeout and stops the waiting network helper", async () => {
    let disconnected = false;
    const server = createServer(req => {
      req.socket.once("close", () => { disconnected = true; });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/pending.git`;
      await expect(defaultGitExec(["ls-remote", url], { cwd: root, env, timeoutMs: 1_000 }))
        .rejects.toThrow(/timed out/);
      await expect.poll(() => disconnected).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
