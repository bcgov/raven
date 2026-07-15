import pdfParse from "pdf-parse/lib/pdf-parse.js";

export type AttachmentKind = "image" | "text" | "pdf" | "other";

export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TEXT_EXTS = new Set(["txt", "md", "log", "csv", "json", "xml", "yml", "yaml"]);

/** Reduce a Jira-supplied filename to a safe basename (no path traversal). */
export function sanitizeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f]/g, "").trim();
  if (base === "" || base === "." || base === "..") return "attachment";
  return base;
}

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function isTextLike(mime: string, ext: string): boolean {
  const mt = mime.toLowerCase();
  if (mt.startsWith("text/")) return true;
  if (mt === "application/json" || mt === "application/xml" || mt.endsWith("+xml")) return true;
  if (mt === "application/x-ndjson" || mt.includes("yaml")) return true;
  return TEXT_EXTS.has(ext);
}

/** Decide how an attachment should be represented inline. */
export function classifyAttachment(mimeType: string, filename: string): AttachmentKind {
  const mt = (mimeType || "").toLowerCase();
  const ext = extOf(filename);
  if (IMAGE_MIMES.has(mt)) return "image";
  if (mt === "application/pdf" || ext === "pdf") return "pdf";
  if (isTextLike(mt, ext)) return "text";
  return "other";
}

/** Decode raw bytes as UTF-8 text. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

/** Extract all text from a PDF's bytes. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const result = await pdfParse(Buffer.from(bytes));
  return result.text ?? "";
}

/**
 * Return a filesystem-safe basename for `filename`, disambiguated with the
 * attachment `id` when that basename was already used (tracked in `used`).
 * Collisions are checked case-insensitively (case-insensitive filesystems
 * like macOS/Windows treat "Foo.pdf" and "FOO.pdf" as the same file), while
 * the returned name keeps its original casing. Keeps every attachment in a
 * bulk download as a distinct file.
 */
export function disambiguateFilename(filename: string, id: string, used: Set<string>): string {
  const safe = sanitizeFilename(filename);
  const has = (name: string): boolean => {
    const lower = name.toLowerCase();
    for (const existing of used) {
      if (existing.toLowerCase() === lower) return true;
    }
    return false;
  };
  if (!has(safe)) {
    used.add(safe);
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  let candidate = `${stem}-${id}${ext}`;
  let n = 2;
  while (has(candidate)) {
    candidate = `${stem}-${id}-${n}${ext}`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Build the MCP content array for a single downloaded attachment: a header
 * line naming the saved file, plus the inline representation (image / full
 * scrubbed text / PDF text / disk-only note). Never truncates.
 */
export async function buildAttachmentContent(
  meta: { filename: string; mimeType: string; size: number },
  bytes: Uint8Array,
  savedPath: string,
  scrub: (s: string) => string
): Promise<McpContentBlock[]> {
  const sizeKb = Math.round(meta.size / 1024);
  const header: McpContentBlock = {
    type: "text",
    text: `Saved **${meta.filename}** (${sizeKb} KB, ${meta.mimeType}) to ${savedPath}`,
  };
  const kind = classifyAttachment(meta.mimeType, meta.filename);
  if (kind === "image") {
    return [header, { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: meta.mimeType }];
  }
  if (kind === "text") {
    return [header, { type: "text", text: scrub(decodeUtf8(bytes)) }];
  }
  if (kind === "pdf") {
    try {
      const text = await extractPdfText(bytes);
      if (text.trim()) return [header, { type: "text", text: scrub(text) }];
      return [header, { type: "text", text: "(PDF contained no extractable text; the file is saved to disk.)" }];
    } catch {
      return [header, { type: "text", text: "(PDF text extraction failed; the file is saved to disk.)" }];
    }
  }
  return [header, { type: "text", text: `Inline preview not available for ${meta.mimeType}; the file is saved to disk.` }];
}
