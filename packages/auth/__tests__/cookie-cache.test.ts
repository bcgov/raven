import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readCachedSession,
  writeCachedSession,
  clearCachedSession,
} from "../src/cookie-cache.js";

const TEST_DIR = join(tmpdir(), "raven-test-" + Date.now());
const TEST_CACHE = join(TEST_DIR, "session.json");

describe("cookie-cache", () => {
  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) {
      await mkdir(TEST_DIR, { recursive: true });
    }
  });

  afterEach(async () => {
    try {
      await unlink(TEST_CACHE);
    } catch {
      // ignore
    }
  });

  it("returns null when cache file does not exist", async () => {
    const result = await readCachedSession("/nonexistent/path/session.json");
    expect(result).toBeNull();
  });

  it("writes and reads a session cookie", async () => {
    const cookie = "test-smsession-value-123";
    await writeCachedSession(TEST_CACHE, cookie);

    const result = await readCachedSession(TEST_CACHE);
    expect(result).toBe(cookie);
  });

  it("returns null when session is expired", async () => {
    const cookie = "expired-cookie";
    await writeCachedSession(TEST_CACHE, cookie);

    // Read with 0 TTL = always expired
    const result = await readCachedSession(TEST_CACHE, 0);
    expect(result).toBeNull();
  });

  it("persists session data as JSON", async () => {
    const cookie = "persist-test";
    await writeCachedSession(TEST_CACHE, cookie, "test.example.com");

    const raw = await readFile(TEST_CACHE, "utf-8");
    const data = JSON.parse(raw);
    expect(data.smsession).toBe(cookie);
    expect(data.capturedFor).toBe("test.example.com");
    expect(typeof data.cachedAt).toBe("number");
  });

  it("clears cached session", async () => {
    await writeCachedSession(TEST_CACHE, "to-be-cleared");
    expect(existsSync(TEST_CACHE)).toBe(true);

    await clearCachedSession(TEST_CACHE);
    expect(existsSync(TEST_CACHE)).toBe(false);
  });

  it("clearCachedSession does not throw if file does not exist", async () => {
    await expect(
      clearCachedSession("/nonexistent/file.json")
    ).resolves.toBeUndefined();
  });
});
