import { describe, it, expect, vi } from "vitest";
import { JiraClient } from "../jira-client.js";

const BASE_URL = "https://jira.example.com";

/** Mock fetch that replays a sequence of responses, one per call. */
function createSequenceFetch(
  responses: Array<{ ok: boolean; status: number; body?: unknown; text?: string }>
) {
  const fn = vi.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.ok,
      status: r.status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(r.text ?? ""),
    });
  }
  return fn;
}

describe("getCreateMeta", () => {
  const issueTypesPage = {
    values: [
      { id: "10200", name: "RFC" },
      { id: "10201", name: "RFD" },
    ],
  };
  const fieldsPage = {
    values: [
      {
        fieldId: "summary",
        name: "Summary",
        required: true,
        schema: { type: "string", system: "summary" },
      },
      {
        fieldId: "customfield_11702",
        name: "Target environment",
        required: true,
        schema: { type: "option", custom: "select", customId: 11702 },
        allowedValues: [{ id: "1", value: "PROD" }],
      },
    ],
  };

  it("resolves the issue type by name and returns normalized field metadata", async () => {
    const mockFetch = createSequenceFetch([
      { ok: true, status: 200, body: issueTypesPage },
      { ok: true, status: 200, body: fieldsPage },
    ]);
    const client = new JiraClient(mockFetch, BASE_URL);

    const meta = await client.getCreateMeta("ARTS", "rfd");

    expect(mockFetch.mock.calls[0][0]).toBe(
      `${BASE_URL}/rest/api/2/issue/createmeta/ARTS/issuetypes?maxResults=100`
    );
    expect(mockFetch.mock.calls[1][0]).toBe(
      `${BASE_URL}/rest/api/2/issue/createmeta/ARTS/issuetypes/10201?maxResults=200`
    );
    expect(meta).toEqual([
      {
        fieldId: "summary",
        name: "Summary",
        required: true,
        schema: { type: "string" },
        allowedValues: undefined,
      },
      {
        fieldId: "customfield_11702",
        name: "Target environment",
        required: true,
        schema: { type: "option", items: undefined, custom: "select" },
        allowedValues: [{ id: "1", value: "PROD" }],
      },
    ]);
  });

  it("throws with available type names when the issue type is missing", async () => {
    const mockFetch = createSequenceFetch([
      { ok: true, status: 200, body: issueTypesPage },
    ]);
    const client = new JiraClient(mockFetch, BASE_URL);

    await expect(client.getCreateMeta("ARTS", "Bug")).rejects.toThrow(
      /Issue type "Bug" not found.*RFC, RFD/
    );
  });

  it("throws on a non-ok response", async () => {
    const mockFetch = createSequenceFetch([
      { ok: false, status: 404, text: "project not found" },
    ]);
    const client = new JiraClient(mockFetch, BASE_URL);

    await expect(client.getCreateMeta("NOPE", "RFC")).rejects.toThrow(
      "Failed to get create metadata (404)"
    );
  });
});

describe("getEditMeta", () => {
  it("normalizes the editmeta fields record into a field list", async () => {
    const mockFetch = createSequenceFetch([
      {
        ok: true,
        status: 200,
        body: {
          fields: {
            customfield_10637: {
              name: "Change Coordinator",
              required: true,
              schema: { type: "user", custom: "userpicker" },
            },
          },
        },
      },
    ]);
    const client = new JiraClient(mockFetch, BASE_URL);

    const meta = await client.getEditMeta("ARTS-537");

    expect(mockFetch.mock.calls[0][0]).toBe(
      `${BASE_URL}/rest/api/2/issue/ARTS-537/editmeta`
    );
    expect(meta).toEqual([
      {
        fieldId: "customfield_10637",
        name: "Change Coordinator",
        required: true,
        schema: { type: "user", items: undefined, custom: "userpicker" },
        allowedValues: undefined,
      },
    ]);
  });

  it("throws on a non-ok response", async () => {
    const mockFetch = createSequenceFetch([
      { ok: false, status: 404, text: "issue not found" },
    ]);
    const client = new JiraClient(mockFetch, BASE_URL);

    await expect(client.getEditMeta("NOPE-1")).rejects.toThrow(
      "Failed to get edit metadata (404)"
    );
  });
});
