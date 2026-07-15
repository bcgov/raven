import { describe, it, expect, beforeAll } from "vitest";
import { ImisClient } from "../imis-client.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), "imis-test-" + Date.now());
const TEST_CSV = join(TEST_DIR, "test-servers.csv");

const HEADERS = [
  "Server Name", "Full Name", "Alias Name", "Description", "Business Area",
  "P or V", "Status", "Type", "Primary IP", "Total IPs", "Zone", "Subnet",
  "VLAN", "Physical Location", "OS", "OS1", "OS2", "OS3", "OS Bits",
  "Build Date", "Retire Date", "LastBootDate", "Make/Model", "# Core/CPU",
  "CPU Type", "RAM", "OH Coding", "Citrix", "Web", "IIS", "FTP", "SMTP",
  "Internal Disk", "Tier 0", "Tier 1", "Tier 2", "Tier 3", "External",
  "Other Storage", "Hardware EOL", "Serial Number",
  "Item1", "Content1", "Item2", "Content2", "Item3", "Content3",
  "Item4", "Content4", "Item5", "Content5", "Item6", "Content6",
  "Flag1", "Flag2", "Flag3", "Flag4", "Flag5", "Flag6", "Flag7", "Flag8",
  "IMIS Agent", "Agent Status", "Agent Update", "IMIS Control",
  "Agent Account", "Order iStore", "Retire iStore", "Notes", "Last Update",
].join("\t");

function row(overrides: Record<number, string>, cols = 70): string {
  const fields = Array(cols).fill("");
  for (const [i, v] of Object.entries(overrides)) {
    fields[Number(i)] = v;
  }
  return fields.join("\t");
}

beforeAll(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  const rows = [
    HEADERS,
    row({ 0: "TEST01", 1: "test01.example.internal", 3: "TEST Tomcat Server", 4: "Example Ministry A", 5: "Virtual", 6: "Test", 7: "Application", 8: "192.0.2.1", 10: "Zone B", 14: "Red Hat Enterprise Linux 7.9" }),
    row({ 0: "INT01", 1: "int01.example.internal", 3: "INT Tomcat Server", 4: "Example Ministry A", 5: "Virtual", 6: "Integration", 7: "Application", 8: "192.0.2.2", 10: "Zone B", 14: "Red Hat Enterprise Linux 7.9" }),
    row({ 0: "PROD01", 1: "prod01.example.internal", 3: "PROD Tomcat Server", 4: "Example Ministry A", 5: "Virtual", 6: "Production", 7: "Application", 8: "192.0.2.3", 10: "Zone B", 14: "Red Hat Enterprise Linux 7.9" }),
    row({ 0: "DB01", 1: "db01.example.internal", 3: "Oracle Database", 4: "Example Ministry C", 5: "Virtual", 6: "Production", 7: "Database", 8: "192.0.2.90", 10: "Zone B", 14: "Red Hat Enterprise Linux release 8.6" }),
    row({ 0: "OLDBOX01", 1: "oldbox01.example.internal", 3: "Old Solaris Box", 4: "Example Ministry B", 5: "Physical", 6: "RETIRED", 7: "Application", 8: "198.51.100.183", 10: "DMZ", 14: "UNIX - Solaris 9" }),
    row({ 0: "PROXY01", 1: "proxy01.example.internal", 3: "Wildfire Proxy", 4: "Example Ministry D", 5: "Virtual", 6: "Production", 7: "Proxy", 8: "192.0.2.232", 10: "Zone B", 14: "Red Hat Enterprise Linux release 9.2" }),
  ];
  writeFileSync(TEST_CSV, rows.join("\n"), "utf-8");

  return () => rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("ImisClient", () => {
  it("loads CSV and returns all non-retired servers by default", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({});
    expect(results.length).toBe(5);
    expect(results.find(s => s.serverName === "OLDBOX01")).toBeUndefined();
  });

  it("includes retired servers when asked", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({ includeRetired: true });
    expect(results.length).toBe(6);
    expect(results.find(s => s.serverName === "OLDBOX01")).toBeDefined();
  });

  it("filters by type", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({ type: "Database" });
    expect(results.length).toBe(1);
    expect(results[0].serverName).toBe("DB01");
  });

  it("filters by status", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({ status: "Production" });
    expect(results.length).toBe(3);
  });

  it("filters by business area (partial match)", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({ businessArea: "Ministry D" });
    expect(results.length).toBe(1);
    expect(results[0].serverName).toBe("PROXY01");
  });

  it("filters by OS (partial match)", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({ os: "8.6" });
    expect(results.length).toBe(1);
    expect(results[0].serverName).toBe("DB01");
  });

  it("free-text query searches name, description, and notes", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({ query: "tomcat" });
    expect(results.length).toBe(3);
  });

  it("free-text query searches by IP", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({ query: "192.0.2.232" });
    expect(results.length).toBe(1);
    expect(results[0].serverName).toBe("PROXY01");
  });

  it("combines multiple filters with AND logic", () => {
    const client = new ImisClient(TEST_CSV);
    const results = client.search({ type: "Application", status: "Test" });
    expect(results.length).toBe(1);
    expect(results[0].serverName).toBe("TEST01");
  });

  it("getServer returns a single server by name (case-insensitive)", () => {
    const client = new ImisClient(TEST_CSV);
    const server = client.getServer("test01");
    expect(server).toBeDefined();
    expect(server!.serverName).toBe("TEST01");
    expect(server!.primaryIp).toBe("192.0.2.1");
  });

  it("getServer returns undefined for unknown server", () => {
    const client = new ImisClient(TEST_CSV);
    expect(client.getServer("DOESNOTEXIST")).toBeUndefined();
  });

  it("getStats returns counts by status, type, and OS family", () => {
    const client = new ImisClient(TEST_CSV);
    const stats = client.getStats();
    expect(stats.total).toBe(6);
    expect(stats.byStatus["Production"]).toBe(3);
    expect(stats.byStatus["RETIRED"]).toBe(1);
    expect(stats.byType["Application"]).toBe(4);
    expect(stats.byType["Database"]).toBe(1);
  });
});
