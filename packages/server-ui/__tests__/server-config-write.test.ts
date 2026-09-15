import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localGuard } from "../src/lib/local-guard.js";

vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const good = {
  name: "testserver", host: "testserver.example.invalid", sshUser: "Reviewer_A",
  sudoUser: "tomcat", role: "TEST", description: "Synthetic test server",
  appsBase: "/apps_ux", logsBase: "/apps_ux/logs",
};
const baseline = "# Test-only server configuration\n" + Object.values(good).join("|") + "\n";
const fields = Object.keys(good) as Array<keyof typeof good>;
let config: typeof import("../src/lib/server-config.js");
let configDir: string;
let configPath: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  configDir = mkdtempSync(join(tmpdir(), "raven-settings-validation-"));
  configPath = join(configDir, "servers.conf");
  vi.stubEnv("SERVER_TOOLS_BIN", configDir);
  vi.resetModules();
  config = await import("../src/lib/server-config.js");
  const { settingsRouter } = await import("../src/routes/settings.js");
  const app = express();
  app.use(express.json());
  app.use("/api", (req, res, next) => localGuard((server.address() as AddressInfo).port)(req, res, next));
  app.use("/api/servers", settingsRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  writeFileSync(configPath, baseline, "utf-8");
  config.reloadServerConfig();
});

