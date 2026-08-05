import { describe, it, expect, vi } from "vitest";

// Mock mammoth: unit tests verify our wiring (options, conversion pipeline,
// error fallback). Real .docx parsing is mammoth's job, covered upstream and
// by the manual smoke test.
vi.mock("mammoth", () => ({
  default: {
    convertToHtml: vi.fn(async ({ buffer }: { buffer: Buffer }) => {
      if (buffer.toString("utf-8").startsWith("BAD")) {
        throw new Error("not a docx");
      }
      return { value: "<h1>Design</h1><p>Body <strong>text</strong>.</p>", messages: [] };
    }),
  },
}));

import { extractDocxMarkdown } from "../extractors/docx.js";
import { extractPageMarkdown } from "../extractors/page-canvas.js";

describe("extractDocxMarkdown", () => {
  it("converts docx HTML output to markdown", async () => {
    const md = await extractDocxMarkdown(new TextEncoder().encode("FAKE-DOCX"));
    expect(md).toContain("# Design");
    expect(md).toContain("**text**");
  });

  it("throws a labeled error when mammoth cannot parse the bytes", async () => {
    await expect(
      extractDocxMarkdown(new TextEncoder().encode("BAD-BYTES"))
    ).rejects.toThrow(/docx extraction failed/);
  });
});

describe("extractPageMarkdown", () => {
  it("extracts text-webpart content from CanvasContent1 markup", () => {
    const canvas =
      '<div data-sp-canvascontrol="" data-sp-canvasdataversion="1.0">' +
      '<div data-sp-rte=""><h2>Decisions</h2><p>We chose <em>option B</em>.</p></div>' +
      "</div>" +
      '<div data-sp-canvascontrol="" data-sp-webpartdata="{&quot;id&quot;:&quot;x&quot;}"></div>';
    const md = extractPageMarkdown(canvas);
    expect(md).toContain("## Decisions");
    expect(md).toContain("*option B*");
  });

  it("returns an empty string for empty or non-HTML canvas content", () => {
    expect(extractPageMarkdown("")).toBe("");
    expect(extractPageMarkdown("   ")).toBe("");
  });
});
