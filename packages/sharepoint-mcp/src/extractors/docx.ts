import mammoth from "mammoth";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
});
turndown.remove(["script", "style"]);

/**
 * Convert a Word document's bytes to markdown (mammoth docx→HTML, then
 * turndown HTML→markdown). Throws on unparseable input — callers surface
 * the error and suggest download_file.
 */
export async function extractDocxMarkdown(bytes: Uint8Array): Promise<string> {
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    return turndown.turndown(result.value).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`docx extraction failed: ${msg}`);
  }
}