async function put(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/servers`, {
    method: "PUT", headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify(body),
  });
}

function expectUnchanged(previousCache: ReturnType<typeof config.getServerConfig>): void {
  expect(readFileSync(configPath, "utf-8")).toBe(baseline);
  expect(config.getServerConfig()).toBe(previousCache);
}

describe("server settings writes validate the full batch before persistence", () => {
  it("keeps an existing unsafe path visible through GET so it can be repaired", async () => {
    const legacy = { ...good, logsBase: "/legacy path;id" };
    writeFileSync(configPath, Object.values(legacy).join("|") + "\n", "utf-8");
    config.reloadServerConfig();
    const response = await fetch(`${baseUrl}/api/servers`, { headers: { Origin: baseUrl } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([legacy]);
  });

  it("rejects a shell command in logsBase through the accepted local-origin HTTP path", async () => {
    const cache = config.getServerConfig();
    const response = await put([{ ...good, logsBase: "/tmp; id" }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expectUnchanged(cache);
  });

  it.each(fields)("rejects configuration delimiters in %s before trimming", async (field) => {
    const cache = config.getServerConfig();
    for (const separator of ["|", "\n", "\r", "\r\n", "\0", "\t", "\u007f", "\u0085", "\u2028", "\u2029"]) {
      const response = await put([{ ...good, [field]: `${good[field]}${separator}` }]);
      expect(response.status, JSON.stringify(separator)).toBe(400);
      await response.text();
      expectUnchanged(cache);
    }
  });

  it.each(["appsBase", "logsBase"] as const)("rejects unsafe shell-bound %s paths", async (field) => {
    const cache = config.getServerConfig();
    for (const path of ["relative/path", "~/apps", "/tmp;id", "/tmp$(id)", "/tmp`id`", "/tmp&&id", "/tmp>out", "/tmp space", "/tmp/*", "/tmp/../apps", "/tmp/./apps", "/tmp/'quoted'"]) {
      const response = await put([{ ...good, [field]: path }]);
      expect(response.status, path).toBe(400);
      await response.text();
      expectUnchanged(cache);
    }
  });

  it("rejects an invalid second entry without writing the valid first entry", async () => {
    const cache = config.getServerConfig();
    const response = await put([good, { ...good, name: "second", description: "shift|/tmp; id" }]);
    expect(response.status).toBe(400);
    await response.text();
    expectUnchanged(cache);
  });

  it("protects direct writer callers as well as the HTTP route", () => {
    const cache = config.getServerConfig();
    expect(() => config.saveServerConfig([{ ...good, appsBase: "/tmp$(id)" }])).toThrow();
    expectUnchanged(cache);
  });

  it("keeps an actual write failure as HTTP 500 without reloading the cache", async () => {
    const cache = config.getServerConfig();
    const backupPath = join(configDir, "servers.conf.backup");
    renameSync(configPath, backupPath);
    mkdirSync(configPath);
    try {
      const response = await put([good]);
      expect(response.status).toBe(500);
      await response.text();
      expect(config.getServerConfig()).toBe(cache);
      expect(readFileSync(backupPath, "utf-8")).toBe(baseline);
    } finally {
      rmSync(configPath, { recursive: true });
      renameSync(backupPath, configPath);
    }
  });

  it.each([null, 123, "server", []])(
    "rejects malformed entries instead of coercing their values: %j", async (entry) => {
      const cache = config.getServerConfig();
      const response = await put([entry]);
      expect(response.status).toBe(400);
      await response.text();
      expectUnchanged(cache);
    },
  );

  it.each(fields)("rejects non-string %s values instead of coercing them", async (field) => {
    const cache = config.getServerConfig();
    for (const value of [123, true, {}, []]) {
      const response = await put([{ ...good, [field]: value }]);
      expect(response.status).toBe(400);
      await response.text();
      expectUnchanged(cache);
    }
  });

  it.each([[], {}, "servers", 123])("rejects a malformed configuration body: %j", async (body) => {
    const cache = config.getServerConfig();
    const response = await put(body);
    expect(response.status).toBe(400);
    await response.text();
    expectUnchanged(cache);
  });

  it.each(["name", "host", "sshUser", "role"] as const)("requires a nonempty %s", async (field) => {
    const cache = config.getServerConfig();
    const response = await put([{ ...good, [field]: "  " }]);
    expect(response.status).toBe(400);
    await response.text();
    expectUnchanged(cache);
  });

  it("rejects duplicate normalized server names before replacing the file", async () => {
    const cache = config.getServerConfig();
    const response = await put([good, { ...good, name: " TESTSERVER " }]);
    expect(response.status).toBe(400);
    await response.text();
    expectUnchanged(cache);
  });

  it("preserves supported descriptions, names, paths and defaults", async () => {
    const { appsBase: _apps, logsBase: _logs, ...withoutPaths } = good;
    const response = await put([{
      ...withoutPaths, name: " TESTSERVER ", sudoUser: "",
      description: "  Server for Łingít / ᐃᓄᒃᑎᑐᑦ (test)  ",
    }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      ...good, sudoUser: "", description: "Server for Łingít / ᐃᓄᒃᑎᑐᑦ (test)",
    }]);
    expect(config.getServerConfig()).toEqual([{
      ...good, sudoUser: "", description: "Server for Łingít / ᐃᓄᒃᑎᑐᑦ (test)",
    }]);
    expect(readFileSync(configPath, "utf-8")).toContain("testserver|testserver.example.invalid|Reviewer_A||TEST|");
  });

  it.each([null, "", "  "])("preserves unset path defaults: %j", async (path) => {
    const response = await put([{ ...good, appsBase: path, logsBase: path }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([good]);
  });

  it.each(["/", "/sw_ux/httpd01", "/opt/apps-1.2_/", "/apps_ux/logs"])("preserves supported absolute paths: %s", async (path) => {
    const response = await put([{ ...good, appsBase: path, logsBase: path }]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ ...good, appsBase: path, logsBase: path }]);
  });

  it.each(["2001:db8::1", "127.0.0.1", "TESTSERVER.Example.Invalid"])("preserves ssh2 hostname and legacy account spelling: %s", async (host) => {
    const entry = { ...good, name: "_test-server", host, sshUser: "DOMAIN\\Reviewer_A", sudoUser: "service.account", role: "TEST / shared" };
    const response = await put([entry]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([entry]);
  });

  it("allows the existing frontend save flow to persist a direct SSH server with no sudo user", async () => {
    const classes: Record<string, string> = {
      ".srv-name": good.name, ".srv-host": good.host, ".srv-ssh-user": good.sshUser,
      ".srv-sudo-user": "", ".srv-role": good.role, ".srv-desc": good.description,
      ".srv-apps-base": "", ".srv-logs-base": "",
    };
    const browserWindow = {
      views: {} as Record<string, { save(): Promise<void>; renderTable(): void }>,
      reloadAppData: vi.fn().mockResolvedValue(undefined), showToast: vi.fn(),
    };
    const status = { innerHTML: "" };
    runInNewContext(readFileSync(new URL("../public/js/views/settings.js", import.meta.url), "utf-8"), {
      window: browserWindow,
      document: {
        querySelectorAll: () => [{ querySelector: (selector: string) => ({ value: classes[selector] }) }],
        getElementById: () => status,
      },
      fetch: (url: string, options: RequestInit) => fetch(`${baseUrl}${url}`, {
        ...options, headers: { ...options.headers, Origin: baseUrl },
      }),
    });
    browserWindow.views.settings.renderTable = vi.fn();
    await browserWindow.views.settings.save();
    expect(browserWindow.showToast).toHaveBeenCalledWith("Server configuration saved", "success");
    expect(config.getServerConfig()).toEqual([{ ...good, sudoUser: "" }]);
    expect(readFileSync(configPath, "utf-8")).toContain("testserver|testserver.example.invalid|Reviewer_A||TEST|");
  });
});
