import { describe, it, expect } from "vitest";
import { mask, seedDefaults } from "./setup-credentials-mac.lib.mjs";

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
