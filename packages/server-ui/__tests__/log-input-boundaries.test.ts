import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { searchLogs, sshExec, sshExecStream } from "@nrs/server-mcp/client";
import { logsRouter } from "../src/routes/logs.js";
import { logDownloadRouter } from "../src/routes/log-download.js";

vi.mock("@nrs/server-mcp/client", () => ({
  searchLogs: vi.fn(),
  sshExec: vi.fn(),
  sshExecStream: vi.fn(),
}));
vi.mock("../src/lib/server-config.js", () => ({
  getServerNames: () => ["testserver"],
  getServerConfig: () => [{ name: "testserver", logsBase: "/logs" }],
}));
vi.mock("../src/lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use("/logs", logsRouter);
  app.use("/download", logDownloadRouter);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(searchLogs).mockResolvedValue({ output: "No matches", exitCode: 0 });
  // A valid download request reaches the preflight but never opens an SSH
  // stream. The synthetic missing file gives a deterministic 404 response.
  vi.mocked(sshExec).mockResolvedValue({ stdout: "MISSING", stderr: "", exitCode: 0 });
});

async function request(route: string, overrides: Record<string, string>): Promise<Response> {
  const query = new URLSearchParams({
    server: "testserver", app: "APP_2", component: "api-v2", pattern: "ERROR", ...overrides,
  });
  return fetch(`${baseUrl}/${route}?${query}`);
}

describe.each([
  { route: "logs", fields: ["date", "dateFrom", "dateTo", "app", "component"] },
  { route: "download", fields: ["date", "app", "component"] },
])("$route HTTP input boundary", ({ route, fields }) => {
  it.each([
    { label: "LF", suffix: "\n" },
    { label: "CR", suffix: "\r" },
    { label: "CRLF", suffix: "\r\n" },
    { label: "LINE SEPARATOR", suffix: "\u2028" },
    { label: "PARAGRAPH SEPARATOR", suffix: "\u2029" },
    { label: "NUL", suffix: "\0" },
  ])("rejects URL-decoded trailing $label before remote work", async ({ suffix }) => {
    for (const field of fields) {
      const prefix = field.startsWith("date") ? "2026-09-15" : "APP";
      const response = await request(route, { [field]: `${prefix}${suffix}` });
      expect(response.status, field).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
    for (const sentinel of route === "logs" ? ["today", "current"] : ["current"]) {
      const response = await request(route, { date: `${sentinel}${suffix}` });
      expect(response.status, sentinel).toBe(400);
      await response.text();
    }
    expect(searchLogs).not.toHaveBeenCalled();
    expect(sshExec).not.toHaveBeenCalled();
    expect(sshExecStream).not.toHaveBeenCalled();
  });
});

describe("valid HTTP log dates", () => {
  it.each([
    { date: undefined, expected: undefined },
    { date: "2026-09-15", expected: "2026-09-15" },
    { date: "today", expected: "today" },
    { date: "current", expected: undefined },
  ])("accepts search date $date", async ({ date, expected }) => {
    const response = await request("logs", date === undefined ? {} : { date });
    expect(response.status).toBe(200);
    await response.text();
    expect(searchLogs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      app: "APP_2", component: "api-v2", date: expected,
    }));
  });

  it("forwards a complete search date range", async () => {
    const dates = { dateFrom: "2026-09-14", dateTo: "2026-09-15" };
    const response = await request("logs", dates);
    expect(response.status).toBe(200);
    await response.text();
    expect(searchLogs).toHaveBeenCalledWith(expect.anything(), expect.objectContaining(dates));
  });

  it.each([undefined, "2026-09-15", "current"])("accepts download date %s", async (date) => {
    const response = await request("download", date === undefined ? {} : { date });
    expect(response.status).toBe(404);
    await response.text();
    expect(sshExec).toHaveBeenCalledOnce();
    expect(sshExec).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("/logs/APP_2/api-v2/"), 30_000);
    expect(sshExecStream).not.toHaveBeenCalled();
  });
});
