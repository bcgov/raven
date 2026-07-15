import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraClient } from "../jira-client.js";

/** Create a mock fetch that returns a configurable response. */
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

describe("JiraClient write methods", () => {
  const BASE_URL = "https://jira.example.com";

  // ---- createIssue ----

  describe("createIssue", () => {
    it("sends POST with correct URL and body, returns key", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: { id: "10001", key: "RRS-100", self: `${BASE_URL}/rest/api/2/issue/10001` },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      const result = await client.createIssue({
        project: { key: "RRS" },
        summary: "Test issue",
        issuetype: { name: "Bug" },
      });

      expect(result.key).toBe("RRS-100");
      expect(result.id).toBe("10001");
      expect(mockFetch).toHaveBeenCalledOnce();

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue`);
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(opts.body);
      expect(body.fields.project.key).toBe("RRS");
      expect(body.fields.summary).toBe("Test issue");
    });

    it("throws on 400 response", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 400,
        text: "Missing required field: summary",
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.createIssue({ project: { key: "RRS" } })).rejects.toThrow(
        "Failed to create issue (400)"
      );
    });
  });

  // ---- updateIssue ----

  describe("updateIssue", () => {
    it("sends PUT with correct URL and body", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.updateIssue("RRS-100", { summary: "Updated summary" });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100`);
      expect(opts.method).toBe("PUT");
      const body = JSON.parse(opts.body);
      expect(body.fields.summary).toBe("Updated summary");
    });

    it("throws on 404 response", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 404,
        text: "Issue Does Not Exist",
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.updateIssue("NOPE-999", { summary: "x" })).rejects.toThrow(
        "Failed to update issue NOPE-999 (404)"
      );
    });
  });

  // ---- addComment ----

  describe("addComment", () => {
    it("sends POST with correct URL and body, returns comment", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: {
          id: "55555",
          author: { displayName: "Test User" },
          body: "Hello world",
          created: "2026-02-21T00:00:00.000+0000",
          updated: "2026-02-21T00:00:00.000+0000",
        },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      const comment = await client.addComment("RRS-100", "Hello world");

      expect(comment.id).toBe("55555");
      expect(comment.body).toBe("Hello world");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100/comment`);
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.body).toBe("Hello world");
    });

    it("throws on 401 response", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 401,
        text: "Unauthorized",
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.addComment("RRS-100", "test")).rejects.toThrow(
        "Failed to add comment to RRS-100 (401)"
      );
    });
  });

  // ---- getTransitions ----

  describe("getTransitions", () => {
    it("sends GET and returns transitions array", async () => {
      const transitions = [
        { id: "11", name: "In Progress", to: { name: "In Progress" } },
        { id: "21", name: "Done", to: { name: "Done" } },
      ];
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { transitions },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      const result = await client.getTransitions("RRS-100");

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("In Progress");
      expect(result[1].id).toBe("21");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100/transitions`);
      expect(opts).toBeUndefined(); // GET has no options
    });

    it("throws on 404 response", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 404,
        text: "Issue Does Not Exist",
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.getTransitions("NOPE-1")).rejects.toThrow(
        "Failed to get transitions for NOPE-1 (404)"
      );
    });
  });

  // ---- transitionIssue ----

  describe("transitionIssue", () => {
    it("sends POST with correct URL and transition body", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.transitionIssue("RRS-100", "11");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100/transitions`);
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.transition.id).toBe("11");
    });

    it("throws on 400 response", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 400,
        text: "Invalid transition",
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.transitionIssue("RRS-100", "999")).rejects.toThrow(
        "Failed to transition issue RRS-100 (400)"
      );
    });
  });

  // ---- getIssueLinkTypes ----

  describe("getIssueLinkTypes", () => {
    it("sends GET and returns link types array", async () => {
      const linkTypes = [
        { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
        { id: "10001", name: "Relates", inward: "relates to", outward: "relates to" },
      ];
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { issueLinkTypes: linkTypes },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      const result = await client.getIssueLinkTypes();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("Blocks");
      expect(result[0].outward).toBe("blocks");
      expect(result[1].inward).toBe("relates to");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issueLinkType`);
      expect(opts).toBeUndefined(); // GET has no options
    });

    it("throws on non-ok response", async () => {
      const mockFetch = createMockFetch({ ok: false, status: 403, text: "Forbidden" });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.getIssueLinkTypes()).rejects.toThrow(
        "Failed to fetch link types (403)"
      );
    });
  });

  // ---- linkIssues ----

  describe("linkIssues", () => {
    // NOTE: The assertions below intentionally look "swapped" relative to the
    // function arguments. NRM Jira's POST /rest/api/2/issueLink treats the JSON
    // `outwardIssue` field as the *target* of the link (the side that ends up
    // displaying the inward description, e.g. "is blocked by") and JSON
    // `inwardIssue` as the *source*. linkIssues compensates by reversing the
    // assignment so callers can keep thinking in the natural direction
    // (outwardIssueKey is the issue performing the action).
    //
    // For linkIssues("Blocks", "A", "B") meaning "A blocks B":
    //   - body.outwardIssue.key === "B" (the target — the side showing "is blocked by")
    //   - body.inwardIssue.key  === "A" (the source — the side showing "blocks")

    it("sends POST to /issueLink, swapping outward/inward to compensate for NRM Jira semantics", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 201 });
      const client = new JiraClient(mockFetch, BASE_URL);

      // Caller intent: AS-4056 blocks AS-4058
      await client.linkIssues("Blocks", "AS-4056", "AS-4058");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issueLink`);
      expect(opts.method).toBe("POST");
      expect(opts.headers["Content-Type"]).toBe("application/json");
      const body = JSON.parse(opts.body);
      expect(body.type.name).toBe("Blocks");
      // Verify the deliberate swap: outwardIssueKey ("AS-4056") goes into JSON inwardIssue
      expect(body.outwardIssue.key).toBe("AS-4058");
      expect(body.inwardIssue.key).toBe("AS-4056");
      expect(body.comment).toBeUndefined();
    });

    it("includes comment when provided (and still applies the swap)", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 201 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.linkIssues("Blocks", "AS-4056", "AS-4058", "Retirement sequencing dependency.");

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.outwardIssue.key).toBe("AS-4058");
      expect(body.inwardIssue.key).toBe("AS-4056");
      expect(body.comment).toEqual({ body: "Retirement sequencing dependency." });
    });

    it("throws on non-ok response", async () => {
      const mockFetch = createMockFetch({
        ok: false,
        status: 400,
        text: "Invalid link type",
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(
        client.linkIssues("Bogus", "AS-4056", "AS-4058")
      ).rejects.toThrow("Failed to link AS-4056 → AS-4058 (400)");
    });
  });

  // ---- URL encoding ----

  describe("URL encoding", () => {
    it("encodes special characters in issue keys", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.updateIssue("TEST-1/2", { summary: "test" });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("TEST-1%2F2");
    });
  });

  // ---- Worklogs ----

  describe("getWorklogs", () => {
    it("GETs the worklog endpoint with default paging params", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { worklogs: [], total: 0, startAt: 0, maxResults: 100 },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.getWorklogs("RRS-100");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain(`${BASE_URL}/rest/api/2/issue/RRS-100/worklog?`);
      expect(url).toContain("maxResults=100");
      expect(url).toContain("startAt=0");
    });

    it("threads custom maxResults + startAt", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { worklogs: [], total: 0, startAt: 0, maxResults: 0 },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.getWorklogs("RRS-100", 50, 100);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("maxResults=50");
      expect(url).toContain("startAt=100");
    });
  });

  describe("addWorklog", () => {
    it("POSTs timeSpent with optional comment + started", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 201, body: { id: "10" } });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.addWorklog("RRS-100", "2h 30m", {
        comment: "Pairing",
        started: "2026-05-09T09:00:00.000+0000",
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100/worklog`);
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.timeSpent).toBe("2h 30m");
      expect(body.comment).toBe("Pairing");
      expect(body.started).toBe("2026-05-09T09:00:00.000+0000");
    });

    it("omits comment/started when not provided", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 201, body: { id: "11" } });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.addWorklog("RRS-100", "30m");

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body).toEqual({ timeSpent: "30m" });
    });
  });

  // ---- Attachments ----

  describe("listAttachments", () => {
    it("requests only the attachment field and returns the array", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { fields: { attachment: [{ id: "1", filename: "a.png" }] } },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      const result = await client.listAttachments("RRS-100");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/2/issue/RRS-100");
      expect(url).toContain("fields=attachment");
      expect(result).toHaveLength(1);
      expect(result[0]!.filename).toBe("a.png");
    });

    it("returns empty array when no attachments", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { fields: {} },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      const result = await client.listAttachments("RRS-100");
      expect(result).toEqual([]);
    });
  });

  // ---- User search ----

  describe("searchUsers", () => {
    it("uses 'username' query param (DC convention) and respects maxResults", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 200, body: [] });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.searchUsers("smith", 10);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/2/user/search?");
      expect(url).toContain("username=smith");
      expect(url).toContain("maxResults=10");
    });
  });

  describe("searchAssignableUsers", () => {
    it("includes project + username + maxResults", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 200, body: [] });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.searchAssignableUsers("RRS", "smith", 25);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/api/2/user/assignable/search?");
      expect(url).toContain("project=RRS");
      expect(url).toContain("username=smith");
    });
  });

  // ---- Pagination ----

  describe("searchIssues startAt", () => {
    it("threads startAt into the query string", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { issues: [], total: 0, startAt: 0, maxResults: 0 },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.searchIssues("project = RRS", 50, 100);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("startAt=100");
      expect(url).toContain("maxResults=50");
    });
  });

  describe("getSprintIssues startAt", () => {
    it("threads startAt into the agile query", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { issues: [], total: 0, startAt: 0, maxResults: 0 },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.getSprintIssues(123, 50, 75);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain("/rest/agile/1.0/sprint/123/issue?");
      expect(url).toContain("startAt=75");
    });
  });

  // ---- Project versions ----

  describe("listProjectVersions", () => {
    it("GETs the project/versions endpoint", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 200, body: [] });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.listProjectVersions("RRS");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/project/RRS/versions`);
    });
  });

  describe("createVersion", () => {
    it("POSTs project + name with optional fields", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: { id: "10001", name: "v3.2", archived: false, released: false },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.createVersion("RRS", "v3.2", {
        description: "Q2 release",
        startDate: "2026-05-01",
        releaseDate: "2026-06-30",
        released: false,
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/version`);
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({
        project: "RRS",
        name: "v3.2",
        description: "Q2 release",
        startDate: "2026-05-01",
        releaseDate: "2026-06-30",
        released: false,
      });
    });
  });

  describe("getVersion", () => {
    it("GETs the single-version endpoint with URL-encoded ID", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: "10001", name: "v3.2", archived: false, released: false },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.getVersion("10001");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/version/10001`);
    });

    it("throws on 404", async () => {
      const mockFetch = createMockFetch({ ok: false, status: 404, text: "Not found" });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.getVersion("99999")).rejects.toThrow("Failed to fetch version 99999 (404)");
    });
  });

  describe("updateVersion", () => {
    it("PUTs the partial update body", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: "10001", name: "v3.2", archived: false, released: true },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.updateVersion("10001", { released: true, releaseDate: "2026-06-30" });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/version/10001`);
      expect(opts.method).toBe("PUT");
      expect(JSON.parse(opts.body)).toEqual({ released: true, releaseDate: "2026-06-30" });
    });

    it("throws on 400", async () => {
      const mockFetch = createMockFetch({ ok: false, status: 400, text: "Invalid" });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.updateVersion("10001", { name: "x" })).rejects.toThrow(
        "Failed to update version 10001 (400)"
      );
    });
  });

  describe("deleteVersion", () => {
    it("includes moveFixIssuesTo + moveAffectedIssuesTo as query params", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.deleteVersion("10001", {
        moveFixIssuesTo: "10002",
        moveAffectedIssuesTo: "10003",
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain(`${BASE_URL}/rest/api/2/version/10001?`);
      expect(url).toContain("moveFixIssuesTo=10002");
      expect(url).toContain("moveAffectedIssuesTo=10003");
      expect(opts.method).toBe("DELETE");
    });

    it("omits query string when no move params provided", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.deleteVersion("10001");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/version/10001`);
    });
  });

  // ---- Watchers ----

  describe("getWatchers", () => {
    it("GETs the watchers endpoint", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { isWatching: true, watchCount: 2, watchers: [] },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      const result = await client.getWatchers("RRS-100");

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100/watchers`);
      expect(result.isWatching).toBe(true);
      expect(result.watchCount).toBe(2);
    });

    it("throws on 404", async () => {
      const mockFetch = createMockFetch({ ok: false, status: 404, text: "Not found" });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.getWatchers("NOPE-999")).rejects.toThrow(
        "Failed to fetch watchers for NOPE-999 (404)"
      );
    });
  });

  describe("addWatcher", () => {
    it("POSTs the username as a bare JSON string (DC quirk)", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.addWatcher("RRS-100", "jsmith");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100/watchers`);
      expect(opts.method).toBe("POST");
      // Body must be a JSON-encoded STRING, not an object — Jira DC rejects {username:"x"}.
      expect(opts.body).toBe('"jsmith"');
    });
  });

  describe("removeWatcher", () => {
    it("DELETEs with username query param", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.removeWatcher("RRS-100", "jsmith");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain(`${BASE_URL}/rest/api/2/issue/RRS-100/watchers?`);
      expect(url).toContain("username=jsmith");
      expect(opts.method).toBe("DELETE");
    });
  });

  // ---- Sprint management ----

  describe("createSprint", () => {
    it("POSTs name + originBoardId with optional dates/goal", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 201,
        body: { id: 42, name: "Sprint 1", state: "future" },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.createSprint(7, "Sprint 1", { goal: "ship it" });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/agile/1.0/sprint`);
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body).toEqual({ name: "Sprint 1", originBoardId: 7, goal: "ship it" });
    });
  });

  describe("updateSprint", () => {
    it("uses POST (Agile API quirk) with partial body", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: 42, name: "Sprint 1", state: "active" },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.updateSprint(42, {
        state: "active",
        startDate: "2026-05-09T09:00:00.000Z",
        endDate: "2026-05-23T17:00:00.000Z",
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/agile/1.0/sprint/42`);
      expect(opts.method).toBe("POST"); // not PUT
      const body = JSON.parse(opts.body);
      expect(body.state).toBe("active");
      expect(body.startDate).toBeDefined();
      expect(body.endDate).toBeDefined();
    });
  });

  describe("deleteSprint", () => {
    it("DELETEs the sprint endpoint", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.deleteSprint(42);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/agile/1.0/sprint/42`);
      expect(opts.method).toBe("DELETE");
    });

    it("throws on 404", async () => {
      const mockFetch = createMockFetch({ ok: false, status: 404, text: "Not found" });
      const client = new JiraClient(mockFetch, BASE_URL);

      await expect(client.deleteSprint(99999)).rejects.toThrow(
        "Failed to delete sprint 99999 (404)"
      );
    });
  });

  describe("moveIssuesToSprint", () => {
    it("POSTs an `issues` array of keys", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.moveIssuesToSprint(42, ["RRS-1", "RRS-2", "RRS-3"]);

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/agile/1.0/sprint/42/issue`);
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ issues: ["RRS-1", "RRS-2", "RRS-3"] });
    });
  });

  // ---- Comment edit / delete ----

  describe("updateComment", () => {
    it("PUTs to the comment endpoint with new body", async () => {
      const mockFetch = createMockFetch({
        ok: true,
        status: 200,
        body: { id: "9001", body: "updated", author: { displayName: "X" }, created: "", updated: "" },
      });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.updateComment("RRS-100", "9001", "updated body");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100/comment/9001`);
      expect(opts.method).toBe("PUT");
      expect(JSON.parse(opts.body)).toEqual({ body: "updated body" });
    });
  });

  describe("deleteComment", () => {
    it("DELETEs the comment endpoint", async () => {
      const mockFetch = createMockFetch({ ok: true, status: 204 });
      const client = new JiraClient(mockFetch, BASE_URL);

      await client.deleteComment("RRS-100", "9001");

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe(`${BASE_URL}/rest/api/2/issue/RRS-100/comment/9001`);
      expect(opts.method).toBe("DELETE");
    });
  });
});
