import { describe, it, expect, beforeAll } from "vitest";
import { SessionManager, createAuthenticatedFetch, createBasicAuthFetch, loadEnv } from "@nrs/auth";
import { ConfluenceClient } from "../confluence-client.js";
import { markdownToHtml } from "../markdown-to-html.js";

loadEnv();

const PARENT_PAGE_ID = "123456789"; // DEMO space "AI" page
const SPACE_KEY = "DEMO";
const TEST_TITLE_PREFIX = "[AUTOTEST]";

const runIntegration = process.env["INTEGRATION_TEST"] === "1";

(runIntegration ? describe : describe.skip)("Confluence write integration", () => {
  let client: ConfluenceClient;

  beforeAll(async () => {
    const email = process.env["ATLASSIAN_EMAIL"];
    const password = process.env["ATLASSIAN_PASSWORD"];
    const baseUrl = process.env["ATLASSIAN_BASE_URL"];

    if (email && password && baseUrl) {
      const authFetch = createBasicAuthFetch(email, password);
      client = new ConfluenceClient(authFetch, `${baseUrl}/int/confluence`);
    } else {
      const sessionManager = new SessionManager();
      const authFetch = await createAuthenticatedFetch(sessionManager);
      client = new ConfluenceClient(authFetch);
    }
  });

  it("creates, reads, updates, reads, then deletes a test page", async () => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const createTitle = `${TEST_TITLE_PREFIX} Create Test ${timestamp}`;
    const createBody = markdownToHtml(
      `# Test Page\n\nCreated by automated integration test at ${timestamp}.`
    );

    // 1. Create
    const created = await client.createPage(SPACE_KEY, createTitle, createBody, PARENT_PAGE_ID);
    expect(created.id).toBeTruthy();
    expect(created.title).toBe(createTitle);
    expect(created.version.number).toBe(1);

    const pageId = created.id;

    // 2. Read back
    const readBack = await client.getPage(pageId);
    expect(readBack.title).toBe(createTitle);
    expect(readBack.body?.storage?.value).toContain("Test Page");
    expect(readBack.version?.number).toBe(1);

    // 3. Update
    const updateTitle = `${TEST_TITLE_PREFIX} Updated Test ${timestamp}`;
    const updateBody = markdownToHtml(
      `# Updated Page\n\nUpdated by integration test at ${new Date().toISOString()}.`
    );
    const updated = await client.updatePage(pageId, updateTitle, updateBody, 2);
    expect(updated.title).toBe(updateTitle);
    expect(updated.version.number).toBe(2);

    // 4. Read updated
    const readUpdated = await client.getPage(pageId);
    expect(readUpdated.title).toBe(updateTitle);
    expect(readUpdated.body?.storage?.value).toContain("Updated Page");
    expect(readUpdated.version?.number).toBe(2);

    // Note: test pages are left under DEMO > AI for manual cleanup
  }, 30_000);
});
