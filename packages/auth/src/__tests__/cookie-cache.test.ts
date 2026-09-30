import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearCachedSessionIf,
  isUsableSmsession,
  readCachedSession,
  writeCachedSession,
} from "../cookie-cache.js";

describe("SMSESSION cache", () => {
  let dir: string;
  let cachePath: string;

  const seed = (smsession: string, ageSeconds = 0) =>
    writeFile(
      cachePath,
      JSON.stringify({
        smsession,
        cachedAt: Date.now() - ageSeconds * 1000,
        capturedFor: "apps.example.gov.bc.ca",
      })
    );

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "auth-cache-"));
    cachePath = join(dir, "session.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  describe("isUsableSmsession", () => {
    it("accepts a real cookie value", () => {
      expect(isUsableSmsession("abc123+/=")).toBe(true);
    });

    it.each(["", "   ", "LOGGEDOFF", "loggedoff", " LoggedOff "])(
      "rejects %j — SiteMinder's marker for a dead session, not a session",
      (value) => {
        expect(isUsableSmsession(value)).toBe(false);
      }
    );

    it("rejects null and undefined", () => {
      expect(isUsableSmsession(null)).toBe(false);
      expect(isUsableSmsession(undefined)).toBe(false);
    });
  });

  describe("readCachedSession", () => {
    it("returns a fresh real cookie", async () => {
      await seed("real-cookie");
      expect(await readCachedSession(cachePath, 1500)).toBe("real-cookie");
    });

    it("never serves a cached LOGGEDOFF marker as a valid session", async () => {
      // A capture that ran against a dead session used to cache LOGGEDOFF, which
      // then passed the 25-minute age check and failed every downstream request.
      await seed("LOGGEDOFF");
      expect(await readCachedSession(cachePath, 1500)).toBeNull();
    });

    it("still expires a real cookie by age", async () => {
      await seed("real-cookie", 1501);
      expect(await readCachedSession(cachePath, 1500)).toBeNull();
    });
  });

  describe("writeCachedSession", () => {
    it("refuses to persist an unusable cookie and leaves an existing cache untouched", async () => {
      await seed("real-cookie");
      await expect(writeCachedSession(cachePath, "LOGGEDOFF")).rejects.toThrow(/unusable/i);
      expect(JSON.parse(await readFile(cachePath, "utf-8")).smsession).toBe("real-cookie");
    });

    it("persists a real cookie", async () => {
      await writeCachedSession(cachePath, "real-cookie", "apps.example.gov.bc.ca");
      expect(JSON.parse(await readFile(cachePath, "utf-8")).smsession).toBe("real-cookie");
    });

    it("replaces the file atomically: no temp files left behind and readers never see partial JSON", async () => {
      // A plain writeFile truncates in place, so a sibling reading mid-write
      // saw a half-written file and (via the corrupt-file path) deleted it.
      const writes = Array.from({ length: 25 }, (_, i) =>
        writeCachedSession(cachePath, `cookie-${i}`, "apps.example.gov.bc.ca")
      );
      const reads = Array.from({ length: 50 }, async () => {
        try {
          return JSON.parse(await readFile(cachePath, "utf-8")).smsession as string;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw err; // a SyntaxError here means a torn read
        }
      });

      const observed = await Promise.all([...reads, ...writes]);

      expect(observed.filter((v) => typeof v === "string").every((v) => /^cookie-\d+$/.test(v as string))).toBe(true);
      expect((await readdir(dir)).sort()).toEqual(["session.json"]);
      expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    });
  });

  describe("clearCachedSessionIf", () => {
    it("removes the cache when it still holds the cookie that just failed", async () => {
      await seed("dead-cookie");
      expect(await clearCachedSessionIf(cachePath, "dead-cookie")).toBe(true);
      expect(await readCachedSession(cachePath, 1500)).toBeNull();
    });

    it("keeps a fresher cookie another process cached in the meantime", async () => {
      // The CLI (or a sibling MCP server) re-logged in after this process's cookie
      // died. Deleting the file here threw the fresh login away.
      await seed("fresh-cookie-from-elsewhere");
      expect(await clearCachedSessionIf(cachePath, "dead-cookie")).toBe(false);
      expect(await readCachedSession(cachePath, 1500)).toBe("fresh-cookie-from-elsewhere");
    });

    it("cleans up a poisoned LOGGEDOFF cache regardless of the expected cookie", async () => {
      await seed("LOGGEDOFF");
      expect(await clearCachedSessionIf(cachePath, "dead-cookie")).toBe(true);
    });

    it("is a no-op when there is no cache file", async () => {
      expect(await clearCachedSessionIf(cachePath, "dead-cookie")).toBe(false);
    });

    it("leaves an unparseable file alone instead of deleting what may be a sibling's in-flight write", async () => {
      await writeFile(cachePath, '{"smsession": "fresh-cook');
      expect(await clearCachedSessionIf(cachePath, "dead-cookie")).toBe(false);
      expect(await readFile(cachePath, "utf-8")).toBe('{"smsession": "fresh-cook');
    });
  });
});
