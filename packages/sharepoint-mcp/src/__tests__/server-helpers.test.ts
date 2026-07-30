import { describe, it, expect } from "vitest";
import { formatBytes, formatSearchHit, describeSpoError, truncateText, mimeFromExtension } from "../server.js";
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
