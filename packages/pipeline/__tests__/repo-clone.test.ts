import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildAuthUrl, assertHttpsUrl } from "../src/repo-clone.js";

describe("buildAuthUrl", () => {
  let savedEmail: string | undefined;
  let savedPassword: string | undefined;
  beforeEach(() => {
    savedEmail = process.env["ATLASSIAN_EMAIL"];
    savedPassword = process.env["ATLASSIAN_PASSWORD"];
    process.env["ATLASSIAN_EMAIL"] = "svc@example.test";
    process.env["ATLASSIAN_PASSWORD"] = "s3cret";
  });
  afterEach(() => {
    if (savedEmail === undefined) delete process.env["ATLASSIAN_EMAIL"];
    else process.env["ATLASSIAN_EMAIL"] = savedEmail;
    if (savedPassword === undefined) delete process.env["ATLASSIAN_PASSWORD"];
    else process.env["ATLASSIAN_PASSWORD"] = savedPassword;
  });

  it("injects credentials into an https clone URL", () => {
    const url = buildAuthUrl("https://scm.example.test/scm/ARTS/arts-arts-api.git");
    expect(url).toContain("@scm.example.test");
    expect(url.startsWith("https://")).toBe(true);
  });
});

describe("assertHttpsUrl", () => {
  it("accepts https and rejects http", () => {
    expect(() => assertHttpsUrl("https://scm.example.test/x.git", "clone")).not.toThrow();
    expect(() => assertHttpsUrl("http://scm.example.test/x.git", "clone")).toThrow();
  });
});
