import { readFileSync } from "node:fs";
import type { ImisServer, SearchParams } from "./types.js";

/** Column indices in the IMIS TSV export (0-based). */
const COL = {
  serverName: 0, fullName: 1, aliasName: 2, description: 3, businessArea: 4,
  pOrV: 5, status: 6, type: 7, primaryIp: 8, totalIps: 9, zone: 10,
  subnet: 11, vlan: 12, physicalLocation: 13, os: 14, os1: 15, os2: 16,
  os3: 17, osBits: 18, buildDate: 19, retireDate: 20, lastBootDate: 21,
  makeModel: 22, coreCpu: 23, cpuType: 24, ram: 25, ohCoding: 26,
  citrix: 27, web: 28, iis: 29, ftp: 30, smtp: 31, internalDisk: 32,
  tier0: 33, tier1: 34, tier2: 35, tier3: 36, external: 37,
  otherStorage: 38, hardwareEol: 39, serialNumber: 40,
  item1: 41, content1: 42, item2: 43, content2: 44, item3: 45,
  content3: 46, item4: 47, content4: 48, item5: 49, content5: 50,
  item6: 51, content6: 52, flag1: 53, flag2: 54, flag3: 55, flag4: 56,
  flag5: 57, flag6: 58, flag7: 59, flag8: 60, imisAgent: 61,
  agentStatus: 62, agentUpdate: 63, imisControl: 64, agentAccount: 65,
  orderIStore: 66, retireIStore: 67, notes: 68, lastUpdate: 69,
} as const;

const FIELD_NAMES = Object.keys(COL) as Array<keyof typeof COL>;

function parseRow(fields: string[]): ImisServer {
  const server: Record<string, string> = {};
  for (const name of FIELD_NAMES) {
    server[name] = (fields[COL[name]] ?? "").trim();
  }
  return server as unknown as ImisServer;
}

function includes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export class ImisClient {
  private servers: ImisServer[];

  constructor(csvPath: string) {
    const content = readFileSync(csvPath, "utf-8");
    const lines = content.split(/\r?\n/).filter(l => l.trim() !== "");
    this.servers = lines.slice(1).map(line => parseRow(line.split("\t")));
  }

  search(params: SearchParams): ImisServer[] {
    return this.servers.filter(s => {
      if (!params.includeRetired && (s.status === "RETIRED" || s.status === "TRANSFERRED")) {
        return false;
      }
      if (params.type && !includes(s.type, params.type)) return false;
      if (params.status && !includes(s.status, params.status)) return false;
      if (params.businessArea && !includes(s.businessArea, params.businessArea)) return false;
      if (params.os && !includes(s.os, params.os)) return false;
      if (params.zone && !includes(s.zone, params.zone)) return false;
      if (params.query) {
        const q = params.query.toLowerCase();
        const searchable = [s.serverName, s.fullName, s.description, s.notes, s.primaryIp]
          .join(" ").toLowerCase();
        if (!searchable.includes(q)) return false;
      }
      return true;
    });
  }

  getServer(name: string): ImisServer | undefined {
    const lower = name.toLowerCase();
    return this.servers.find(s => s.serverName.toLowerCase() === lower);
  }

  getStats(): {
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
    byOsFamily: Record<string, number>;
    byZone: Record<string, number>;
    byBusinessArea: Record<string, number>;
    latestAgentUpdate: string;
  } {
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byOsFamily: Record<string, number> = {};
    const byZone: Record<string, number> = {};
    const byBusinessArea: Record<string, number> = {};
    let latestAgentUpdate = "";

    for (const s of this.servers) {
      const status = s.status || "(blank)";
      byStatus[status] = (byStatus[status] ?? 0) + 1;

      const type = s.type || "(blank)";
      byType[type] = (byType[type] ?? 0) + 1;

      const osFamily = s.os.includes("Windows") ? "Windows"
        : s.os.includes("Linux") || s.os.includes("Red Hat") || s.os.includes("Oracle Linux") ? "Linux"
        : s.os.includes("UNIX") || s.os.includes("Solaris") || s.os.includes("AIX") ? "Unix"
        : s.os || "(blank)";
      byOsFamily[osFamily] = (byOsFamily[osFamily] ?? 0) + 1;

      const zone = s.zone || "(blank)";
      byZone[zone] = (byZone[zone] ?? 0) + 1;

      const biz = s.businessArea || "(blank)";
      byBusinessArea[biz] = (byBusinessArea[biz] ?? 0) + 1;

      if (s.agentUpdate > latestAgentUpdate) {
        latestAgentUpdate = s.agentUpdate;
      }
    }

    return { total: this.servers.length, byStatus, byType, byOsFamily, byZone, byBusinessArea, latestAgentUpdate };
  }
}
