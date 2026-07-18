import { describe, it, expect, vi } from "vitest";
import { JiraClient } from "../jira-client.js";

const BASE_URL = "https://jira.example.com";

function createMockFetch(response: {
  ok: boolean;
  status: number;
  body?: unknown;
  text?: string;
}) {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
    text: () => Promise.resolve(response.text ?? ""),
  });
}

describe("listDeploymentSlots", () => {
  it("sends start/end params and returns the results array", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: {
        results: [
          {
            key: "IMBADSLOT-1",
            description: '{"bookedBy":"","timestamp":1,"duration":90}',
            timestampField: "2026-07-29 11:30:00.0",
            reservedBy: null,
          },
        ],
      },
    });
    const client = new JiraClient(mockFetch, BASE_URL);

    const slots = await client.listDeploymentSlots("2026-07-17 00:00", "2026-07-31 23:59");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `${BASE_URL}/rest/deploymentcalendar/1.0/api/slots?start=2026-07-17+00%3A00&end=2026-07-31+23%3A59`
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].key).toBe("IMBADSLOT-1");
  });

  it("returns [] when the response has no results field", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: {} });
    const client = new JiraClient(mockFetch, BASE_URL);
    expect(await client.listDeploymentSlots("a", "b")).toEqual([]);
  });

  it("throws on a non-ok response", async () => {
    const mockFetch = createMockFetch({ ok: false, status: 500, text: "boom" });
    const client = new JiraClient(mockFetch, BASE_URL);
    await expect(client.listDeploymentSlots("a", "b")).rejects.toThrow(
      "Failed to list deployment slots (500)"
    );
  });
});

describe("getDeploymentBooking", () => {
  it("returns the reservation object for a booked issue", async () => {
    const mockFetch = createMockFetch({
      ok: true,
      status: 200,
      body: { bookedDate: "2026-07-21T11:00:00.000-0700" },
    });
    const client = new JiraClient(mockFetch, BASE_URL);

    const booking = await client.getDeploymentBooking("LEXIS-977");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `${BASE_URL}/rest/deploymentcalendar/1.0/api/slotReservation?sourceIssue=LEXIS-977`
    );
    expect(booking).toEqual({ bookedDate: "2026-07-21T11:00:00.000-0700" });
  });

  it("returns null on 404 (no booking)", async () => {
    const mockFetch = createMockFetch({
      ok: false,
      status: 404,
      body: { message: "No slot reservation found for this issue" },
    });
    const client = new JiraClient(mockFetch, BASE_URL);
    expect(await client.getDeploymentBooking("LEXIS-977")).toBeNull();
  });

  it("throws on other errors", async () => {
    const mockFetch = createMockFetch({ ok: false, status: 500, text: "boom" });
    const client = new JiraClient(mockFetch, BASE_URL);
    await expect(client.getDeploymentBooking("LEXIS-977")).rejects.toThrow(
      "Failed to get deployment booking for LEXIS-977 (500)"
    );
  });
});

describe("reserveDeploymentSlot", () => {
  it("POSTs sourceIssue and slotKey to reserveSlot", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: {} });
    const client = new JiraClient(mockFetch, BASE_URL);

    await client.reserveDeploymentSlot("LEXIS-977", "IMBADSLOT-42");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/rest/deploymentcalendar/1.0/api/reserveSlot`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({
      sourceIssue: "LEXIS-977",
      slotKey: "IMBADSLOT-42",
    });
  });

  it("throws on a non-ok response", async () => {
    const mockFetch = createMockFetch({ ok: false, status: 409, text: "slot taken" });
    const client = new JiraClient(mockFetch, BASE_URL);
    await expect(
      client.reserveDeploymentSlot("LEXIS-977", "IMBADSLOT-42")
    ).rejects.toThrow("Failed to reserve slot IMBADSLOT-42 for LEXIS-977 (409)");
  });
});

describe("cancelDeploymentBooking", () => {
  it("POSTs sourceIssue to cancelSlotReservation", async () => {
    const mockFetch = createMockFetch({ ok: true, status: 200, body: {} });
    const client = new JiraClient(mockFetch, BASE_URL);

    await client.cancelDeploymentBooking("LEXIS-977");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(
      `${BASE_URL}/rest/deploymentcalendar/1.0/api/cancelSlotReservation`
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ sourceIssue: "LEXIS-977" });
  });

  it("throws on a non-ok response", async () => {
    const mockFetch = createMockFetch({ ok: false, status: 500, text: "boom" });
    const client = new JiraClient(mockFetch, BASE_URL);
    await expect(client.cancelDeploymentBooking("LEXIS-977")).rejects.toThrow(
      "Failed to cancel deployment booking for LEXIS-977 (500)"
    );
  });
});
