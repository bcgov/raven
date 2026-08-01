import { describe, it, expect, vi } from "vitest";
import { SharePointClient, escapeODataPath } from "../sharepoint-client.js";
import { SpoApiError } from "../types.js";

const BASE = "https://example.sharepoint.com";

function clientWith(status: number, body: unknown, capture?: { url?: string; init?: RequestInit }) {
  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    const payload = body instanceof ArrayBuffer ? body : JSON.stringify(body);
    return new Response(payload as BodyInit, { status });
  });
  return new SharePointClient(fetchStub, BASE);
}

describe("escapeODataPath", () => {
  it("doubles single quotes for the OData string literal", () => {
    expect(escapeODataPath("/sites/x/O'Brien.docx")).toBe("/sites/x/O''Brien.docx");
  });
});

describe("SharePointClient", () => {
  it("getWeb builds the site-scoped URL and sets the JSON Accept header", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const client = clientWith(200, { Title: "Proj", ServerRelativeUrl: "/sites/proj" }, capture);
    const web = await client.getWeb("/sites/proj");
    expect(capture.url).toBe(
      `${BASE}/sites/proj/_api/web?$select=Title,Description,ServerRelativeUrl,LastItemModifiedDate`
    );
    expect(new Headers(capture.init?.headers).get("Accept")).toBe("application/json;odata=nometadata");
    expect(web.Title).toBe("Proj");
  });

  it("listDocumentLibraries filters to BaseTemplate 101 and unwraps value", async () => {
    const capture: { url?: string } = {};
    const client = clientWith(200, { value: [{ Title: "Documents", ItemCount: 3 }] }, capture);
    const libs = await client.listDocumentLibraries("/sites/proj");
    expect(libs).toHaveLength(1);
    expect(capture.url).toContain("/_api/web/lists?");
    // URLSearchParams encodes spaces as "+", which decodeURIComponent keeps
    expect(decodeURIComponent(capture.url!).replace(/\+/g, " ")).toContain(
      "BaseTemplate eq 101 and Hidden eq false"
    );
  });

  it("listFolder returns files and folders from the expanded response", async () => {
    const client = clientWith(200, {
      Files: [{ Name: "a.docx", ServerRelativeUrl: "/sites/p/Docs/a.docx", Length: "10", TimeLastModified: "2026-01-01T00:00:00Z" }],
      Folders: [{ Name: "sub", ServerRelativeUrl: "/sites/p/Docs/sub", ItemCount: 2 }],
    });
    const contents = await client.listFolder("/sites/p", "/sites/p/Docs");
    expect(contents.files[0]?.Name).toBe("a.docx");
    expect(contents.folders[0]?.Name).toBe("sub");
  });

  it("getFileInfo normalizes Length to a number and builds webUrl", async () => {
    const client = clientWith(200, {
      Name: "a.docx",
      ServerRelativeUrl: "/sites/p/Docs/a.docx",
      Length: "12345",
      TimeLastModified: "2026-01-01T00:00:00Z",
      UIVersionLabel: "2.0",
    });
    const info = await client.getFileInfo("/sites/p", "/sites/p/Docs/a.docx");
    expect(info.length).toBe(12345);
    expect(info.webUrl).toBe(`${BASE}/sites/p/Docs/a.docx`);
  });

  it("throws SpoApiError with the status on failure", async () => {
    const client = clientWith(404, { error: "nope" });
    await expect(client.getWeb("/sites/missing")).rejects.toThrowError(SpoApiError);
    await expect(client.getWeb("/sites/missing")).rejects.toMatchObject({ status: 404 });
  });

  it("downloadFile returns the raw bytes from $value", async () => {
    const bytes = new TextEncoder().encode("PDFDATA");
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const capture: { url?: string } = {};
    const client = clientWith(200, buf as ArrayBuffer, capture);
    const got = await client.downloadFile("/sites/p", "/sites/p/Docs/a.pdf");
    expect(new TextDecoder().decode(got)).toBe("PDFDATA");
    expect(capture.url).toContain("/$value");
    expect(capture.url).toContain("GetFileByServerRelativePath(decodedurl=");
  });

  it("getPageCanvasContent selects Title and CanvasContent1 via ListItemAllFields", async () => {
    const capture: { url?: string } = {};
    const client = clientWith(200, { Title: "Page", CanvasContent1: "<div>x</div>" }, capture);
    const page = await client.getPageCanvasContent("/sites/p", "/sites/p/SitePages/Home.aspx");
    expect(page.canvasContent).toBe("<div>x</div>");
    expect(capture.url).toContain("/ListItemAllFields?$select=Title,CanvasContent1,WikiField");
  });

  it("getPageCanvasContent falls back to WikiField for classic wiki pages", async () => {
    // Wiki-format Site Pages (observed live) have null Title/CanvasContent1
    // with the body HTML in WikiField.
    const client = clientWith(200, {
      Title: null,
      CanvasContent1: null,
      WikiField: "<div>wiki body</div>",
    });
    const page = await client.getPageCanvasContent("/sites/p", "/sites/p/SitePages/Old.aspx");
    expect(page.canvasContent).toBe("<div>wiki body</div>");
    expect(page.title).toBe("");
  });
});
