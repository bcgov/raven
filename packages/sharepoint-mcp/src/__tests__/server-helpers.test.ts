import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, stat, readFile, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatBytes,
  formatSearchHit,
  describeSpoError,
  truncateText,
  mimeFromExtension,
  serverRelativePath,
  writeProtectedDownload,
} from "../server.js";
import { SpoApiError } from "../types.js";

describe("formatBytes", () => {
  it("formats sizes at sensible units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatSearchHit", () => {
  it("renders title, link, metadata, and summary", () => {
    const line = formatSearchHit(
      {
        title: "Design Doc",
        path: "https://example.sharepoint.com/sites/p/Docs/d.docx",
        author: "Jane Smith",
        modified: "2026-05-01T10:00:00Z",
        summary: "The design covers … the API.",
        fileType: "docx",
      },
      0
    );
    expect(line).toContain("1. **Design Doc**");
    expect(line).toContain("https://example.sharepoint.com/sites/p/Docs/d.docx");
    expect(line).toContain("docx");
    expect(line).toContain("The design covers");
  });
});

describe("describeSpoError", () => {
  it("words 403 as a permissions problem, not auth failure", () => {
    expect(describeSpoError(new SpoApiError("x", 403))).toContain("don't have access");
  });
  it("words 404 as not found", () => {
    expect(describeSpoError(new SpoApiError("x", 404))).toContain("Not found");
  });
  it("falls back to the scrubbed message otherwise", () => {
    expect(describeSpoError(new Error("boom"))).toContain("boom");
  });
});

describe("truncateText", () => {
  it("passes short text through unchanged", () => {
    expect(truncateText("hello", 50)).toBe("hello");
  });
  it("truncates long text with an explicit notice", () => {
    const out = truncateText("x".repeat(100), 10);
    expect(out.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("[truncated — showing 10 of 100 characters]");
  });
});

describe("mimeFromExtension", () => {
  it("maps the formats read_document routes on", () => {
    expect(mimeFromExtension("a.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeFromExtension("a.pdf")).toBe("application/pdf");
    expect(mimeFromExtension("a.PNG")).toBe("image/png");
    expect(mimeFromExtension("a.jpeg")).toBe("image/jpeg");
    expect(mimeFromExtension("notes.md")).toBe("text/plain");
    expect(mimeFromExtension("a.bin")).toBe("application/octet-stream");
  });
});

describe("serverRelativePath", () => {
  it("accepts paths starting with '/'", () => {
    const schema = serverRelativePath("a file path");
    expect(schema.safeParse("/sites/P/Shared Documents/a.docx").success).toBe(true);
  });

  it("rejects relative paths", () => {
    const schema = serverRelativePath("a file path");
    expect(schema.safeParse("Shared Documents/a.docx").success).toBe(false);
    expect(schema.safeParse("").success).toBe(false);
  });
});

describe("writeProtectedDownload", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "spo-dl-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes the file with mode 0600 in a 0700 directory", async () => {
    const sub = join(dir, "downloads");
    const target = await writeProtectedDownload(sub, "a.pdf", new Uint8Array([1, 2]));
    expect((await stat(sub)).mode & 0o777).toBe(0o700);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(target).toBe(join(sub, "a.pdf"));
  });

  it("re-tightens a pre-existing directory to 0700", async () => {
    const sub = join(dir, "downloads");
    await mkdir(sub, { recursive: true, mode: 0o755 });
    await writeProtectedDownload(sub, "a.pdf", new Uint8Array([1]));
    expect((await stat(sub)).mode & 0o777).toBe(0o700);
  });

  it("overwrites an existing regular file with fresh bytes", async () => {
    await writeProtectedDownload(dir, "a.pdf", new Uint8Array([1]));
    const target = await writeProtectedDownload(dir, "a.pdf", new Uint8Array([9, 9]));
    expect((await readFile(target)).length).toBe(2);
  });

  it("refuses to write through a symlink", async () => {
    const outside = join(dir, "outside.txt");
    await writeFile(outside, "x");
    const sub = join(dir, "downloads");
    await mkdir(sub, { recursive: true, mode: 0o700 });
    await symlink(outside, join(sub, "a.pdf"));
    await expect(
      writeProtectedDownload(sub, "a.pdf", new Uint8Array([1]))
    ).rejects.toThrow(/regular file/i);
  });

  it("sanitizes traversal attempts in the filename", async () => {
    const target = await writeProtectedDownload(dir, "../../evil.sh", new Uint8Array([1]));
    expect(target).toBe(join(dir, "evil.sh"));
  });
});
