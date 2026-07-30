import { describe, it, expect, vi } from "vitest";
import { SharePointClient, parseSearchResults, cleanSummary } from "../sharepoint-client.js";

const FIXTURE = {
  PrimaryQueryResult: {
    RelevantResults: {
      TotalRows: 2,
      Table: {
        Rows: [
          {
            Cells: [
              { Key: "Title", Value: "CWM Design Doc" },
              { Key: "Path", Value: "https://example.sharepoint.com/sites/proj/Docs/design.docx" },
              { Key: "Author", Value: "Jane Smith" },
              { Key: "LastModifiedTime", Value: "2026-05-01T10:00:00.0000000Z" },
              { Key: "HitHighlightedSummary", Value: "The <c0>design</c0> covers <ddd/> the API." },
              { Key: "FileType", Value: "docx" },
              { Key: "SiteName", Value: "https://example.sharepoint.com/sites/proj" },
            ],
          },
          {
            Cells: [
              { Key: "Title", Value: "Mockups" },
              { Key: "Path", Value: "https://example.sharepoint.com/sites/proj/Docs/mock.png" },
              { Key: "FileType", Value: "png" },
            ],
          },
        ],
      },
    },
  },
};

describe("cleanSummary", () => {
  it("strips hit-highlight markers and ellipsis tags", () => {
    expect(cleanSummary("The <c0>design</c0> covers <ddd/> the API.")).toBe(
      "The design covers … the API."
    );
  });
});

describe("parseSearchResults", () => {
  it("maps cells into SearchHit fields", () => {
    const { hits, totalRows } = parseSearchResults(FIXTURE);
    expect(totalRows).toBe(2);
    expect(hits[0]).toMatchObject({
      title: "CWM Design Doc",
      path: "https://example.sharepoint.com/sites/proj/Docs/design.docx",
      author: "Jane Smith",
      fileType: "docx",
    });
    expect(hits[0]?.summary).toBe("The design covers … the API.");
    expect(hits[1]?.author).toBeUndefined();
  });

  it("returns empty results for a response with no rows", () => {
    const { hits, totalRows } = parseSearchResults({ PrimaryQueryResult: { RelevantResults: { TotalRows: 0, Table: { Rows: [] } } } });
    expect(hits).toEqual([]);
    expect(totalRows).toBe(0);
  });
});

describe("SharePointClient.search", () => {
  it("builds the query URL with doubled quotes and scope filters", async () => {
    let seenUrl = "";
    const fetchStub = vi.fn(async (url: string) => {
      seenUrl = url;
      return new Response(JSON.stringify(FIXTURE), { status: 200 });
    });
    const client = new SharePointClient(fetchStub, "https://example.sharepoint.com");
    await client.search("O'Brien report", { rowLimit: 5, sitePath: "/sites/proj", fileType: "docx" });

    const decoded = decodeURIComponent(seenUrl);
    expect(decoded).toContain("/_api/search/query?querytext=");
    expect(decoded).toContain("O''Brien report");
    expect(decoded).toContain('Path:"https://example.sharepoint.com/sites/proj*"');
    expect(decoded).toContain("FileType:docx");
    expect(decoded).toContain("rowlimit=5");
  });
});
