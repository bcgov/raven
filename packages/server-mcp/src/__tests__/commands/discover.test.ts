import { describe, it, expect } from "vitest";
import { parseDiscoverOutput, buildDiscoverCommand } from "../../commands/discover.js";

describe("buildDiscoverCommand", () => {
  it("includes the apps_base in the for loop", () => {
    const cmd = buildDiscoverCommand("/apps_ux");
    expect(cmd).toContain("/apps_ux");
    expect(cmd).toContain("readlink");
    expect(cmd).toContain("current");
  });

  it("filters by app when provided", () => {
    const cmd = buildDiscoverCommand("/apps_ux", "RRS");
    expect(cmd).toContain("RRS");
  });
});

describe("parseDiscoverOutput", () => {
  it("parses pipe-delimited app lines", () => {
    const raw = `
  Discovering apps...
RRS|rrs-api|rrs-2.4.1|port:8080
RRS|rrs-web|rrs-web-1.2.0|
DMS|dms-document-api|dms-3.0.1|port:8090
`;
    const apps = parseDiscoverOutput(raw);
    expect(apps).toHaveLength(3);
    expect(apps[0]).toEqual({ app: "RRS", component: "rrs-api", version: "rrs-2.4.1", port: "port:8080" });
    expect(apps[1]).toEqual({ app: "RRS", component: "rrs-web", version: "rrs-web-1.2.0", port: "" });
  });

  it("ignores non-data lines", () => {
    const raw = "  Discovering apps on TEST01...\n\nRRS|rrs-api|rrs-2.4.1|\n";
    expect(parseDiscoverOutput(raw)).toHaveLength(1);
  });

  it("returns empty array for no output", () => {
    expect(parseDiscoverOutput("")).toHaveLength(0);
  });
});
