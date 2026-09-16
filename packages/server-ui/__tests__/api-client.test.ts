import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { localGuard } from "../src/lib/local-guard.js";
import { apiFetch } from "../public/js/components/api.js";
import { healthRouter } from "../src/routes/health.js";
import { startCollector, stopCollector } from "../src/lib/collector.js";

vi.mock("../src/lib/store.js", () => ({
  getServerStatuses: () => ({}),
  loadStore: () => ({ errorSnapshots: [], versionSnapshots: [] }),
}));
vi.mock("../src/lib/collector.js", () => ({
  getCollectorStatus: () => ({ running: false, lastRun: null, nextRun: null }),
  startCollector: vi.fn(), stopCollector: vi.fn(),
}));

let server: Server;
let baseUrl: string;
const handler = vi.fn();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api", (req, res, next) => localGuard((server.address() as AddressInfo).port)(req, res, next));
  app.use("/api/health", healthRouter);
  app.all("/api/probe", (req, res) => {
    handler();
    res.json({ method: req.method, body: req.body, client: req.headers["x-raven-ui"] });
  });
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
});

beforeEach(() => handler.mockClear());

describe("dashboard API caller verification", () => {
  it.each(["GET", "HEAD"])("preserves metadata-free %s health probes", async method => {
    for (const path of ["/api/health", "/api/health/"]) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      expect(response.status).toBe(200);
      if (method === "GET") expect(await response.json()).toMatchObject({ status: "starting" });
      else await response.text();
    }
  });

  it("keeps health collector actions protected", async () => {
    for (const action of ["start", "stop"]) {
      const response = await fetch(`${baseUrl}/api/health/collector/${action}`, { method: "POST" });
      expect(response.status).toBe(403);
      await response.text();
    }
    expect(startCollector).not.toHaveBeenCalled();
    expect(stopCollector).not.toHaveBeenCalled();
  });

  it.each([
    { Host: "untrusted.example" }, { Origin: "https://untrusted.example" }, { "Sec-Fetch-Site": "cross-site" },
  ])("still validates health probe headers: %j", async headers => {
    // Node fetch owns the Host header; use HTTP directly to exercise a
    // genuinely untrusted Host on the wire.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${baseUrl}/api/health`, { headers }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      });
      request.once("error", reject);
      request.end();
    });
    expect(status).toBe(403);
  });

  it.each(["GET", "HEAD"])("blocks metadata-free %s before the handler", async method => {
    const response = await fetch(`${baseUrl}/api/probe`, { method });
    expect(response.status).toBe(403);
    await response.text();
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts the dashboard helper without Origin or fetch metadata", async () => {
    const response = await apiFetch(`${baseUrl}/api/probe`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ method: "GET", client: "1" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each([new Headers({ "Content-Type": "application/json" }), { "Content-Type": "application/json" }])(
    "preserves write bodies and existing headers", async headers => {
      const response = await apiFetch(`${baseUrl}/api/probe`, {
        method: "PUT", headers, body: JSON.stringify({ enabled: true }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ method: "PUT", body: { enabled: true }, client: "1" });
    },
  );

  it("accepts same-origin metadata for native streams and downloads", async () => {
    const response = await fetch(`${baseUrl}/api/probe`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(response.status).toBe(200);
    await response.text();
  });

  it.each([
    { Origin: "https://untrusted.example" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site" },
  ])("does not let the client header override cross-origin evidence: %j", async headers => {
    const response = await apiFetch(`${baseUrl}/api/probe`, { headers });
    expect(response.status).toBe(403);
    await response.text();
    expect(handler).not.toHaveBeenCalled();
  });
});
