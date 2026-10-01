import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readdir, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import {
  isUsableSpoPair,
  readCachedSpoSession,
  writeCachedSpoSession,
  clearCachedSpoSession,
  clearCachedSpoSessionIf,
} from "../spo-cookie-cache.js";

// Wrap the atomic writer (still the real one) so a test can see that this
// module writes through it. A plain writeFile would pass every other test here.
vi.mock("../atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomic-file.js")>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

// Permission bits cannot be used to force a delete failure on Windows, or for root.
const cannotForceDeleteFailure = process.platform === "win32" || process.getuid?.() === 0;

let dir: string;
let cachePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "spo-cache-"));
  cachePath = join(dir, "spo-session.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("spo cookie cache", () => {
  it("returns null when the cache file does not exist", async () => {
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("round-trips a cookie pair", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const got = await readCachedSpoSession(cachePath);
    expect(got).toEqual({ fedAuth: "fa", rtFa: "rt" });
  });

  it("returns null when the entry is older than the TTL", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    expect(await readCachedSpoSession(cachePath, 0)).toBeNull();
  });

  it("returns null when either cookie is missing from the file", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      cachePath,
      JSON.stringify({ fedAuth: "fa", cachedAt: Date.now(), capturedFor: "x" })
    );
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("returns null on corrupt JSON instead of throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(cachePath, "not json");
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("returns null when cachedAt is missing (NaN age must not bypass the TTL)", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      cachePath,
      JSON.stringify({ fedAuth: "fa", rtFa: "rt", capturedFor: "x" })
    );
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  it("returns null when cachedAt is not a finite number", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      cachePath,
      JSON.stringify({ fedAuth: "fa", rtFa: "rt", cachedAt: "garbage", capturedFor: "x" })
    );
    expect(await readCachedSpoSession(cachePath)).toBeNull();
  });

  describe("an entry that cannot be trusted", () => {
    const seconds = (n: number) => n * 1000;

    it.each([
      ["an hour in the future (the clock stepped back)", seconds(3600)],
      ["a day in the future", seconds(86_400)],
      ["far in the future", seconds(86_400 * 3650)],
    ])("is rejected when it is stamped %s: its age is negative, so it would look fresh until the clock caught up and then for a whole TTL", async (_when, ahead) => {
      await writeFile(
        cachePath,
        JSON.stringify({ fedAuth: "fa", rtFa: "rt", cachedAt: Date.now() + ahead, capturedFor: "x" })
      );
      expect(await readCachedSpoSession(cachePath)).toBeNull();
    });

    it("is still served when the stamp is only a little ahead (ordinary clock skew)", async () => {
      await writeFile(
        cachePath,
        JSON.stringify({ fedAuth: "fa", rtFa: "rt", cachedAt: Date.now() + seconds(30), capturedFor: "x" })
      );
      expect(await readCachedSpoSession(cachePath)).toEqual({ fedAuth: "fa", rtFa: "rt" });
    });

    it.each([
      ["numbers", { fedAuth: 123, rtFa: 456 }],
      ["booleans", { fedAuth: true, rtFa: true }],
      ["objects", { fedAuth: { x: 1 }, rtFa: ["y"] }],
      ["blank strings", { fedAuth: "   ", rtFa: "\t" }],
      ["one blank string", { fedAuth: "fa", rtFa: " " }],
    ])("is rejected when the cookies are %s, not sent on as a cookie header", async (_what, cookies) => {
      await writeFile(cachePath, JSON.stringify({ ...cookies, cachedAt: Date.now(), capturedFor: "x" }));
      expect(await readCachedSpoSession(cachePath)).toBeNull();
    });
  });

  it.skipIf(process.platform === "win32")("writes the cache file with mode 0600", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const st = await stat(cachePath);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("records capturedFor in the file", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    const raw = JSON.parse(await readFile(cachePath, "utf-8"));
    expect(raw.capturedFor).toBe("example.sharepoint.com");
  });

  it("clear removes the file, and reports true both then and when there was nothing to remove", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    expect(await clearCachedSpoSession(cachePath)).toBe(true);
    expect(await readCachedSpoSession(cachePath)).toBeNull();
    expect(await clearCachedSpoSession(cachePath)).toBe(true); // second call must not throw
  });

  it.skipIf(cannotForceDeleteFailure)("clear reports false when the file could not be removed", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa", rtFa: "rt" }, "example.sharepoint.com");
    await chmod(dir, 0o500);
    try {
      expect(await clearCachedSpoSession(cachePath)).toBe(false);
    } finally {
      await chmod(dir, 0o700);
    }
    expect(existsSync(cachePath)).toBe(true);
  });

  it("replaces the file without leaving temporary files behind", async () => {
    // Shares the atomic helper with the SiteMinder cache, so a sibling process
    // never reads a truncated file while this one is writing.
    await writeCachedSpoSession(cachePath, { fedAuth: "fa1", rtFa: "rt1" }, "example.sharepoint.com");
    await writeCachedSpoSession(cachePath, { fedAuth: "fa2", rtFa: "rt2" }, "example.sharepoint.com");

    expect(writeFileAtomic).toHaveBeenCalledWith(cachePath, expect.stringContaining("fa2"));
    expect(await readdir(dir)).toEqual(["spo-session.json"]);
    expect(await readCachedSpoSession(cachePath)).toEqual({ fedAuth: "fa2", rtFa: "rt2" });
  });
});

