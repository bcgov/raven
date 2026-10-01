import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import {
  clearCachedSession,
  clearCachedSessionIf,
  isUsableSmsession,
  readCachedSession,
  writeCachedSession,
} from "../cookie-cache.js";

// Wrap the atomic writer (still the real one) so a test can see that this
// module writes through it. A plain writeFile would pass every other test here.
vi.mock("../atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomic-file.js")>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

// Permission bits cannot be used to force a delete failure on Windows, or for root.
const cannotForceDeleteFailure = process.platform === "win32" || process.getuid?.() === 0;

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

    // Each value is wrapped in its own row: it.each would otherwise spread the arrays.
    it.each([[42], [true], [{}], [[]], [["real-cookie"]]])(
      "rejects the non-string value %j that a hand-edited cache file can contain",
      (value) => {
        expect(isUsableSmsession(value)).toBe(false);
      }
    );
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

    it.each([
      ["missing", undefined],
      ["a string", "garbage"],
      ["null", null],
    ])(
      "rejects an entry whose cachedAt is %s, so a hand-written or foreign file is never served forever",
      async (_name, cachedAt) => {
        // A NaN age compares false against the TTL and would never expire.
        await writeFile(cachePath, JSON.stringify({ smsession: "real-cookie", cachedAt, capturedFor: "x" }));
        expect(await readCachedSession(cachePath, 1500)).toBeNull();
      }
    );

    it("rejects an entry stamped far in the future", async () => {
      await seed("real-cookie", -3600);
      expect(await readCachedSession(cachePath, 1500)).toBeNull();
    });

    describe("the Python Confluence MCP's cache, which getSession() falls back to", () => {
      // That server stamps `cached_at` in epoch SECONDS, not `cachedAt` in
      // milliseconds (confluence_mcp.py: json.dumps({"smsession": ..., "cached_at": time.time()})).
      const legacy = (cookie: string, ageSeconds: number) =>
        writeFile(cachePath, JSON.stringify({ smsession: cookie, cached_at: Date.now() / 1000 - ageSeconds }));

      it("is read, with the seconds stamp converted", async () => {
        await legacy("legacy-cookie", 10);
        expect(await readCachedSession(cachePath, 1500)).toBe("legacy-cookie");
      });

      it("still expires by age", async () => {
        await legacy("legacy-cookie", 1501);
        expect(await readCachedSession(cachePath, 1500)).toBeNull();
      });

      it("is not trusted when it is stamped in the future", async () => {
        await legacy("legacy-cookie", -3600);
        expect(await readCachedSession(cachePath, 1500)).toBeNull();
      });

      it("never serves a LOGGEDOFF marker either", async () => {
        await legacy("LOGGEDOFF", 10);
        expect(await readCachedSession(cachePath, 1500)).toBeNull();
      });
    });

    it("tolerates a few seconds of clock skew", async () => {
      await seed("real-cookie", -5);
      expect(await readCachedSession(cachePath, 1500)).toBe("real-cookie");
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

    it.each([["blank", ""], ["not a URL", "not a url"]])(
      "still caches when ATLASSIAN_BASE_URL is %s, instead of throwing 'Invalid URL' after a good login",
      async (_name, value) => {
        const saved = process.env["ATLASSIAN_BASE_URL"];
        process.env["ATLASSIAN_BASE_URL"] = value;
        try {
          await writeCachedSession(cachePath, "real-cookie");
          expect(JSON.parse(await readFile(cachePath, "utf-8")).smsession).toBe("real-cookie");
        } finally {
          if (saved === undefined) delete process.env["ATLASSIAN_BASE_URL"];
          else process.env["ATLASSIAN_BASE_URL"] = saved;
        }
      }
    );

    it("replaces the file without leaving temporary files behind", async () => {
      // The no-torn-read guarantee itself is proven against a large payload in
      // atomic-file.test.ts; this checks the cache goes through that helper.
      await writeCachedSession(cachePath, "cookie-1", "apps.example.gov.bc.ca");
      await writeCachedSession(cachePath, "cookie-2", "apps.example.gov.bc.ca");

      expect(writeFileAtomic).toHaveBeenCalledWith(cachePath, expect.stringContaining("cookie-2"));

      expect(await readdir(dir)).toEqual(["session.json"]);
      expect(JSON.parse(await readFile(cachePath, "utf-8")).smsession).toBe("cookie-2");
      if (process.platform !== "win32") expect((await stat(cachePath)).mode & 0o777).toBe(0o600);
    });
  });

  describe("clearCachedSession", () => {
    it("reports true when it removed the file, and when there was nothing to remove", async () => {
      await seed("real-cookie");
      expect(await clearCachedSession(cachePath)).toBe(true);
      expect(existsSync(cachePath)).toBe(false);
      expect(await clearCachedSession(cachePath)).toBe(true);
    });

    it.skipIf(cannotForceDeleteFailure)("reports false when the file could not be removed", async () => {
      await seed("real-cookie");
      await chmod(dir, 0o500);
      try {
        expect(await clearCachedSession(cachePath)).toBe(false);
      } finally {
        await chmod(dir, 0o700);
      }
      expect(existsSync(cachePath)).toBe(true);
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

    it("reports a missing cache file as gone, like clearCachedSession does, so nobody is told it was 'left as it is'", async () => {
      expect(await clearCachedSessionIf(cachePath, "dead-cookie")).toBe(true);
    });

    it("leaves an unparseable file alone: readers already ignore it and the next atomic write replaces it", async () => {
      await writeFile(cachePath, '{"smsession": "fresh-cook');
      expect(await clearCachedSessionIf(cachePath, "dead-cookie")).toBe(false);
      expect(await readFile(cachePath, "utf-8")).toBe('{"smsession": "fresh-cook');
    });

    it("does not throw on valid JSON that is not a cache record, and removes it as unusable", async () => {
      await writeFile(cachePath, "null");
      await expect(clearCachedSessionIf(cachePath, "dead-cookie")).resolves.toBe(true);
      expect(existsSync(cachePath)).toBe(false);
    });

    it.skipIf(cannotForceDeleteFailure)(
      "reports false when the matching file could not be removed, so callers do not believe it is gone",
      async () => {
        await seed("dead-cookie");
        await chmod(dir, 0o500);
        try {
          expect(await clearCachedSessionIf(cachePath, "dead-cookie")).toBe(false);
        } finally {
          await chmod(dir, 0o700);
        }
        expect(await readCachedSession(cachePath, 1500)).toBe("dead-cookie");
      }
    );
  });
});
