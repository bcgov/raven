import { describe, it, expect, vi } from "vitest";
import { SonarClient } from "../sonar-client.js";

// ---------------------------------------------------------------------------
// Mock fetch factory
// ---------------------------------------------------------------------------

function createMockFetch(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: unknown;
  text?: string;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? (response.ok ? "OK" : "Error"),
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(response.text ?? JSON.stringify(response.body ?? {})),
  });
}

describe("SonarClient constructor", () => {
  it("strips trailing slashes from baseUrl", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: {} });
    const client = new SonarClient("https://sonar.example.com///", "token123", mockFetch as any);

    await client.getQualityGate("test-project");
    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/sonar\.example\.com\//);
    expect(url).not.toMatch(/\/\/\//);
  });

  it("encodes token as Base64 Basic auth with empty password", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: {} });
    const client = new SonarClient("https://sonar.example.com", "my-token", mockFetch as any);

    await client.getQualityGate("test-project");
    const opts = mockFetch.mock.calls[0][1];
    const expected = `Basic ${Buffer.from("my-token:").toString("base64")}`;
    expect(opts.headers.Authorization).toBe(expected);
  });
});

describe("SonarClient API operations", () => {
  it("searchIssues builds correct query parameters", async () => {
    const mockResponse = { total: 1, p: 1, ps: 100, issues: [] };
    const mockFetch = createMockFetch({ ok: true, status: 200, body: mockResponse });
    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    await client.searchIssues("proj-key", "feature/x", {
      inNewCodePeriod: true,
      severities: ["CRITICAL", "BLOCKER"],
      types: ["BUG"],
      pageSize: 50,
      page: 2,
    });

    const url: string = mockFetch.mock.calls[0][0];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/api/issues/search");
    expect(parsedUrl.searchParams.get("componentKeys")).toBe("proj-key");
    expect(parsedUrl.searchParams.get("branch")).toBe("feature/x");
    expect(parsedUrl.searchParams.get("severities")).toBe("CRITICAL,BLOCKER");
    expect(parsedUrl.searchParams.get("types")).toBe("BUG");
    expect(parsedUrl.searchParams.get("sinceLeakPeriod")).toBe("true");
    expect(parsedUrl.searchParams.get("ps")).toBe("50");
    expect(parsedUrl.searchParams.get("p")).toBe("2");
  });

  it("getQualityGate queries project status", async () => {
    const mockResponse = { projectStatus: { status: "OK", conditions: [] } };
    const mockFetch = createMockFetch({ ok: true, status: 200, body: mockResponse });
    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    const result = await client.getQualityGate("proj-key", "main");
    expect(result).toEqual(mockResponse);

    const url: string = mockFetch.mock.calls[0][0];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/api/qualitygates/project_status");
    expect(parsedUrl.searchParams.get("projectKey")).toBe("proj-key");
    expect(parsedUrl.searchParams.get("branch")).toBe("main");
  });

  it("listAnalyses queries project analyses", async () => {
    const mockResponse = { paging: { pageIndex: 1, pageSize: 1, total: 1 }, analyses: [] };
    const mockFetch = createMockFetch({ ok: true, status: 200, body: mockResponse });
    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    const result = await client.listAnalyses("proj-key", "main", 5);
    expect(result).toEqual(mockResponse);

    const url: string = mockFetch.mock.calls[0][0];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/api/project_analyses/search");
    expect(parsedUrl.searchParams.get("project")).toBe("proj-key");
    expect(parsedUrl.searchParams.get("branch")).toBe("main");
    expect(parsedUrl.searchParams.get("ps")).toBe("5");
  });

  it("searchHotspots fetches TO_REVIEW and REVIEWED-ACKNOWLEDGED when specified", async () => {
    const toReviewResp = {
      paging: { pageIndex: 1, pageSize: 200, total: 3 },
      hotspots: [{ key: "h1" }, { key: "h2" }, { key: "h3" }],
    };
    const reviewedResp = {
      paging: { pageIndex: 1, pageSize: 200, total: 1 },
      hotspots: [{ key: "h4" }],
    };

    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(toReviewResp),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(reviewedResp),
      });

    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    const result = await client.searchHotspots("proj-key", "main", { includeAcknowledged: true });
    expect(result.hotspots).toHaveLength(4);
    expect(result.paging.total).toBe(4);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const url1: string = mockFetch.mock.calls[0][0];
    const u1 = new URL(url1);
    expect(u1.searchParams.get("status")).toBe("TO_REVIEW");

    const url2: string = mockFetch.mock.calls[1][0];
    const u2 = new URL(url2);
    expect(u2.searchParams.get("status")).toBe("REVIEWED");
    expect(u2.searchParams.get("resolution")).toBe("ACKNOWLEDGED");
  });

  it("searchHotspots fetches TO_REVIEW only when includeAcknowledged is false", async () => {
    const toReviewResp = {
      paging: { pageIndex: 1, pageSize: 200, total: 3 },
      hotspots: [{ key: "h1" }, { key: "h2" }, { key: "h3" }],
    };

    const mockFetch = createMockFetch({ ok: true, status: 200, body: toReviewResp });
    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    const result = await client.searchHotspots("proj-key", "main", { includeAcknowledged: false });
    expect(result.hotspots).toHaveLength(3);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("getComponentMeasures queries specific metrics", async () => {
    const mockResponse = { component: { key: "proj-key", name: "Proj", qualifier: "TRK", measures: [] } };
    const mockFetch = createMockFetch({ ok: true, status: 200, body: mockResponse });
    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    const result = await client.getComponentMeasures("proj-key", ["coverage", "bugs"], "main");
    expect(result).toEqual(mockResponse);

    const url: string = mockFetch.mock.calls[0][0];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/api/measures/component");
    expect(parsedUrl.searchParams.get("component")).toBe("proj-key");
    expect(parsedUrl.searchParams.get("metricKeys")).toBe("coverage,bugs");
    expect(parsedUrl.searchParams.get("branch")).toBe("main");
  });

  it("listBranches queries project branches", async () => {
    const mockResponse = { branches: [{ name: "main", isMain: true, type: "LONG" }] };
    const mockFetch = createMockFetch({ ok: true, status: 200, body: mockResponse });
    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    const result = await client.listBranches("proj-key");
    expect(result).toEqual(mockResponse);

    const url: string = mockFetch.mock.calls[0][0];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/api/project_branches/list");
    expect(parsedUrl.searchParams.get("project")).toBe("proj-key");
  });

  it("getComponent queries component info", async () => {
    const mockResponse = { component: { key: "proj-key", name: "Proj", qualifier: "TRK", measures: [] } };
    const mockFetch = createMockFetch({ ok: true, status: 200, body: mockResponse });
    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    const result = await client.getComponent("proj-key", "main");
    expect(result).toEqual(mockResponse);

    const url: string = mockFetch.mock.calls[0][0];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/api/components/show");
    expect(parsedUrl.searchParams.get("component")).toBe("proj-key");
    expect(parsedUrl.searchParams.get("branch")).toBe("main");
  });

  it("throws clear error on non-ok API responses", async () => {
    const mockFetch = createMockFetch({ ok: false, status: 400, text: "Bad things happened" });
    const client = new SonarClient("https://sonar.example.com", "token", mockFetch as any);

    await expect(client.getQualityGate("proj-key")).rejects.toThrow(
      "SonarQube API error 400 Error on api/qualitygates/project_status: Bad things happened",
    );
  });
});
