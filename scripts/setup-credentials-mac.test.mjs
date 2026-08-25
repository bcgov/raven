import { describe, it, expect } from "vitest";
import { mask, seedDefaults, normalizeAnswer, validateRecord } from "./setup-credentials-mac.lib.mjs";

describe("mask", () => {
  it("masks short values entirely", () => {
    expect(mask("abcd")).toBe("****");
  });

  it("keeps the first and last two characters of longer values", () => {
    expect(mask("it-works")).toBe("it****ks");
  });
});

describe("seedDefaults", () => {
  const PROMPTED = ["ATLASSIAN_BASE_URL", "ATLASSIAN_PASSWORD"];

  it("imports prompted keys from the .env record when the keychain lacks them", () => {
    const defaults = seedDefaults(PROMPTED, { ATLASSIAN_BASE_URL: "https://env" }, {});
    expect(defaults).toEqual({ ATLASSIAN_BASE_URL: "https://env" });
  });

  it("prefers keychain values over .env values", () => {
    const defaults = seedDefaults(
      PROMPTED,
      { ATLASSIAN_PASSWORD: "from-env" },
      { ATLASSIAN_PASSWORD: "from-keychain" }
    );
    expect(defaults.ATLASSIAN_PASSWORD).toBe("from-keychain");
  });

  it("does not import non-prompted .env keys", () => {
    const defaults = seedDefaults(PROMPTED, { SERVER_UI_PORT: "3777" }, {});
    expect(defaults).toEqual({});
  });

  it("preserves extra keys already stored in the keychain", () => {
    const defaults = seedDefaults(PROMPTED, {}, { IMIS_CSV_PATH: "/x.csv" });
    expect(defaults.IMIS_CSV_PATH).toBe("/x.csv");
  });
});

describe("normalizeAnswer", () => {
  it("keeps leading and trailing spaces verbatim for sensitive answers", () => {
    expect(normalizeAnswer("  p@ss  ", { sensitive: true })).toBe("  p@ss  ");
  });

  it("strips only a trailing carriage return for sensitive answers", () => {
    expect(normalizeAnswer("x\r", { sensitive: true })).toBe("x");
  });

  it("trims non-sensitive answers", () => {
    expect(normalizeAnswer("  a  ", { sensitive: false })).toBe("a");
  });
});

describe("validateRecord", () => {
  const ATLASSIAN_OK = {
    ATLASSIAN_BASE_URL: "https://example.gov.bc.ca",
    ATLASSIAN_EMAIL: "jane.smith@gov.bc.ca",
    ATLASSIAN_PASSWORD: "secret",
  };

  it("requires all three ATLASSIAN fields", () => {
    const errors = validateRecord({ ATLASSIAN_BASE_URL: "https://example.gov.bc.ca" });
    expect(errors).toContain(
      "ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL, and ATLASSIAN_PASSWORD are required."
    );
  });

  it("passes with all three ATLASSIAN fields and no GitHub token", () => {
    expect(validateRecord(ATLASSIAN_OK)).toEqual([]);
  });

  it("requires GITHUB_REPOSITORY_ALLOWLIST when GITHUB_TOKEN is set", () => {
    const errors = validateRecord({ ...ATLASSIAN_OK, GITHUB_TOKEN: "ghp_x" });
    expect(errors).toContain(
      "GITHUB_REPOSITORY_ALLOWLIST is required when configuring GITHUB_TOKEN."
    );
  });

  it("rejects a token kept from the keychain paired with a blank allowlist", () => {
    // Simulates: GITHUB_TOKEN survived from `existing` (kept, not re-typed)
    // while GITHUB_REPOSITORY_ALLOWLIST was never set — merged record still
    // has the token but no allowlist.
    const merged = { ...ATLASSIAN_OK, GITHUB_TOKEN: "ghp_kept", GITHUB_REPOSITORY_ALLOWLIST: "" };
    expect(validateRecord(merged)).toContain(
      "GITHUB_REPOSITORY_ALLOWLIST is required when configuring GITHUB_TOKEN."
    );
  });

  it("passes when both GITHUB_TOKEN and GITHUB_REPOSITORY_ALLOWLIST are set", () => {
    const errors = validateRecord({
      ...ATLASSIAN_OK,
      GITHUB_TOKEN: "ghp_x",
      GITHUB_REPOSITORY_ALLOWLIST: "bcgov/*",
    });
    expect(errors).toEqual([]);
  });
});
