import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Client, Server, utils } from "ssh2";
import { buildConnectOpts as serverOptions } from "../packages/server-mcp/src/ssh-client.js";
import { buildConnectOpts as imisOptions } from "../packages/imis-mcp/src/ssh-executor.js";

const { DEFAULT_SERVER_HOST_KEY } = createRequire(import.meta.url)("ssh2/lib/protocol/constants.js");
const defaultAlgorithms = [...DEFAULT_SERVER_HOST_KEY];

// Exercise the production connection builders against a loopback SSH fixture.
// All keys and credentials are synthetic; no commands are executed.
describe("SSH host-key negotiation with the production connection options", () => {
  let dir;
  let knownHosts;
  let server;
  let port;
  let rsa;
  let ed25519;
  const connections = new Set();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "raven-host-key-negotiation-"));
    knownHosts = join(dir, "known_hosts");
    vi.stubEnv("RAVEN_KNOWN_HOSTS_PATH", knownHosts);
    vi.stubEnv("RAVEN_SSH_INSECURE_HOST_KEYS", "");
    rsa = utils.generateKeyPairSync("rsa", { bits: 2048 });
    ed25519 = utils.generateKeyPairSync("ed25519");
    server = new Server({ hostKeys: [ed25519.private, rsa.private] }, (connection) => {
      connections.add(connection);
      connection.on("error", () => {});
      connection.on("close", () => connections.delete(connection));
      connection.on("authentication", (context) => context.accept());
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    port = server.address().port;
  });

  afterAll(async () => {
    for (const connection of connections) connection.end();
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  const builders = [
    ["server-mcp", () => serverOptions(
      { host: "127.0.0.1", sshUser: "synthetic" },
      { kind: "password" }, "synthetic-password", undefined, undefined,
    )],
    ["imis-mcp", () => imisOptions(
      "127.0.0.1", "synthetic", { kind: "password" },
      "synthetic-password", undefined, undefined,
    )],
  ];

  function connect(buildOptions) {
    return new Promise((resolve) => {
      const client = new Client();
      let algorithm;
      client.once("ready", () => {
        client.end();
        resolve({ ready: true, algorithm });
      });
      client.once("error", (error) => {
        client.end();
        resolve({ ready: false, error: error.message, algorithm });
      });
      client.connect({
        ...buildOptions(),
        port,
        readyTimeout: 3000,
        debug: (line) => {
          if (line.startsWith("Handshake: Host key format: ")) {
            algorithm = line.slice("Handshake: Host key format: ".length);
          }
        },
      });
    });
  }

  describe.each(builders)("%s", (_name, buildOptions) => {
    it("preserves exactly the installed enabled algorithms without mutating their defaults", () => {
      writeFileSync(knownHosts, `127.0.0.1 ${rsa.public}\n127.0.0.1 ssh-dss disabled-key\n`);
      expect([...buildOptions().algorithms.serverHostKey].sort()).toEqual([...defaultAlgorithms].sort());
      expect(DEFAULT_SERVER_HOST_KEY).toEqual(defaultAlgorithms);
    });

    it("connects using the pinned RSA key when the server also offers Ed25519", async () => {
      writeFileSync(knownHosts, `127.0.0.1 ${rsa.public}\n`);
      const result = await connect(buildOptions);
      expect(result).toEqual({ ready: true, algorithm: "rsa-sha2-512" });
    });

    it("retains Ed25519 priority when both keys are pinned", async () => {
      writeFileSync(knownHosts, `127.0.0.1 ${rsa.public}\n127.0.0.1 ${ed25519.public}\n`);
      expect(await connect(buildOptions)).toEqual({ ready: true, algorithm: "ssh-ed25519" });
    });

    it("rejects a replacement key even when its algorithm is preferred", async () => {
      const replacement = utils.generateKeyPairSync("ed25519");
      writeFileSync(knownHosts, `127.0.0.1 ${replacement.public}\n`);
      expect(await connect(buildOptions)).toMatchObject({
        ready: false, error: "Host denied (verification failed)",
      });
    });

    it("rejects revoked keys even with stale positive pins", async () => {
      writeFileSync(knownHosts, [
        `127.0.0.1 ${rsa.public}`,
        `127.0.0.1 ${ed25519.public}`,
        `@revoked * ${rsa.public}`,
        `@revoked * ${ed25519.public}`,
      ].join("\n"));
      expect(await connect(buildOptions)).toMatchObject({
        ready: false, error: "Host denied (verification failed)",
      });
    });

    it.each(["missing", "malformed", "certificate authority"])("rejects a %s trust file during handshake", async (kind) => {
      if (kind === "missing") rmSync(knownHosts);
      else writeFileSync(knownHosts, kind === "malformed"
        ? "127.0.0.1\n|1|broken ssh-rsa key\n"
        : `@cert-authority 127.0.0.1 ${ed25519.public}\n`);
      expect(await connect(buildOptions)).toMatchObject({
        ready: false, error: "Host denied (verification failed)",
      });
    });
  });
});
