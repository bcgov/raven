import { describe, it, expect } from "vitest";
import { sliceFileContent } from "../file-slice.js";

/** Build deterministic multi-line content: "line 0001 xxx…" per line. */
function makeLines(count: number, width = 40): string {
  return Array.from(
    { length: count },
    (_, i) => `line ${String(i + 1).padStart(4, "0")} ${"x".repeat(width)}`
  ).join("\n");
}

describe("sliceFileContent", () => {
  it("returns the whole file untouched when under the cap with no range", () => {
    const content = makeLines(10);
    const r = sliceFileContent(content, { maxChars: 50_000 });
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toBe(content);
    expect(r.firstLine).toBe(1);
    expect(r.lastLine).toBe(10);
    expect(r.totalLines).toBe(10);
    expect(r.totalChars).toBe(content.length);
    expect(r.truncated).toBe(false);
    expect(r.nextStartLine).toBeUndefined();
  });

  it("returns exactly the requested inclusive mid-file range", () => {
    const content = makeLines(10);
    const lines = content.split("\n");
    const r = sliceFileContent(content, { startLine: 3, endLine: 5, maxChars: 50_000 });
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toBe(lines.slice(2, 5).join("\n"));
    expect(r.firstLine).toBe(3);
    expect(r.lastLine).toBe(5);
    expect(r.truncated).toBe(false);
    expect(r.nextStartLine).toBe(6);
  });

  it("reads a >10 KB file in full via startLine paging with no lost content", () => {
    const content = makeLines(400); // ~18 KB
    expect(content.length).toBeGreaterThan(10_000);
    const chunks: string[] = [];
    let start: number | undefined = 1;
    let guard = 0;
    while (start !== undefined) {
      if (++guard > 50) throw new Error("paging did not terminate");
      const r = sliceFileContent(content, { startLine: start, maxChars: 5_000 });
      if (!r.ok) throw new Error(r.message);
      expect(r.partialLastLine).toBe(false); // cap must cut on line boundaries here
      chunks.push(r.text);
      start = r.nextStartLine;
    }
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("\n")).toBe(content);
  });

  it("truncates at the cap on a line boundary and reports totals and resume point", () => {
    const content = makeLines(2_000); // ~90 KB
    const r = sliceFileContent(content, { maxChars: 50_000 });
    if (!r.ok) throw new Error(r.message);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(50_000);
    expect(r.partialLastLine).toBe(false);
    expect(r.totalChars).toBe(content.length);
    expect(r.totalLines).toBe(2_000);
    expect(r.nextStartLine).toBe(r.lastLine + 1);
    // Resuming from nextStartLine yields the remainder exactly.
    const rest = sliceFileContent(content, {
      startLine: r.nextStartLine,
      maxChars: 200_000,
    });
    if (!rest.ok) throw new Error(rest.message);
    expect(`${r.text}\n${rest.text}`).toBe(content);
  });

  it("rejects startLine > endLine with a clear message", () => {
    const r = sliceFileContent(makeLines(10), {
      startLine: 10,
      endLine: 5,
      maxChars: 50_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toBe("invalid-range");
    expect(r.message).toContain("startLine=10");
    expect(r.message).toContain("endLine=5");
  });

  it("rejects startLine past end of file, reporting the file's line count", () => {
    const r = sliceFileContent(makeLines(10), { startLine: 11, maxChars: 50_000 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected failure");
    expect(r.reason).toBe("past-eof");
    expect(r.message).toContain("10");
  });

  it("emits a partial line when a single line exceeds the cap", () => {
    const content = `short first line\n${"y".repeat(3_000)}\nshort last line`;
    const r = sliceFileContent(content, { startLine: 2, endLine: 2, maxChars: 1_000 });
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toBe("y".repeat(1_000));
    expect(r.truncated).toBe(true);
    expect(r.partialLastLine).toBe(true);
    expect(r.lastLine).toBe(2);
    expect(r.nextStartLine).toBe(2); // resume on the same line with a larger cap
  });

  it("slices CRLF content by logical lines", () => {
    const r = sliceFileContent("alpha\r\nbravo\r\ncharlie", {
      startLine: 2,
      endLine: 2,
      maxChars: 50_000,
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toBe("bravo");
    expect(r.totalLines).toBe(3);
  });

  it("does not count a trailing newline as an extra line", () => {
    const r = sliceFileContent("alpha\nbravo\n", { maxChars: 50_000 });
    if (!r.ok) throw new Error(r.message);
    expect(r.totalLines).toBe(2);
    expect(r.text).toBe("alpha\nbravo");
    expect(r.nextStartLine).toBeUndefined();
  });

  it("handles an empty file without erroring", () => {
    const r = sliceFileContent("", { maxChars: 50_000 });
    if (!r.ok) throw new Error(r.message);
    expect(r.text).toBe("");
    expect(r.totalLines).toBe(0);
    expect(r.nextStartLine).toBeUndefined();
  });
});
