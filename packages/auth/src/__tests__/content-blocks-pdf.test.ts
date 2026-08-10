import { describe, it, expect } from "vitest";
import { extractPdfText } from "../content-blocks.js";

/**
 * Minimal single-page PDF (598 bytes) containing the text
 * "Hello RAVEN PDF fixture" — exercises the real pdf-parse library,
 * unlike the mocked tests in content-blocks-build.test.ts.
 */
const FIXTURE_B64 =
  "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1NCA+PgpzdHJlYW0KQlQgL0YxIDI0IFRmIDcyIDcyMCBUZCAoSGVsbG8gUkFWRU4gUERGIGZpeHR1cmUpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PCAvVHlwZSAvRm9udCAvU3VidHlwZSAvVHlwZTEgL0Jhc2VGb250IC9IZWx2ZXRpY2EgPj4KZW5kb2JqCnhyZWYKMCA2CjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwOSAwMDAwMCBuIAowMDAwMDAwMDU4IDAwMDAwIG4gCjAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDI0MSAwMDAwMCBuIAowMDAwMDAwMzQ1IDAwMDAwIG4gCnRyYWlsZXIKPDwgL1NpemUgNiAvUm9vdCAxIDAgUiA+PgpzdGFydHhyZWYKNDE1CiUlRU9GCg==";

describe("extractPdfText against real pdf-parse", () => {
  it("extracts text from real PDF bytes", async () => {
    const bytes = new Uint8Array(Buffer.from(FIXTURE_B64, "base64"));
    const text = await extractPdfText(bytes);
    expect(text).toContain("Hello RAVEN PDF fixture");
  });

  it("does not add page-boundary markers to extracted text", async () => {
    const bytes = new Uint8Array(Buffer.from(FIXTURE_B64, "base64"));
    const text = await extractPdfText(bytes);
    expect(text).not.toContain("-- 1 of 1 --");
  });

  it("rejects on bytes that are not a PDF", async () => {
    await expect(extractPdfText(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });
});