describe("isUsableSpoPair", () => {
  it("accepts a pair of non-blank strings", () => {
    expect(isUsableSpoPair({ fedAuth: "fa", rtFa: "rt" })).toBe(true);
  });

  it("accepts a cache record, which carries more than the pair", () => {
    expect(isUsableSpoPair({ fedAuth: "fa", rtFa: "rt", cachedAt: 1, capturedFor: "x" })).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "FedAuth=fa"],
    ["an array", ["fa", "rt"]],
    ["an empty object", {}],
    ["no rtFa", { fedAuth: "fa" }],
    ["no fedAuth", { rtFa: "rt" }],
    ["empty strings", { fedAuth: "", rtFa: "" }],
    ["blank strings", { fedAuth: " ", rtFa: "  " }],
    ["one blank string", { fedAuth: "fa", rtFa: "\n" }],
    ["numbers", { fedAuth: 1, rtFa: 2 }],
  ])("rejects %s", (_what, value) => {
    expect(isUsableSpoPair(value)).toBe(false);
  });
});

describe("clearCachedSpoSessionIf", () => {
  const pair = (n: number) => ({ fedAuth: `fa${n}`, rtFa: `rt${n}` });

  it("removes the cache when it still holds the pair that just failed", async () => {
    await writeCachedSpoSession(cachePath, pair(1), "example.sharepoint.com");
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(true);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("keeps a fresher pair another process cached in the meantime", async () => {
    await writeCachedSpoSession(cachePath, pair(2), "example.sharepoint.com");
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(false);
    expect(await readCachedSpoSession(cachePath)).toEqual(pair(2));
  });

  it("treats a pair as different when only one cookie matches", async () => {
    await writeCachedSpoSession(cachePath, { fedAuth: "fa1", rtFa: "rt-new" }, "example.sharepoint.com");
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(false);
  });

  it("leaves an unparseable file alone", async () => {
    await writeFile(cachePath, '{"fedAuth": "fa');
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(false);
    expect(await readFile(cachePath, "utf-8")).toBe('{"fedAuth": "fa');
  });

  it("does not throw on valid JSON that is not a cache record, and removes it as unusable", async () => {
    await writeFile(cachePath, "null");
    await expect(clearCachedSpoSessionIf(cachePath, pair(1))).resolves.toBe(true);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("removes a record whose cookies are blank, since readers ignore it as unusable", async () => {
    await writeFile(cachePath, JSON.stringify({ fedAuth: " ", rtFa: " ", cachedAt: Date.now(), capturedFor: "x" }));
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(true);
    expect(existsSync(cachePath)).toBe(false);
  });

  it.skipIf(cannotForceDeleteFailure)(
    "reports false when the matching file could not be removed, so callers do not believe it is gone",
    async () => {
      await writeCachedSpoSession(cachePath, pair(1), "example.sharepoint.com");
      await chmod(dir, 0o500);
      try {
        expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(false);
      } finally {
        await chmod(dir, 0o700);
      }
      expect(await readCachedSpoSession(cachePath)).toEqual(pair(1));
    }
  );

  it("reports a missing cache file as gone, like clearCachedSpoSession does", async () => {
    expect(await clearCachedSpoSessionIf(cachePath, pair(1))).toBe(true);
  });
});
