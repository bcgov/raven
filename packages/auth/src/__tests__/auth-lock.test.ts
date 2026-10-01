import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAuthLock } from "../auth-lock.js";

/**
 * Fault injection for the lock's file operations. Every counter is zero by
 * default, so the wrapped module behaves exactly like the real one; tests set
 * a counter immediately before the call that should hit the fault.
 */
const faults = vi.hoisted(() => ({
  lockWrite: 0, // fail the next N lock-record writes with ENOSPC
  leaseWrite: 0, // fail the next N reclaim-lease writes with ENOSPC
  readLock: 0, // fail the next N reads of the lock file with EMFILE
  unlink: 0, // fail the next N unlinks of the lock file
  unlinkCode: "EBUSY",
  openBusy: [] as string[], // error codes thrown by the next exclusive opens of the lock path
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const injected = (code: string) => Object.assign(new Error(`${code}: injected fault`), { code });
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const [path, flags] = args;
      const target = String(path);
      if (flags === "wx" && target.endsWith(".lock") && faults.openBusy.length) {
        throw injected(faults.openBusy.shift() as string);
      }
      const handle = await actual.open(...args);
      if (flags === "wx") {
        const isLease = target.endsWith(".reap");
        if ((isLease ? faults.leaseWrite : faults.lockWrite) > 0) {
          if (isLease) faults.leaseWrite -= 1;
          else faults.lockWrite -= 1;
          handle.writeFile = (async () => {
            throw injected("ENOSPC");
          }) as typeof handle.writeFile;
        }
      }
      return handle;
    }) as typeof actual.open,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      if (faults.readLock > 0 && String(args[0]).endsWith(".lock")) {
        faults.readLock -= 1;
        throw injected("EMFILE");
      }
      return actual.readFile(...args);
    }) as typeof actual.readFile,
    unlink: (async (...args: Parameters<typeof actual.unlink>) => {
      if (faults.unlink > 0 && String(args[0]).endsWith(".lock")) {
        faults.unlink -= 1;
        throw injected(faults.unlinkCode);
      }
      return actual.unlink(...args);
    }) as typeof actual.unlink,
  };
});

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
    vi.restoreAllMocks();
    faults.lockWrite = 0;
    faults.leaseWrite = 0;
    faults.readLock = 0;
    faults.unlink = 0;
    faults.unlinkCode = "EBUSY";
    faults.openBusy = [];
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

  describe("failure handling", () => {
    it("does not leave a lock behind when writing the lock record fails", async () => {
      // An empty lock is judged only by mtime, so a leaked one blocks every
      // other process for the full stale limit although nobody is logging in.
      faults.lockWrite = 1;

      await expect(withAuthLock(lockPath, async () => "never", FAST)).rejects.toThrow(/ENOSPC/);

      expect(existsSync(lockPath)).toBe(false);
      await expect(withAuthLock(lockPath, async () => "next", FAST)).resolves.toBe("next");
    });

    it("gives up after waitMs when a stale lock cannot be removed, instead of spinning forever", async () => {
      // A directory at the lock path can never be unlinked. Reporting that
      // as "removed" sent the acquire loop round again with no sleep and no
      // deadline check, so the caller hung at 100% CPU.
      await mkdir(lockPath);
      await writeFile(join(lockPath, "occupant"), "");
      const longAgo = new Date(Date.now() - 120_000);
      await utimes(lockPath, longAgo, longAgo);

      const started = Date.now();
      await expect(
        withAuthLock(lockPath, async () => "never", { ...FAST, staleMs: 1_000, waitMs: 300 })
      ).rejects.toThrow(/another RAVEN process/i);

      expect(Date.now() - started).toBeLessThan(3_000);
    });

    it("keeps polling when creating the lock fails with a Windows sharing error", async () => {
      faults.openBusy = ["EPERM"];
      const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
      Object.defineProperty(process, "platform", { value: "win32" });
      try {
        await expect(withAuthLock(lockPath, async () => "ran", FAST)).resolves.toBe("ran");
      } finally {
        Object.defineProperty(process, "platform", platform);
      }
    });

    it.skipIf(process.platform === "win32")(
      "still treats the same error as fatal on platforms where EEXIST is the only busy signal",
      async () => {
        faults.openBusy = ["EPERM"];
        await expect(withAuthLock(lockPath, async () => "never", FAST)).rejects.toThrow(/EPERM/);
      }
    );

    it("retries releasing the lock when the first read or unlink fails transiently", async () => {
      await withAuthLock(
        lockPath,
        async () => {
          faults.readLock = 1;
          faults.unlink = 1;
          return "ok";
        },
        FAST
      );

      expect(existsSync(lockPath)).toBe(false);
    });

    it("gives up quietly, without throwing, when the lock can never be removed", async () => {
      faults.unlinkCode = "EPERM";
      const result = await withAuthLock(
        lockPath,
        async () => {
          faults.unlink = 99;
          return "result";
        },
        FAST
      );

      expect(result).toBe("result");
      faults.unlink = 0;
    });

    it("does not remove a lock that now belongs to someone else", async () => {
      await withAuthLock(
        lockPath,
        async () => {
          await writeFile(lockPath, JSON.stringify({ pid: process.pid, at: Date.now(), token: "takeover" }));
        },
        FAST
      );

      expect(JSON.parse(await readFile(lockPath, "utf-8")).token).toBe("takeover");
    });

    it("treats EPERM from the liveness probe as an existing process, not a dead owner", async () => {
      await holdLock({ pid: 999_999, at: Date.now() });
      const realKill = process.kill.bind(process);
      vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
        if (pid === 999_999 && signal === 0) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        return realKill(pid, signal as never);
      }) as typeof process.kill);

      await expect(
        withAuthLock(lockPath, async () => "never", { ...FAST, waitMs: 150 })
      ).rejects.toThrow(/another RAVEN process/i);

      expect(JSON.parse(await readFile(lockPath, "utf-8")).token).toBe("someone-else");
    });

    it("cleans up the reclaim lease when writing it fails, and reclaims on the next poll", async () => {
      await holdLock({ pid: spawnSync(process.execPath, ["-e", ""]).pid, at: Date.now() });
      faults.leaseWrite = 1;

      await expect(withAuthLock(lockPath, async () => "ran", FAST)).resolves.toBe("ran");

      expect(existsSync(`${lockPath}.reap`)).toBe(false);
    });
  });

  it("waits for a live owner and runs only after it releases", async () => {
    // Order, not elapsed time: a duration measured after awaiting the release
    // timer is at least that long whether or not the waiter actually waited.
    await holdLock({ pid: process.pid, at: Date.now() });
    const events: string[] = [];
    const release = sleep(100).then(async () => {
      events.push("released");
      await unlink(lockPath);
    });

    await expect(
      withAuthLock(
        lockPath,
        async () => {
          events.push("ran");
          return "ran";
        },
        FAST
      )
    ).resolves.toBe("ran");
    await release;

    expect(events).toEqual(["released", "ran"]);
  });

  it("tells the caller once, when it has to wait for a live owner", async () => {
    // A login can take minutes; without a notice the waiter looks hung.
    await holdLock({ pid: process.pid, at: Date.now() });
    const onWait = vi.fn();
    const release = sleep(120).then(() => unlink(lockPath));

    await withAuthLock(lockPath, async () => "ran", { ...FAST, onWait });
    await release;

    expect(onWait).toHaveBeenCalledTimes(1);
  });

  it("does not call onWait when the lock is free", async () => {
    const onWait = vi.fn();
    await withAuthLock(lockPath, async () => "ran", { ...FAST, onWait });
    expect(onWait).not.toHaveBeenCalled();
  });

  it("does not call onWait for a lock it reclaims because its owner died", async () => {
    await holdLock({ pid: spawnSync(process.execPath, ["-e", ""]).pid, at: Date.now() });
    const onWait = vi.fn();

    await withAuthLock(lockPath, async () => "ran", { ...FAST, onWait });

    expect(onWait).not.toHaveBeenCalled();
  });

  it("gives up with a clear error if the owner never releases, leaving its lock alone", async () => {
    await holdLock({ pid: process.pid, at: Date.now() });

    await expect(
      withAuthLock(lockPath, async () => "never", { ...FAST, waitMs: 150 })
    ).rejects.toThrow(/another RAVEN process/i);

    expect(JSON.parse(await readFile(lockPath, "utf-8")).token).toBe("someone-else");
  });
});
