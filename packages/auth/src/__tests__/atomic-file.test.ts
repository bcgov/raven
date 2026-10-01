import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Inject failures into rename; zero means pass straight through to the real one. */
const faults = vi.hoisted(() => ({ rename: 0, renameCode: "EPERM" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      if (faults.rename > 0) {
        faults.rename -= 1;
        throw Object.assign(new Error(`${faults.renameCode}: injected fault`), { code: faults.renameCode });
      }
      return actual.rename(...args);
    }) as typeof actual.rename,
  };
});

import { writeFileAtomic } from "../atomic-file.js";

describe("writeFileAtomic", () => {
  let dir: string;
  let target: string;

  const withPlatform = async (platform: string, fn: () => Promise<void>) => {
    const original = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
    Object.defineProperty(process, "platform", { value: platform });
    try {
      await fn();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "atomic-file-"));
    target = join(dir, "nested", "data.json");
  });

  afterEach(async () => {
    faults.rename = 0;
    faults.renameCode = "EPERM";
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the parent directory and writes the contents", async () => {
    await writeFileAtomic(target, '{"a":1}');
    expect(await readFile(target, "utf-8")).toBe('{"a":1}');
  });

  it.skipIf(process.platform === "win32")("creates the directory 0700 and the file 0600", async () => {
    await writeFileAtomic(target, "x");
    expect((await stat(join(dir, "nested"))).mode & 0o777).toBe(0o700);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
  });

  it("leaves no temporary file behind", async () => {
    await writeFileAtomic(target, "x");
    await writeFileAtomic(target, "y");
    expect(await readdir(join(dir, "nested"))).toEqual(["data.json"]);
  });

  it("never lets a concurrent reader observe a partial file", async () => {
    // A plain writeFile truncates in place, so a reader that lands mid-write
    // sees an empty or partial file. The payload is large so that window is
    // wide enough to be hit reliably if the write is not atomic.
    const payload = (n: number) => JSON.stringify({ n, pad: "x".repeat(6_000_000) });
    await writeFileAtomic(target, payload(-1));

    let writing = true;
    const torn: string[] = [];
    const reader = (async () => {
      while (writing) {
        try {
          JSON.parse(await readFile(target, "utf-8"));
        } catch (err) {
          torn.push(String(err).slice(0, 80));
        }
      }
    })();
    for (let n = 0; n < 15; n += 1) await writeFileAtomic(target, payload(n));
    writing = false;
    await reader;

    expect(torn).toEqual([]);
  });

  it("keeps the previous file intact and cleans up when the rename fails for good", async () => {
    await writeFileAtomic(target, "old");
    faults.rename = 99;
    faults.renameCode = "EXDEV";

    await expect(writeFileAtomic(target, "new")).rejects.toThrow(/EXDEV/);

    faults.rename = 0;
    expect(await readFile(target, "utf-8")).toBe("old");
    expect(await readdir(join(dir, "nested"))).toEqual(["data.json"]);
  });

  it("retries a transient Windows rename error (another process has the file open)", async () => {
    await writeFileAtomic(target, "old");
    faults.rename = 2;

    await withPlatform("win32", () => writeFileAtomic(target, "new"));

    expect(await readFile(target, "utf-8")).toBe("new");
  });

  it("gives up on a Windows rename error that never clears", async () => {
    await writeFileAtomic(target, "old");
    faults.rename = 99;

    await withPlatform("win32", async () => {
      await expect(writeFileAtomic(target, "new")).rejects.toThrow(/EPERM/);
    });

    faults.rename = 0;
    expect(await readFile(target, "utf-8")).toBe("old");
    expect(await readdir(join(dir, "nested"))).toEqual(["data.json"]);
  });

  it.skipIf(process.platform === "win32")("does not retry EPERM on platforms where it is a real permission error", async () => {
    await writeFile(join(dir, "marker"), "");
    faults.rename = 1;

    await expect(writeFileAtomic(target, "x")).rejects.toThrow(/EPERM/);
  });
});
