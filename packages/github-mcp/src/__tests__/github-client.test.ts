import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  GitHubClient,
  checkAllowList,
  checkOrgAllowList,
  validateOwnerRepo,
  clampPerPage,
  normalizeApiBaseUrl,
  computeFingerprint,
  findingsToSarif,
  validateSarif,
  encodeSarif,
} from "../github-client.js";
import type { CanonicalFinding } from "../types.js";

// ---------------------------------------------------------------------------
// Mock fetch factory
// ---------------------------------------------------------------------------

function mockFetch(response: {
  ok: boolean;
  status: number;
  statusText?: string;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
}) {
  const headers = new Headers(response.headers ?? {});
  const textContent = response.text ?? JSON.stringify(response.body ?? {});
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    statusText: response.statusText ?? (response.ok ? "OK" : "Error"),
    headers,
    text: () => Promise.resolve(textContent),
    json: () => Promise.resolve(response.body),
  });
}

// ---------------------------------------------------------------------------
// GitHubClient constructor / URL normalisation
// ---------------------------------------------------------------------------

describe("GitHubClient URL normalisation", () => {
  it("strips trailing slashes from apiBase", () => {
    const c = new GitHubClient("https://api.github.com///", "tok");
    expect(c.baseUrl).toBe("https://api.github.com");
  });

  it("strips a single trailing slash", () => {
    const c = new GitHubClient("https://github.example.com/api/v3/", "tok");
    expect(c.baseUrl).toBe("https://github.example.com/api/v3");
  });

  it("preserves a URL with no trailing slash", () => {
    const c = new GitHubClient("https://api.github.com", "tok");
    expect(c.baseUrl).toBe("https://api.github.com");
  });
});

// ---------------------------------------------------------------------------
// Token in Bearer auth header
// ---------------------------------------------------------------------------

describe("GitHubClient authentication", () => {
  it("sends the token as a Bearer header", async () => {
    const fetch = mockFetch({ ok: true, status: 200, body: {} });
    const c = new GitHubClient("https://api.github.com", "my-secret-token", {}, fetch as any);
    await c.getRateLimit();
    const opts: RequestInit = fetch.mock.calls[0][1];
    expect((opts.headers as Record<string, string>)?.["Authorization"]).toBe(
      "Bearer my-secret-token",
    );
  });
});

// ---------------------------------------------------------------------------
// Token redaction in error messages
// ---------------------------------------------------------------------------

describe("GitHubClient token redaction", () => {
  it("does not expose the token in fetch error messages", async () => {
    const token = "ghp_super_secret_1234567890";
    const fetch = vi.fn().mockRejectedValue(new Error(`Auth failed with ${token}`));
    const c = new GitHubClient("https://api.github.com", token, {}, fetch as any);

    await expect(c.getRateLimit()).rejects.toThrow(/\[REDACTED\]/);
    await expect(c.getRateLimit()).rejects.not.toThrow(token);
  });

  it("does not expose the token in HTTP error body", async () => {
    const token = "ghp_another_secret_xyz";
    const fetch = mockFetch({
      ok: false,
      status: 401,
      text: `{"message":"Bad credentials: ${token}"}`,
    });
    const c = new GitHubClient("https://api.github.com", token, {}, fetch as any);

    await expect(c.getRateLimit()).rejects.toThrow(/\[REDACTED\]/);
    await expect(c.getRateLimit()).rejects.not.toThrow(token);
  });
});

// ---------------------------------------------------------------------------
// Rate limit handling
// ---------------------------------------------------------------------------

describe("GitHubClient rate limit handling", () => {
  it("throws a descriptive error when x-ratelimit-remaining is 0", async () => {
    const fetch = mockFetch({
      ok: true,
      status: 200,
      body: {},
      headers: { "x-ratelimit-remaining": "0" },
    });
    const c = new GitHubClient("https://api.github.com", "tok", {}, fetch as any);
    await expect(c.getRateLimit()).rejects.toThrow(/rate limit/i);
  });

  it("throws a descriptive error on 429 status", async () => {
    const fetch = mockFetch({
      ok: false,
      status: 429,
      headers: { "retry-after": "60" },
      text: "Too Many Requests",
    });
    const c = new GitHubClient("https://api.github.com", "tok", {}, fetch as any);
    await expect(c.getRateLimit()).rejects.toThrow(/rate limit/i);
  });
});

