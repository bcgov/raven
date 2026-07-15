import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAttachment } from "../attachment-fs.js";

describe("saveAttachment", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  async function tmp(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "raven-att-"));
    dirs.push(d);
    return d;
  }

  it("writes bytes into destDir and returns the path", async () => {
    const dir = await tmp();
    const p = await saveAttachment(new TextEncoder().encode("hello"), "note.txt", dir);
    expect(p).toBe(join(dir, "note.txt"));
    expect(await readFile(p, "utf-8")).toBe("hello");
  });

  it("sanitizes traversal filenames into the destDir basename", async () => {
    const dir = await tmp();
    const p = await saveAttachment(new Uint8Array([1, 2, 3]), "../../evil.bin", dir);
    expect(p).toBe(join(dir, "evil.bin"));
  });

  it("writes with 0600 permissions", async () => {
    const dir = await tmp();
    const p = await saveAttachment(new Uint8Array([0]), "x.bin", dir);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });
});
