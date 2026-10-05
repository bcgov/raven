import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-file.js";
import {
  AUTH_FAILURE_COOLDOWN_MS,
  clearAuthFailure,
  readRecentAuthFailure,
  recordAuthFailure,
} from "../auth-failure-memo.js";

// Wrap the atomic writer (still the real one) so a test can see that this
// module writes through it. A plain writeFile would pass every other test here.
vi.mock("../atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../atomic-file.js")>();
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) };
});

describe("auth failure memo", () => {
  let dir: string;
  let memoPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "auth-failure-"));
    memoPath = join(dir, "browser-profile.lock.siteminder-failed");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lasts the 30 seconds the documentation promises", async () => {
    expect(AUTH_FAILURE_COOLDOWN_MS).toBe(30_000);
    await writeFile(memoPath, JSON.stringify({ at: Date.now() - 29_000, message: "just inside" }));
    expect(await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS)).not.toBeNull();
    await writeFile(memoPath, JSON.stringify({ at: Date.now() - 31_000, message: "just outside" }));
    expect(await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS)).toBeNull();
  });

  it("writes the memo atomically, so a sibling reading it never sees a partial file", async () => {
    await recordAuthFailure(memoPath, "window closed");

    expect(writeFileAtomic).toHaveBeenCalledWith(memoPath, expect.stringContaining("window closed"));
  });

  it("returns what was recorded while it is recent", async () => {
    await recordAuthFailure(memoPath, "Cookies not captured within 120s: SMSESSION");

    const recent = await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS);

    expect(recent?.message).toBe("Cookies not captured within 120s: SMSESSION");
    expect(Date.now() - (recent?.at ?? 0)).toBeLessThan(5_000);
  });

  it("returns null once the cooldown has passed", async () => {
    await writeFile(memoPath, JSON.stringify({ at: Date.now() - AUTH_FAILURE_COOLDOWN_MS - 1_000, message: "old" }));
    expect(await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS)).toBeNull();
  });

  it("returns null when nothing was recorded", async () => {
    expect(await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS)).toBeNull();
  });

  it.each([
    ["unparseable", "{not json"],
    ["not a record", "null"],
    ["missing its time", JSON.stringify({ message: "x" })],
    ["with a non-numeric time", JSON.stringify({ at: "yesterday", message: "x" })],
    ["stamped far in the future", JSON.stringify({ at: Date.now() + 3_600_000, message: "x" })],
  ])("ignores a memo file that is %s, so a bad file can never block a login", async (_name, contents) => {
    await writeFile(memoPath, contents);
    expect(await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS)).toBeNull();
  });

  it("keeps only a bounded first line of the message", async () => {
    await recordAuthFailure(memoPath, `first line\nsecond line ${"x".repeat(1_000)}`);

    const recent = await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS);

    expect(recent?.message).toBe("first line");
    await recordAuthFailure(memoPath, "y".repeat(5_000));
    expect((await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS))?.message.length).toBeLessThanOrEqual(200);
  });

  it("replaces an earlier memo", async () => {
    await recordAuthFailure(memoPath, "first");
    await recordAuthFailure(memoPath, "second");
    expect((await readRecentAuthFailure(memoPath, AUTH_FAILURE_COOLDOWN_MS))?.message).toBe("second");
  });

  it("clears the memo, and clearing nothing is not an error", async () => {
    await recordAuthFailure(memoPath, "x");
    await clearAuthFailure(memoPath);
    expect(existsSync(memoPath)).toBe(false);
    await expect(clearAuthFailure(memoPath)).resolves.toBeUndefined();
  });

  it("never throws when it cannot record: a memo is a courtesy, not part of the login", async () => {
    const blocker = join(dir, "not-a-directory");
    await writeFile(blocker, "");
    await expect(recordAuthFailure(join(blocker, "memo"), "x")).resolves.toBeUndefined();
  });

  it("stores no more than the time and the message", async () => {
    await recordAuthFailure(memoPath, "x");
    expect(Object.keys(JSON.parse(await readFile(memoPath, "utf-8"))).sort()).toEqual(["at", "message"]);
  });
});