// ---------------------------------------------------------------------------
// Allow-list enforcement
// ---------------------------------------------------------------------------

describe("checkAllowList", () => {
  beforeEach(() => {
    delete process.env.GITHUB_REPOSITORY_ALLOWLIST;
  });

  it("requires an allow-list", () => {
    expect(() => checkAllowList("anyorg", "anyrepo")).toThrow(/GITHUB_REPOSITORY_ALLOWLIST/);
  });

  it("rejects an empty allow-list", () => {
    process.env.GITHUB_REPOSITORY_ALLOWLIST = "  ";
    expect(() => checkAllowList("anyorg", "anyrepo")).toThrow(/GITHUB_REPOSITORY_ALLOWLIST/);
  });

  it("allows an exact owner/repo match", () => {
    process.env.GITHUB_REPOSITORY_ALLOWLIST = "bcgov/example-repo";
    expect(() => checkAllowList("bcgov", "example-repo")).not.toThrow();
  });

  it("rejects a repo not in the allow-list", () => {
    process.env.GITHUB_REPOSITORY_ALLOWLIST = "bcgov/example-repo";
    expect(() => checkAllowList("bcgov", "other-repo")).toThrow(/GITHUB_REPOSITORY_ALLOWLIST/);
  });

  it("supports wildcard org/* patterns", () => {
    process.env.GITHUB_REPOSITORY_ALLOWLIST = "bcgov/*";
    expect(() => checkAllowList("bcgov", "any-repo")).not.toThrow();
    expect(() => checkAllowList("otherorg", "any-repo")).toThrow(/GITHUB_REPOSITORY_ALLOWLIST/);
  });

  it("allows multiple entries separated by commas", () => {
    process.env.GITHUB_REPOSITORY_ALLOWLIST = "org-a/repo-1, org-b/*";
    expect(() => checkAllowList("org-a", "repo-1")).not.toThrow();
    expect(() => checkAllowList("org-b", "anything")).not.toThrow();
    expect(() => checkAllowList("org-a", "repo-2")).toThrow(/GITHUB_REPOSITORY_ALLOWLIST/);
  });

  it("is case-insensitive", () => {
    process.env.GITHUB_REPOSITORY_ALLOWLIST = "BCGov/Example-Repo";
    expect(() => checkAllowList("bcgov", "example-repo")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateOwnerRepo
// ---------------------------------------------------------------------------

describe("validateOwnerRepo", () => {
  it("accepts valid owner and repo names", () => {
    expect(() => validateOwnerRepo("bcgov", "my-repo")).not.toThrow();
    expect(() => validateOwnerRepo("My-Org", "repo_123")).not.toThrow();
    expect(() => validateOwnerRepo("org", "repo.name")).not.toThrow();
  });

  describe("GitHub configuration validation", () => {
    it("requires an HTTPS API base without embedded credentials", () => {
      expect(normalizeApiBaseUrl("https://github.example.com/api/v3/")).toBe(
        "https://github.example.com/api/v3",
      );
      expect(() => normalizeApiBaseUrl("http://github.example.com/api/v3")).toThrow(/HTTPS/);
      expect(() => normalizeApiBaseUrl("https://user:pass@github.example.com/api/v3")).toThrow(
        /credentials/,
      );
    });

    it("restricts org operations to matching allow-list entries", () => {
      process.env.GITHUB_REPOSITORY_ALLOWLIST = "bcgov/*,other/specific";
      expect(() => checkOrgAllowList("bcgov")).not.toThrow();
      expect(() => checkOrgAllowList("other")).not.toThrow();
      expect(() => checkOrgAllowList("blocked")).toThrow(/GITHUB_REPOSITORY_ALLOWLIST/);
    });
  });

  it("rejects owner with special characters", () => {
    expect(() => validateOwnerRepo("bad/owner", "repo")).toThrow(/Invalid owner/);
    expect(() => validateOwnerRepo("owner;rm -rf", "repo")).toThrow(/Invalid owner/);
  });

  it("rejects repo with special characters", () => {
    expect(() => validateOwnerRepo("org", "repo;evil")).toThrow(/Invalid repo/);
  });
});

// ---------------------------------------------------------------------------
// clampPerPage
// ---------------------------------------------------------------------------

describe("clampPerPage", () => {
  it("clamps values above 100 to 100", () => {
    expect(clampPerPage(200)).toBe(100);
    expect(clampPerPage(9999)).toBe(100);
  });

  it("clamps values below 1 to 1", () => {
    expect(clampPerPage(0)).toBe(1);
    expect(clampPerPage(-5)).toBe(1);
  });

  it("passes through valid values unchanged", () => {
    expect(clampPerPage(50)).toBe(50);
    expect(clampPerPage(100)).toBe(100);
    expect(clampPerPage(1)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// per_page cap in API calls
// ---------------------------------------------------------------------------

describe("GitHubClient per_page capping", () => {
  it("caps per_page to 100 on listCodeScanningAlerts", async () => {
    const fetch = mockFetch({ ok: true, status: 200, body: [] });
    const c = new GitHubClient("https://api.github.com", "tok", {}, fetch as any);
    await c.listCodeScanningAlerts("org", "repo", { per_page: 999 });
    const url: string = fetch.mock.calls[0][0];
    expect(url).toMatch(/per_page=100/);
  });

  it("caps per_page to 100 on listSecretScanningAlerts", async () => {
    const fetch = mockFetch({ ok: true, status: 200, body: [] });
    const c = new GitHubClient("https://api.github.com", "tok", {}, fetch as any);
    await c.listSecretScanningAlerts("org", "repo", { per_page: 500 });
    const url: string = fetch.mock.calls[0][0];
    expect(url).toMatch(/per_page=100/);
  });
});

// ---------------------------------------------------------------------------
// Secret value redaction
// ---------------------------------------------------------------------------

describe("GitHubClient secret value redaction", () => {
  it("strips the secret field from getSecretScanningAlert responses", async () => {
    const rawBody = {
      number: 1,
      created_at: "2024-01-01T00:00:00Z",
      url: "https://api.github.com/repos/org/repo/secret-scanning/alerts/1",
      html_url: "https://github.com/org/repo/security/secret-scanning/1",
      state: "open",
      secret_type: "github_personal_access_token",
      secret: "ghp_SUPERSECRETVALUE123",
    };
    const fetch = mockFetch({ ok: true, status: 200, body: rawBody });
    const c = new GitHubClient("https://api.github.com", "tok", {}, fetch as any);
    const result = await c.getSecretScanningAlert("org", "repo", 1);

    expect((result as any).secret).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("SUPERSECRETVALUE123");
  });

  it("strips the secret field from listSecretScanningAlerts responses", async () => {
    const rawBody = [
      {
        number: 1,
        created_at: "2024-01-01T00:00:00Z",
        url: "https://api.github.com/repos/org/repo/secret-scanning/alerts/1",
        html_url: "https://github.com/org/repo/security/secret-scanning/1",
        state: "open",
        secret_type: "aws_access_key_id",
        secret: "AKIAIOSFODNN7EXAMPLE",
      },
    ];
    const fetch = mockFetch({ ok: true, status: 200, body: rawBody });
    const c = new GitHubClient("https://api.github.com", "tok", {}, fetch as any);
    const results = await c.listSecretScanningAlerts("org", "repo");

    expect((results[0] as any).secret).toBeUndefined();
    expect(JSON.stringify(results)).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

// ---------------------------------------------------------------------------
// SARIF conversion
// ---------------------------------------------------------------------------

const sampleFinding: CanonicalFinding = {
  finding_id: "raven/sqli/001",
  rule_id: "RAVEN-SQLI-001",
  title: "Possible SQL injection in user search query",
  description: "User-controlled input is concatenated into a SQL query.",
  severity: "high",
  security_severity: 8.1,
  confidence: "medium",
  precision: "medium",
  cwe: ["CWE-89"],
  file: "src/api/users/search.ts",
  start_line: 42,
  end_line: 48,
  evidence: "Sanitised evidence only.",
  recommendation: "Use parameterised queries.",
};

describe("findingsToSarif", () => {
  it("produces a SARIF 2.1.0 log", () => {
    const sarif = findingsToSarif([sampleFinding], "TestTool", "bcgov/example");
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs).toHaveLength(1);
  });

  it("uses the tool name in the driver", () => {
    const sarif = findingsToSarif([sampleFinding], "RAVEN Agentic Security Review", "bcgov/example");
    expect(sarif.runs[0].tool.driver.name).toBe("RAVEN Agentic Security Review");
  });

  it("converts one finding to one result", () => {
    const sarif = findingsToSarif([sampleFinding], "tool", "bcgov/example");
    expect(sarif.runs[0].results).toHaveLength(1);
    const r = sarif.runs[0].results![0];
    expect(r.ruleId).toBe("RAVEN-SQLI-001");
    expect(r.level).toBe("error"); // high → error
  });

  it("deduplicates rules across findings with the same rule_id", () => {
    const f2 = { ...sampleFinding, finding_id: "raven/sqli/002", start_line: 80 };
    const sarif = findingsToSarif([sampleFinding, f2], "tool", "bcgov/example");
    expect(sarif.runs[0].tool.driver.rules).toHaveLength(1);
  });

  it("maps severities to correct SARIF levels", () => {
    const severityMap: Array<[CanonicalFinding["severity"], "error" | "warning" | "note"]> = [
      ["critical", "error"],
      ["high", "error"],
      ["medium", "warning"],
      ["low", "note"],
      ["note", "note"],
    ];
    for (const [sev, expectedLevel] of severityMap) {
      const f = { ...sampleFinding, severity: sev };
      const sarif = findingsToSarif([f], "tool", "bcgov/example");
      expect(sarif.runs[0].results![0].level).toBe(expectedLevel);
    }
  });

  it("strips leading slashes from file paths", () => {
    const f = { ...sampleFinding, file: "/src/api/users/search.ts" };
    const sarif = findingsToSarif([f], "tool", "bcgov/example");
    const uri = sarif.runs[0].results![0].locations![0].physicalLocation!.artifactLocation.uri;
    expect(uri).not.toMatch(/^\//);
    expect(uri).toBe("src/api/users/search.ts");
  });

  it("normalises Windows backslash paths to forward slashes", () => {
    const f = { ...sampleFinding, file: "src\\api\\users\\search.ts" };
    const sarif = findingsToSarif([f], "tool", "bcgov/example");
    const uri = sarif.runs[0].results![0].locations![0].physicalLocation!.artifactLocation.uri;
    expect(uri).toBe("src/api/users/search.ts");
  });

  it("includes a partialFingerprints entry", () => {
    const sarif = findingsToSarif([sampleFinding], "tool", "bcgov/example");
    const result = sarif.runs[0].results![0];
    expect(result.partialFingerprints?.["primaryLocationLineHash/v1"]).toBeTruthy();
    expect(typeof result.partialFingerprints?.["primaryLocationLineHash/v1"]).toBe("string");
  });

  it("includes checkout_uri in originalUriBaseIds when provided", () => {
    const sarif = findingsToSarif(
      [sampleFinding],
      "tool",
      "bcgov/example",
      "file:///workspace/example",
    );
    expect(sarif.runs[0].originalUriBaseIds?.["SRCROOT"]?.uri).toBe(
      "file:///workspace/example",
    );
  });
});

// ---------------------------------------------------------------------------
// Fingerprint stability
// ---------------------------------------------------------------------------

describe("computeFingerprint", () => {
  it("is stable — same inputs produce the same fingerprint", () => {
    const a = computeFingerprint("bcgov/example", "RAVEN-SQLI-001", "src/foo.ts", 42, "SQL injection");
    const b = computeFingerprint("bcgov/example", "RAVEN-SQLI-001", "src/foo.ts", 42, "SQL injection");
    expect(a).toBe(b);
  });

  it("differs when the file path changes", () => {
    const a = computeFingerprint("bcgov/example", "RULE-1", "src/a.ts", 1, "msg");
    const b = computeFingerprint("bcgov/example", "RULE-1", "src/b.ts", 1, "msg");
    expect(a).not.toBe(b);
  });

  it("differs when the line changes", () => {
    const a = computeFingerprint("bcgov/example", "RULE-1", "src/a.ts", 10, "msg");
    const b = computeFingerprint("bcgov/example", "RULE-1", "src/a.ts", 11, "msg");
    expect(a).not.toBe(b);
  });

  it("returns a 40-char hex string", () => {
    const fp = computeFingerprint("bcgov/example", "RULE-1", "src/a.ts", 1, "msg");
    expect(fp).toMatch(/^[0-9a-f]{40}$/);
  });

  it("is case-insensitive on repo slug and rule_id", () => {
    const a = computeFingerprint("BCGov/Example", "RULE-1", "src/a.ts", 1, "msg");
    const b = computeFingerprint("bcgov/example", "rule-1", "src/a.ts", 1, "msg");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// validateSarif
// ---------------------------------------------------------------------------

describe("validateSarif", () => {
  it("accepts a valid SARIF 2.1.0 log", () => {
    const sarif = findingsToSarif([sampleFinding], "tool", "org/repo");
    expect(() => validateSarif(sarif)).not.toThrow();
  });

  it("rejects SARIF with wrong version", () => {
    const sarif = { ...findingsToSarif([sampleFinding], "tool", "org/repo"), version: "2.0.0" as "2.1.0" };
    expect(() => validateSarif(sarif)).toThrow(/version/);
  });

  it("rejects SARIF with no runs", () => {
    const sarif = findingsToSarif([sampleFinding], "tool", "org/repo");
    const bad = { ...sarif, runs: [] };
    expect(() => validateSarif(bad)).toThrow(/run/);
  });

  it("rejects a result with an absolute Unix path", () => {
    const sarif = findingsToSarif([sampleFinding], "tool", "org/repo");
    const badSarif = JSON.parse(JSON.stringify(sarif));
    badSarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri =
      "/Users/alice/projects/example/src/foo.ts";
    expect(() => validateSarif(badSarif)).toThrow(/absolute/i);
  });

  it("rejects a result with a Windows absolute path", () => {
    const sarif = findingsToSarif([sampleFinding], "tool", "org/repo");
    const badSarif = JSON.parse(JSON.stringify(sarif));
    badSarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri =
      "C:\\Users\\alice\\projects\\example\\src\\foo.ts";
    expect(() => validateSarif(badSarif)).toThrow(/absolute/i);
  });
});

// ---------------------------------------------------------------------------
// encodeSarif
// ---------------------------------------------------------------------------

describe("encodeSarif", () => {
  it("returns a non-empty base64 string", async () => {
    const sarif = findingsToSarif([sampleFinding], "tool", "org/repo");
    const encoded = await encodeSarif(sarif);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
    // Should be valid base64
    expect(() => Buffer.from(encoded, "base64")).not.toThrow();
  });

  it("produces gzip-compressed content (magic bytes after decode)", async () => {
    const sarif = findingsToSarif([sampleFinding], "tool", "org/repo");
    const encoded = await encodeSarif(sarif);
    const decoded = Buffer.from(encoded, "base64");
    // gzip magic bytes: 0x1f 0x8b
    expect(decoded[0]).toBe(0x1f);
    expect(decoded[1]).toBe(0x8b);
  });
});
