import { describe, it, expect, vi } from "vitest";
import { RfcBuddyClient } from "../rfcbuddy-client.js";

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

describe("RfcBuddyClient constructor", () => {
  it("strips trailing slashes from baseUrl and appends /api/v1 internally", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { totalMatched: 0, rfcs: [] } });
    const client = new RfcBuddyClient("https://rfcbuddy.example.com///", "pat123", mockFetch as any);

    await client.searchRfcs(["test"]);

    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toBe("https://rfcbuddy.example.com/api/v1/rfcs/search");
  });

  it("handles legacy base URL containing /api/v1 without duplicating it", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { totalMatched: 0, rfcs: [] } });
    const client = new RfcBuddyClient("https://rfcbuddy.example.com/api/v1/", "pat123", mockFetch as any);

    await client.searchRfcs(["test"]);

    const url: string = mockFetch.mock.calls[0][0];
    expect(url).toBe("https://rfcbuddy.example.com/api/v1/rfcs/search");
  });

  it("sends Bearer token and JSON headers", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: { totalMatched: 0, rfcs: [] } });
    const client = new RfcBuddyClient("https://rfcbuddy.example.com", "my-secret-pat", mockFetch as any);

    await client.searchRfcs(["test"], ["ignore"]);
    const opts = mockFetch.mock.calls[0][1];
    expect(opts.headers.Authorization).toBe("Bearer my-secret-pat");
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });
});

describe("RfcBuddyClient searchRfcs", () => {
  it("sends correct POST body and parses results", async () => {
    const mockResponse = {
      generatedAtUtc: "2026-07-03T12:00:00Z",
      totalMatched: 1,
      rfcs: [
        {
          rfcNumber: "RFC-5555",
          approvalStatus: "Approved",
          platform: "Emerald",
          assetTags: "payments",
          startDateUtc: "2026-07-03T10:00:00Z",
          endDateUtc: "2026-07-04T10:00:00Z",
          description: "Deploy payment gateway to prod",
          riskAssessment: "Low",
          changeStatus: "New",
        },
      ],
    };

    const mockFetch = createMockFetch({ ok: true, status: 200, body: mockResponse });
    const client = new RfcBuddyClient("https://rfcbuddy.example.com", "pat123", mockFetch as any);

    const result = await client.searchRfcs(["payments"], ["sandbox"]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const bodyOption = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(bodyOption.includeKeywords).toEqual(["payments"]);
    expect(bodyOption.ignoreKeywords).toEqual(["sandbox"]);

    expect(result.totalMatched).toBe(1);
    expect(result.rfcs[0].rfcNumber).toBe("RFC-5555");
  });

  it("throws clear error on failure response", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: "Invalid token info",
    });
    const client = new RfcBuddyClient("https://rfcbuddy.example.com", "bad-pat", mockFetch as any);

    await expect(client.searchRfcs(["test"])).rejects.toThrow(
      "RFC Buddy API unexpected response: 401 Unauthorized on POST /rfcs/search: Invalid token info",
    );
  });
});
