import { describe, it, expect } from "vitest";
import { markdownToHtml, fixConfluenceTableFormat } from "../markdown-to-html.js";

describe("markdownToHtml", () => {
  it("converts headings", () => {
    const result = markdownToHtml("# Hello\n\nA paragraph.");
    expect(result).toContain("<h1>Hello</h1>");
    expect(result).toContain("<p>A paragraph.</p>");
  });

  it("converts bold and italic", () => {
    const result = markdownToHtml("**bold** and *italic*");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
  });

  it("converts fenced code blocks", () => {
    const result = markdownToHtml("```java\nSystem.out.println();\n```");
    expect(result).toContain("<code");
    expect(result).toContain("System.out.println();");
  });

  it("converts links", () => {
    const result = markdownToHtml("[Example](https://example.com)");
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain("Example");
  });

  it("auto-linkifies bare URLs", () => {
    const result = markdownToHtml("Visit https://example.com today");
    expect(result).toContain('href="https://example.com"');
  });

  it("passes through raw HTML", () => {
    const input = '<ac:structured-macro ac:name="toc" />';
    const result = markdownToHtml(input);
    expect(result).toContain("ac:structured-macro");
  });

  it("returns empty string for empty input", () => {
    expect(markdownToHtml("")).toBe("");
    expect(markdownToHtml("   ")).toBe("");
  });

  it("converts unordered lists", () => {
    const result = markdownToHtml("- item one\n- item two");
    expect(result).toContain("<ul>");
    expect(result).toContain("<li>item one</li>");
  });

  it("converts tables", () => {
    const result = markdownToHtml(
      "| A | B |\n| --- | --- |\n| 1 | 2 |"
    );
    expect(result).toContain("<table>");
    expect(result).toContain("<td>1</td>");
  });

  it("table output has no <thead> (Confluence storage format requires <tbody> only)", () => {
    // Confluence's storage-format parser rejects <thead>. Header semantics
    // are preserved via <th> cells in the first row inside <tbody>.
    const result = markdownToHtml(
      "| A | B |\n| --- | --- |\n| 1 | 2 |"
    );
    expect(result).not.toContain("<thead>");
    expect(result).not.toContain("</thead>");
    expect(result).toContain("<tbody>");
    expect(result).toContain("<th>A</th>");
    expect(result).toContain("<th>B</th>");
    expect(result).toContain("<td>1</td>");
    expect(result).toContain("<td>2</td>");
  });

  it("table preserves cell alignment styles", () => {
    const result = markdownToHtml(
      "| L | C | R |\n|:---|:---:|---:|\n| a | b | c |"
    );
    expect(result).not.toContain("<thead>");
    expect(result).toContain('text-align:left');
    expect(result).toContain('text-align:center');
    expect(result).toContain('text-align:right');
  });

  it("table with header but no body row still merges correctly", () => {
    // Edge case: only the header row.
    const result = markdownToHtml("| A | B |\n| --- | --- |");
    expect(result).not.toContain("<thead>");
  });

  it("multiple tables in one document each get the thead removed", () => {
    const md = [
      "| A | B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "Some text.",
      "",
      "| X | Y |",
      "| --- | --- |",
      "| 3 | 4 |",
    ].join("\n");
    const result = markdownToHtml(md);
    expect(result).not.toContain("<thead>");
    expect(result).toContain("<th>A</th>");
    expect(result).toContain("<th>X</th>");
    expect(result).toContain("<td>1</td>");
    expect(result).toContain("<td>3</td>");
  });

  it("emits self-closed void elements (XHTML compliance)", () => {
    // <br/>, <hr/>, <img/> — all required to be self-closed in XHTML.
    // Confluence's storage-format parser rejects HTML5-style open void tags.
    const hr = markdownToHtml("before\n\n---\n\nafter");
    expect(hr).toMatch(/<hr\s*\/>/);
    expect(hr).not.toMatch(/<hr\s*>/);

    const img = markdownToHtml("![alt](http://x.example/y.png)");
    expect(img).toMatch(/<img[^>]*\/>/);
    expect(img).not.toMatch(/<img[^>]*[^/]>/);
  });
});

describe("fixConfluenceTableFormat (unit)", () => {
  it("merges thead+tbody into tbody, preserving order", () => {
    const input =
      "<table>\n" +
      "<thead>\n<tr>\n<th>A</th>\n</tr>\n</thead>\n" +
      "<tbody>\n<tr>\n<td>1</td>\n</tr>\n</tbody>\n" +
      "</table>";
    const result = fixConfluenceTableFormat(input);
    expect(result).not.toContain("<thead>");
    expect(result).toContain("<tbody>");
    // Header row appears before data row inside tbody
    expect(result.indexOf("<th>A</th>")).toBeLessThan(result.indexOf("<td>1</td>"));
  });

  it("is a no-op when there is no thead", () => {
    const input = "<table>\n<tbody>\n<tr>\n<td>1</td>\n</tr>\n</tbody>\n</table>";
    expect(fixConfluenceTableFormat(input)).toBe(input);
  });

  it("is a no-op when there are no tables", () => {
    const input = "<p>Just a paragraph.</p>";
    expect(fixConfluenceTableFormat(input)).toBe(input);
  });

  it("handles multiple tables in one input", () => {
    const oneTable =
      "<table>\n<thead>\n<tr>\n<th>A</th>\n</tr>\n</thead>\n" +
      "<tbody>\n<tr>\n<td>1</td>\n</tr>\n</tbody>\n</table>";
    const result = fixConfluenceTableFormat(oneTable + "\n" + oneTable);
    expect(result).not.toContain("<thead>");
    // Both tables converted
    expect((result.match(/<tbody>/g) ?? []).length).toBe(2);
  });
});
