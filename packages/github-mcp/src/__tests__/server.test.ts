import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createGitHubServer } from "../server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function startServer(env: Record<string, string> = {}) {
  env = { GITHUB_REPOSITORY_ALLOWLIST: "org/*,bcgov/*", ...env };
  // Set required env vars before server creation
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }

  const server = createGitHubServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);

  async function teardown() {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }

  return { client, teardown };
}

/** Wrapper that uses the SDK's expected `{ name, arguments }` shape. */
async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  return client.callTool({ name, arguments: args });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

describe("createGitHubServer tool registration", () => {
  it("registers all expected tools", async () => {
    const env = {
      GITHUB_TOKEN: "test-tok",
      GITHUB_ENABLE_AUTOFIX: "true",
      GITHUB_ENABLE_MERGE: "true",
    };
    const { client, teardown } = await startServer(env);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);

      // Foundation
      expect(names).toContain("github_health");
      expect(names).toContain("github_config");

      // Code scanning
      expect(names).toContain("security_publish_sarif");
      expect(names).toContain("security_get_sarif_upload_status");
      expect(names).toContain("security_list_code_scanning_alerts");
      expect(names).toContain("security_get_code_scanning_alert");
      expect(names).toContain("security_get_code_scanning_alert_instances");
      expect(names).toContain("security_update_code_scanning_alert");

      // Autofix
      expect(names).toContain("security_create_code_scanning_autofix");
      expect(names).toContain("security_get_code_scanning_autofix_status");
      expect(names).toContain("security_commit_code_scanning_autofix");

      // Secret scanning
      expect(names).toContain("security_list_secret_scanning_alerts");
      expect(names).toContain("security_get_secret_scanning_alert");
      expect(names).toContain("security_update_secret_scanning_alert");

      // Dependabot
      expect(names).toContain("security_list_dependabot_alerts");
      expect(names).toContain("security_get_dependabot_alert");
      expect(names).toContain("security_update_dependabot_alert");

      // Issues
      expect(names).toContain("issue_create");
      expect(names).toContain("issue_update");
      expect(names).toContain("issue_close");
      expect(names).toContain("issue_search");
      expect(names).toContain("issue_add_comment");

      // Pull Requests
      expect(names).toContain("pr_create");
      expect(names).toContain("pr_get");
      expect(names).toContain("pr_update");
      expect(names).toContain("pr_request_review");
      expect(names).toContain("pr_comment");
      expect(names).toContain("pr_merge");

      // Repository security
      expect(names).toContain("repo_get_security_configuration");
      expect(names).toContain("repo_get_rulesets");
      expect(names).toContain("repo_get_security_summary");

      // Org security
      expect(names).toContain("org_list_security_alerts");
      expect(names).toContain("org_security_summary");
      expect(names).toContain("org_find_repositories_missing_security_controls");
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// readOnlyHint annotations
// ---------------------------------------------------------------------------

describe("readOnlyHint annotations", () => {
  it("marks read tools as readOnlyHint: true", async () => {
    const { client, teardown } = await startServer({ GITHUB_TOKEN: "tok" });
    try {
      const { tools } = await client.listTools();
      const readTools = [
        "github_health",
        "github_config",
        "security_get_sarif_upload_status",
        "security_list_code_scanning_alerts",
        "security_get_code_scanning_alert",
        "security_get_code_scanning_alert_instances",
        "security_get_code_scanning_autofix_status",
        "security_list_secret_scanning_alerts",
        "security_get_secret_scanning_alert",
        "security_list_dependabot_alerts",
        "security_get_dependabot_alert",
        "issue_search",
        "pr_get",
        "repo_get_security_configuration",
        "repo_get_rulesets",
        "repo_get_security_summary",
        "org_list_security_alerts",
        "org_security_summary",
        "org_find_repositories_missing_security_controls",
      ];
      for (const name of readTools) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, `Tool "${name}" not found`).toBeDefined();
        expect(
          (tool?.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint,
          `Tool "${name}" should have readOnlyHint: true`,
        ).toBe(true);
      }
    } finally {
      await teardown();
    }
  });

  it("marks write tools as readOnlyHint: false", async () => {
    const { client, teardown } = await startServer({ GITHUB_TOKEN: "tok" });
    try {
      const { tools } = await client.listTools();
      const writeTools = [
        "security_publish_sarif",
        "security_update_code_scanning_alert",
        "security_create_code_scanning_autofix",
        "security_commit_code_scanning_autofix",
        "security_update_secret_scanning_alert",
        "security_update_dependabot_alert",
        "issue_create",
        "issue_update",
        "issue_close",
        "issue_add_comment",
        "pr_create",
        "pr_update",
        "pr_request_review",
        "pr_comment",
        "pr_merge",
      ];
      for (const name of writeTools) {
        const tool = tools.find((t) => t.name === name);
        expect(tool, `Tool "${name}" not found`).toBeDefined();
        expect(
          (tool?.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint,
          `Tool "${name}" should have readOnlyHint: false`,
        ).toBe(false);
      }
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// Confirmation gate
// ---------------------------------------------------------------------------

describe("confirmation gate", () => {
  it("returns isError when confirm is not provided to issue_create", async () => {
    const { client, teardown } = await startServer({ GITHUB_TOKEN: "tok" });
    try {
      const result = await callTool(client, "issue_create", {
        owner: "org",
        repo: "repo",
        title: "Test issue",
        // confirm defaults to false
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(result.isError).toBe(true);
      expect(content[0]?.text).toMatch(/confirm=true/i);
    } finally {
      await teardown();
    }
  });

  it("returns isError when confirm=false for security_publish_sarif", async () => {
    const { client, teardown } = await startServer({ GITHUB_TOKEN: "tok" });
    try {
      const result = await callTool(client, "security_publish_sarif", {
        owner: "org",
        repo: "repo",
        commit_sha: "abc123",
        ref: "refs/heads/main",
        findings: [
          {
            finding_id: "f1",
            rule_id: "RULE-001",
            title: "Test",
            description: "Test finding",
            severity: "high",
            file: "src/foo.ts",
            start_line: 1,
          },
        ],
        confirm: false,
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toMatch(/confirm=true/i);
    } finally {
      await teardown();
    }
  });

  it("returns isError when confirm=false for pr_merge", async () => {
    const { client, teardown } = await startServer({
      GITHUB_TOKEN: "tok",
      GITHUB_ENABLE_MERGE: "true",
    });
    try {
      const result = await callTool(client, "pr_merge", {
        owner: "org",
        repo: "repo",
        pull_number: 1,
        confirm: false,
      });
      expect(result.isError).toBe(true);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// Autofix feature gate
// ---------------------------------------------------------------------------

describe("autofix feature gate", () => {
  it("returns isError for security_create_code_scanning_autofix when not enabled", async () => {
    const savedAutofix = process.env.GITHUB_ENABLE_AUTOFIX;
    delete process.env.GITHUB_ENABLE_AUTOFIX;
    const { client, teardown } = await startServer({ GITHUB_TOKEN: "tok" });
    try {
      const result = await callTool(client, "security_create_code_scanning_autofix", {
        owner: "org",
        repo: "repo",
        alert_number: 1,
        confirm: true,
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toMatch(/GITHUB_ENABLE_AUTOFIX/);
    } finally {
      await teardown();
      if (savedAutofix !== undefined) {
        process.env.GITHUB_ENABLE_AUTOFIX = savedAutofix;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// PR merge feature gate
// ---------------------------------------------------------------------------

describe("PR merge feature gate", () => {
  it("returns isError for pr_merge when GITHUB_ENABLE_MERGE is not set", async () => {
    const savedMerge = process.env.GITHUB_ENABLE_MERGE;
    delete process.env.GITHUB_ENABLE_MERGE;
    const { client, teardown } = await startServer({ GITHUB_TOKEN: "tok" });
    try {
      const result = await callTool(client, "pr_merge", {
        owner: "org",
        repo: "repo",
        pull_number: 1,
        confirm: true,
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toMatch(/GITHUB_ENABLE_MERGE/);
    } finally {
      await teardown();
      if (savedMerge !== undefined) {
        process.env.GITHUB_ENABLE_MERGE = savedMerge;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// github_config tool (pure config â€” no network)
// ---------------------------------------------------------------------------

describe("github_config tool", () => {
  it("returns configuration without crashing when GITHUB_TOKEN is missing", async () => {
    const savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const { client, teardown } = await startServer({});
    try {
      const result = await callTool(client, "github_config", {});
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toMatch(/GitHub MCP Configuration/);
      expect(content[0]?.text).toMatch(/Token configured: false/);
    } finally {
      await teardown();
      if (savedToken !== undefined) {
        process.env.GITHUB_TOKEN = savedToken;
      }
    }
  });

  it("shows allow-list when configured", async () => {
    const { client, teardown } = await startServer({
      GITHUB_TOKEN: "tok",
      GITHUB_REPOSITORY_ALLOWLIST: "bcgov/*",
    });
    try {
      const result = await callTool(client, "github_config", {});
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toMatch(/bcgov\/\*/);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("input validation", () => {
  it("returns isError for security_list_code_scanning_alerts with invalid owner", async () => {
    const { client, teardown } = await startServer({ GITHUB_TOKEN: "tok" });
    try {
      const result = await callTool(client, "security_list_code_scanning_alerts", {
        owner: "bad/owner",
        repo: "repo",
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toMatch(/Invalid owner/);
    } finally {
      await teardown();
    }
  });

  it("returns isError when GITHUB_TOKEN is not set for pr_get", async () => {
    const savedToken = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const { client, teardown } = await startServer({});
    try {
      const result = await callTool(client, "pr_get", {
        owner: "org",
        repo: "repo",
        pull_number: 1,
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toMatch(/GITHUB_TOKEN/);
    } finally {
      await teardown();
      if (savedToken !== undefined) {
        process.env.GITHUB_TOKEN = savedToken;
      }
    }
  });

  it("returns isError when owner/repo is not in allow-list", async () => {
    const { client, teardown } = await startServer({
      GITHUB_TOKEN: "tok",
      GITHUB_REPOSITORY_ALLOWLIST: "bcgov/allowed-repo",
    });
    try {
      const result = await callTool(client, "security_list_code_scanning_alerts", {
        owner: "bcgov",
        repo: "not-allowed",
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(content[0]?.text).toMatch(/GITHUB_REPOSITORY_ALLOWLIST/);
    } finally {
      await teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// PI scrubbing on success-path outputs
// ---------------------------------------------------------------------------

describe("PI scrubbing of tool outputs", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("scrubs emails from success-path output when RAVEN_SCRUB_PI is enabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            total_count: 1,
            items: [
              {
                number: 7,
                title: "Login broken — contact jane.doe@gov.bc.ca for repro",
                state: "open",
                html_url: "https://github.com/bcgov/allowed-repo/issues/7",
                created_at: "2026-08-01T00:00:00Z",
                labels: [],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const { client, teardown } = await startServer({
      GITHUB_TOKEN: "scrub-test-token", // unique — forces a fresh client that sees the stubbed fetch
      GITHUB_REPOSITORY_ALLOWLIST: "bcgov/allowed-repo",
      RAVEN_SCRUB_PI: "true",
    });
    try {
      const result = await callTool(client, "issue_search", {
        owner: "bcgov",
        repo: "allowed-repo",
        query: "login",
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text?: string }>;
      const text = content.map((c) => c.text ?? "").join("\n");
      expect(text).toContain("#7");
      expect(text).not.toContain("jane.doe@gov.bc.ca");
      expect(text).toMatch(/\[EMAIL\]|\[REDACTED\]|\[email\]/i);
    } finally {
      await teardown();
    }
  });
});
