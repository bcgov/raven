import { describe, it, expect } from "vitest";
import { sanitizeFilename, classifyAttachment, decodeUtf8, disambiguateFilename } from "../attachment-content.js";

describe("sanitizeFilename", () => {
  it("reduces path/traversal input to a safe basename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a/b/c.png")).toBe("c.png");
    expect(sanitizeFilename("..\\..\\win.txt")).toBe("win.txt");
  });
  it("falls back to 'attachment' for empty or dot-only names", () => {
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename("..")).toBe("attachment");
    expect(sanitizeFilename(".")).toBe("attachment");
  });
  it("preserves a legitimate dotfile name", () => {
    expect(sanitizeFilename(".env")).toBe(".env");
  });
  it("preserves spaces and hyphens in normal filenames", () => {
    expect(sanitizeFilename("my file-name (2).png")).toBe("my file-name (2).png");
  });
});

describe("classifyAttachment", () => {
  it("detects images", () => {
    expect(classifyAttachment("image/png", "x.png")).toBe("image");
    expect(classifyAttachment("image/jpeg", "x.jpg")).toBe("image");
  });
  it("detects pdf by mime or extension", () => {
    expect(classifyAttachment("application/pdf", "x.pdf")).toBe("pdf");
    expect(classifyAttachment("application/octet-stream", "report.pdf")).toBe("pdf");
  });
  it("detects text-like content", () => {
    expect(classifyAttachment("text/plain", "log.txt")).toBe("text");
    expect(classifyAttachment("application/json", "d.json")).toBe("text");
    expect(classifyAttachment("application/octet-stream", "server.log")).toBe("text");
  });
  it("falls back to 'other' for binary/office types", () => {
    expect(classifyAttachment("application/vnd.ms-excel", "x.xlsx")).toBe("other");
    expect(classifyAttachment("video/mp4", "x.mp4")).toBe("other");
  });
});

describe("decodeUtf8", () => {
  it("decodes UTF-8 bytes to a string", () => {
    expect(decodeUtf8(new TextEncoder().encode("héllo"))).toBe("héllo");
  });
});

describe("disambiguateFilename", () => {
  it("returns the sanitized name when unused", () => {
    const used = new Set<string>();
    expect(disambiguateFilename("image.png", "4271", used)).toBe("image.png");
  });
  it("suffixes the id before the extension on collision", () => {
    const used = new Set<string>(["image.png"]);
    expect(disambiguateFilename("image.png", "4271", used)).toBe("image-4271.png");
  });
  it("suffixes at the end when there is no extension", () => {
    const used = new Set<string>(["README"]);
    expect(disambiguateFilename("README", "99", used)).toBe("README-99");
  });
  it("tracks names it returns so repeated calls stay unique", () => {
    const used = new Set<string>();
    expect(disambiguateFilename("a.png", "1", used)).toBe("a.png");
    expect(disambiguateFilename("a.png", "2", used)).toBe("a-2.png");
  });
  it("guarantees uniqueness when the disambiguated name also collides", () => {
    const used = new Set<string>(["image.png", "image-4271.png"]);
    expect(disambiguateFilename("image.png", "4271", used)).toBe("image-4271-2.png");
  });
  it("treats collisions case-insensitively (case-insensitive filesystems)", () => {
    const used = new Set<string>();
    expect(disambiguateFilename("Fam.pdf", "1", used)).toBe("Fam.pdf");
    expect(disambiguateFilename("FAM.pdf", "2", used)).toBe("FAM-2.pdf");
  });
});
