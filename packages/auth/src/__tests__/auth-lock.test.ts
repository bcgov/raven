import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAuthLock } from "../auth-lock.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const FAST = { pollMs: 10, waitMs: 2_000, staleMs: 60_000 };

describe("withAuthLock", () => {
  let dir: string;
  let lockPath: string;

  const holdLock = (holder: { pid: number; at: number }) =>
    writeFile(lockPath, JSON.stringify({ ...holder, token: "someone-else" }));

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "auth-lock-"));
    lockPath = join(dir, "browser-profile.lock");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the function and removes the lock afterwards", async () => {
    const result = await withAuthLock(lockPath, async () => {
      expect(existsSync(lockPath)).toBe(true);
      return "done";
    }, FAST);

    expect(result).toBe("done");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("serialises callers so only one owns the profile at a time", async () => {
    // Two MCP servers hitting session expiry together both want the one
    // Chromium profile; Chromium lets only a single process own it.
    let active = 0;
    let peak = 0;
    const critical = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await sleep(40);
      active -= 1;
    };

    await Promise.all([
      withAuthLock(lockPath, critical, FAST),
      withAuthLock(lockPath, critical, FAST),
      withAuthLock(lockPath, critical, FAST),
    ]);

    expect(peak).toBe(1);
  });

  it("releases the lock when the function throws and propagates the error", async () => {
    await expect(
      withAuthLock(lockPath, async () => {
        throw new Error("login window closed");
      }, FAST)
    ).rejects.toThrow("login window closed");

    expect(existsSync(lockPath)).toBe(false);
    await expect(withAuthLock(lockPath, async () => "next", FAST)).resolves.toBe("next");
  });

  it("takes over a lock whose owner process has died", async () => {
    const dead = spawnSync(process.execPath, ["-e", ""]);
    await holdLock({ pid: dead.pid, at: Date.now() });

    await expect(withAuthLock(lockPath, async () => "ran", FAST)).resolves.toBe("ran");
  });

  it("takes over a lock that is older than the stale limit even if the pid looks alive", async () => {
    // A recycled pid must not wedge every later login.
    await holdLock({ pid: process.pid, at: Date.now() - 10_000 });

    await expect(
      withAuthLock(lockPath, async () => "ran", { ...FAST, staleMs: 1_000 })
    ).resolves.toBe("ran");
  });

  it("takes over an empty lock left by an owner that died before writing its record", async () => {
    await writeFile(lockPath, "");
    const longAgo = new Date(Date.now() - 10_000);
    await utimes(lockPath, longAgo, longAgo);

    await expect(
      withAuthLock(lockPath, async () => "ran", { ...FAST, staleMs: 1_000 })
    ).resolves.toBe("ran");
  });

  it("does not steal a just-created lock whose record is not written yet", async () => {
    await writeFile(lockPath, "");

    await expect(
      withAuthLock(lockPath, async () => "never", { ...FAST, waitMs: 120 })
    ).rejects.toThrow(/another RAVEN process/i);
  });

  describe("stale-lock reclamation", () => {
    const deadOwner = () => spawnSync(process.execPath, ["-e", ""]).pid;
    const reapPath = () => `${lockPath}.reap`;

    it("never lets two waiters both reclaim the same stale lock and enter together", async () => {
      // Reclaiming is check-then-unlink; unserialised, a slow waiter could
      // unlink the lock a faster one had just taken, putting two processes in
      // the critical section (two Chromiums on one profile).
      for (let round = 0; round < 5; round += 1) {
        await holdLock({ pid: deadOwner(), at: Date.now() });
        let active = 0;
        let peak = 0;
        const critical = async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(15);
          active -= 1;
        };

        await Promise.all(
          Array.from({ length: 8 }, () => withAuthLock(lockPath, critical, FAST))
        );

        expect(peak).toBe(1);
      }
    });

    it("leaves a stale lock alone while another process holds the reclaim lease", async () => {
      await holdLock({ pid: deadOwner(), at: Date.now() });
      await writeFile(reapPath(), JSON.stringify({ pid: process.pid, at: Date.now() }));

      await expect(
        withAuthLock(lockPath, async () => "never", { ...FAST, waitMs: 150 })
      ).rejects.toThrow(/another RAVEN process/i);

      expect(existsSync(lockPath)).toBe(true);
    });

    it("clears an abandoned reclaim lease and then reclaims", async () => {
      await holdLock({ pid: deadOwner(), at: Date.now() });
      await writeFile(reapPath(), "");
      const longAgo = new Date(Date.now() - 120_000);
      await utimes(reapPath(), longAgo, longAgo);

      await expect(withAuthLock(lockPath, async () => "ran", FAST)).resolves.toBe("ran");
    });

    it("leaves no reclaim lease behind", async () => {
      await holdLock({ pid: deadOwner(), at: Date.now() });

      await withAuthLock(lockPath, async () => {}, FAST);

      expect(existsSync(reapPath())).toBe(false);
      expect(existsSync(lockPath)).toBe(false);
    });
  });

  it("waits for a live owner and proceeds once it releases", async () => {
    await holdLock({ pid: process.pid, at: Date.now() });
    const release = sleep(100).then(() => unlink(lockPath));

    const started = Date.now();
    await expect(withAuthLock(lockPath, async () => "ran", FAST)).resolves.toBe("ran");
    await release;

    expect(Date.now() - started).toBeGreaterThanOrEqual(80);
  });

  it("gives up with a clear error if the owner never releases, leaving its lock alone", async () => {
    await holdLock({ pid: process.pid, at: Date.now() });

    await expect(
      withAuthLock(lockPath, async () => "never", { ...FAST, waitMs: 150 })
    ).rejects.toThrow(/another RAVEN process/i);

    expect(JSON.parse(await readFile(lockPath, "utf-8")).token).toBe("someone-else");
  });
});
