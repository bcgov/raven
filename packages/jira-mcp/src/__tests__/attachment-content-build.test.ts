import { describe, it, expect, vi } from "vitest";

vi.mock("pdf-parse/lib/pdf-parse.js", () => ({
  default: vi.fn(async () => ({ text: "extracted pdf text", numpages: 1, info: {}, metadata: {}, version: "" })),
}));

import { extractPdfText, buildAttachmentContent } from "../attachment-content.js";

describe("extractPdfText", () => {
  it("returns the text from a pdf buffer", async () => {
    const out = await extractPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(out).toBe("extracted pdf text");
  });
});

describe("buildAttachmentContent", () => {
  const upper = (s: string) => s.toUpperCase(); // stand-in scrub: proves scrubbing is applied

  it("image → header + image block, bytes not scrubbed", async () => {
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08]);
    const out = await buildAttachmentContent(
      { filename: "a.png", mimeType: "image/png", size: 3 }, bytes, "/x/a.png", upper);
    expect(out[0].type).toBe("text");
    expect(out[1]).toEqual({
      type: "image",
      data: Buffer.from(bytes).toString("base64"),
      mimeType: "image/png",
    });
  });

  it("text → scrubbed full text", async () => {
    const bytes = new TextEncoder().encode("hello");
    const out = await buildAttachmentContent(
      { filename: "a.txt", mimeType: "text/plain", size: 5 }, bytes, "/x/a.txt", upper);
    expect(out[1]).toEqual({ type: "text", text: "HELLO" });
  });

  it("pdf → scrubbed extracted text", async () => {
    const out = await buildAttachmentContent(
      { filename: "a.pdf", mimeType: "application/pdf", size: 10 }, new Uint8Array([0]), "/x/a.pdf", upper);
    expect(out[1]).toEqual({ type: "text", text: "EXTRACTED PDF TEXT" });
  });

  it("other → disk-only note", async () => {
    const out = await buildAttachmentContent(
      { filename: "a.mp4", mimeType: "video/mp4", size: 99 }, new Uint8Array([0]), "/x/a.mp4", upper);
    expect(out[1].type).toBe("text");
    expect((out[1] as { type: "text"; text: string }).text).toContain("Inline preview not available");
  });
});
