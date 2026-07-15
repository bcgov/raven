# Jira Attachment Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `download_attachment` tool to the Jira MCP server that saves ticket attachments to disk and returns their contents inline (full text for text/PDF, the image itself for screenshots).

**Architecture:** A thin transport method on `JiraClient` fetches bytes over the existing authenticated session. Pure helper modules classify the content, extract text (incl. PDF), sanitize filenames, and build the MCP content array. A small filesystem helper writes the file. The server tool orchestrates: resolve targets → download → save → represent.

**Tech Stack:** TypeScript (ESM / NodeNext), `@modelcontextprotocol/sdk`, `zod`, `@nrs/auth` (`PiScrubber`, `AuthenticatedFetch`), `pdf-parse`, Vitest.

## Global Constraints

- ESM monorepo, `"type": "module"`, TypeScript strict; import local files with `.js` extensions.
- Package scope `@nrs/`; the workspace root is `~/Projects/raven/raven` (git root is one level up at `~/Projects/raven`).
- Tests run via `npm test` (Vitest) from the workspace root `raven/`; build via `npm run build`.
- PII: scrub any text entering the model context with the module-level `pi` (`pi.scrubText(...)`). The on-disk file stays the unredacted original.
- `download_attachment` is annotated `{ readOnlyHint: false }` (it writes to the local filesystem).
- Never truncate inline content.
- `pdf-parse` MUST be imported from `"pdf-parse/lib/pdf-parse.js"` (the bare `"pdf-parse"` entry runs a debug harness that reads a test file and throws under ESM).
- Default save dir = `process.cwd()`; sanitize filenames to a safe basename; write with `mode 0o600`.
- `TOOL_INVENTORY.md` is generated — regenerate with `npm run gen-inventory`, never hand-edit; the CI drift gate enforces it.
- Commit messages: imperative mood, ≤50-char subject, no conventional-commit prefix (per `~/.claude/CLAUDE.md`).

## File Structure

- **Create** `raven/packages/jira-mcp/src/attachment-content.ts` — pure content helpers: `sanitizeFilename`, `classifyAttachment`, `decodeUtf8`, `extractPdfText`, `buildAttachmentContent`.
- **Create** `raven/packages/jira-mcp/src/attachment-fs.ts` — `saveAttachment` (write bytes to disk).
- **Create** `raven/packages/jira-mcp/src/pdf-parse.d.ts` — ambient module declaration for the `pdf-parse` lib subpath.
- **Modify** `raven/packages/jira-mcp/src/jira-client.ts` — add `downloadAttachment(id)`.
- **Modify** `raven/packages/jira-mcp/src/server.ts` — register the `download_attachment` tool; update `list_attachments` description.
- **Modify** `raven/packages/jira-mcp/package.json` — add `pdf-parse` dependency.
- **Modify** `raven/docs/TOOL_INVENTORY.md` — regenerated.
- **Create** tests: `src/__tests__/attachment-content.test.ts`, `attachment-fs.test.ts`, `attachment-content-build.test.ts`, `jira-client-download.test.ts`.

All commands below run from the workspace root unless noted:
```bash
cd ~/Projects/raven/raven
```

---

### Task 1: Content classification helpers

**Files:**
- Create: `raven/packages/jira-mcp/src/attachment-content.ts`
- Test: `raven/packages/jira-mcp/src/__tests__/attachment-content.test.ts`

**Interfaces:**
- Produces: `sanitizeFilename(name: string): string`; `type AttachmentKind = "image" | "text" | "pdf" | "other"`; `classifyAttachment(mimeType: string, filename: string): AttachmentKind`; `decodeUtf8(bytes: Uint8Array): string`.

- [ ] **Step 1: Write the failing test**

Create `raven/packages/jira-mcp/src/__tests__/attachment-content.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { sanitizeFilename, classifyAttachment, decodeUtf8 } from "../attachment-content.js";

describe("sanitizeFilename", () => {
  it("reduces path/traversal input to a safe basename", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("a/b/c.png")).toBe("c.png");
    expect(sanitizeFilename("..\\..\\win.txt")).toBe("win.txt");
  });
  it("falls back to 'attachment' for empty or dot-only names", () => {
    expect(sanitizeFilename("")).toBe("attachment");
    expect(sanitizeFilename("..")).toBe("attachment");
    expect(sanitizeFilename(".")).toBe("attachment");
  });
  it("preserves a legitimate dotfile name", () => {
    expect(sanitizeFilename(".env")).toBe(".env");
  });
  it("preserves spaces and hyphens in normal filenames", () => {
    expect(sanitizeFilename("my file-name (2).png")).toBe("my file-name (2).png");
  });
});

describe("classifyAttachment", () => {
  it("detects images", () => {
    expect(classifyAttachment("image/png", "x.png")).toBe("image");
    expect(classifyAttachment("image/jpeg", "x.jpg")).toBe("image");
  });
  it("detects pdf by mime or extension", () => {
    expect(classifyAttachment("application/pdf", "x.pdf")).toBe("pdf");
    expect(classifyAttachment("application/octet-stream", "report.pdf")).toBe("pdf");
  });
  it("detects text-like content", () => {
    expect(classifyAttachment("text/plain", "log.txt")).toBe("text");
    expect(classifyAttachment("application/json", "d.json")).toBe("text");
    expect(classifyAttachment("application/octet-stream", "server.log")).toBe("text");
  });
  it("falls back to 'other' for binary/office types", () => {
    expect(classifyAttachment("application/vnd.ms-excel", "x.xlsx")).toBe("other");
    expect(classifyAttachment("video/mp4", "x.mp4")).toBe("other");
  });
});

describe("decodeUtf8", () => {
  it("decodes UTF-8 bytes to a string", () => {
    expect(decodeUtf8(new TextEncoder().encode("héllo"))).toBe("héllo");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/jira-mcp/src/__tests__/attachment-content.test.ts`
Expected: FAIL — cannot resolve `../attachment-content.js`.

- [ ] **Step 3: Write minimal implementation**

Create `raven/packages/jira-mcp/src/attachment-content.ts`:
```ts
export type AttachmentKind = "image" | "text" | "pdf" | "other";

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/jira-mcp/src/__tests__/attachment-content.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add raven/packages/jira-mcp/src/attachment-content.ts \
        raven/packages/jira-mcp/src/__tests__/attachment-content.test.ts
git commit -m "Add Jira attachment content classification"
```

---

### Task 2: Disk-save helper

**Files:**
- Create: `raven/packages/jira-mcp/src/attachment-fs.ts`
- Test: `raven/packages/jira-mcp/src/__tests__/attachment-fs.test.ts`

**Interfaces:**
- Consumes: `sanitizeFilename` from `./attachment-content.js`.
- Produces: `saveAttachment(bytes: Uint8Array, filename: string, destDir?: string): Promise<string>` (returns absolute path written).

- [ ] **Step 1: Write the failing test**

Create `raven/packages/jira-mcp/src/__tests__/attachment-fs.test.ts`:
```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveAttachment } from "../attachment-fs.js";

describe("saveAttachment", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  async function tmp(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "raven-att-"));
    dirs.push(d);
    return d;
  }

  it("writes bytes into destDir and returns the path", async () => {
    const dir = await tmp();
    const p = await saveAttachment(new TextEncoder().encode("hello"), "note.txt", dir);
    expect(p).toBe(join(dir, "note.txt"));
    expect(await readFile(p, "utf-8")).toBe("hello");
  });

  it("sanitizes traversal filenames into the destDir basename", async () => {
    const dir = await tmp();
    const p = await saveAttachment(new Uint8Array([1, 2, 3]), "../../evil.bin", dir);
    expect(p).toBe(join(dir, "evil.bin"));
  });

  it("writes with 0600 permissions", async () => {
    const dir = await tmp();
    const p = await saveAttachment(new Uint8Array([0]), "x.bin", dir);
    expect((await stat(p)).mode & 0o777).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/jira-mcp/src/__tests__/attachment-fs.test.ts`
Expected: FAIL — cannot resolve `../attachment-fs.js`.

- [ ] **Step 3: Write minimal implementation**

Create `raven/packages/jira-mcp/src/attachment-fs.ts`:
```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { sanitizeFilename } from "./attachment-content.js";

/**
 * Save attachment bytes to disk under destDir (default: process.cwd()).
 * The filename is sanitized to a safe basename; the write path is asserted
 * to stay inside destDir. Returns the absolute path written.
 */
export async function saveAttachment(
  bytes: Uint8Array,
  filename: string,
  destDir?: string
): Promise<string> {
  const dir = resolve(destDir ?? process.cwd());
  await mkdir(dir, { recursive: true });
  const safe = sanitizeFilename(filename);
  const full = join(dir, safe);
  if (full !== dir && !full.startsWith(dir + sep)) {
    throw new Error(`Refusing to write outside ${dir}: ${filename}`);
  }
  await writeFile(full, bytes, { mode: 0o600 });
  return full;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/jira-mcp/src/__tests__/attachment-fs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add raven/packages/jira-mcp/src/attachment-fs.ts \
        raven/packages/jira-mcp/src/__tests__/attachment-fs.test.ts
git commit -m "Add Jira attachment disk-save helper"
```

---

### Task 3: `JiraClient.downloadAttachment`

**Files:**
- Modify: `raven/packages/jira-mcp/src/jira-client.ts` (after `getAttachmentMetadata`, ~line 415)
- Test: `raven/packages/jira-mcp/src/__tests__/jira-client-download.test.ts`

**Interfaces:**
- Consumes: existing `this.fetch` (`AuthenticatedFetch`), `getAttachmentMetadata`, `JiraAttachment` type.
- Produces: `downloadAttachment(attachmentId: string): Promise<{ meta: JiraAttachment; bytes: Uint8Array }>`.

- [ ] **Step 1: Write the failing test**

Create `raven/packages/jira-mcp/src/__tests__/jira-client-download.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { JiraClient } from "../jira-client.js";

const BASE = "https://jira.example.com";
const META = {
  id: "42",
  filename: "shot.png",
  author: { displayName: "Jane" },
  created: "2026-01-01T00:00:00Z",
  size: 3,
  mimeType: "image/png",
  content: `${BASE}/secure/attachment/42/shot.png`,
};

function jsonResp(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve("") };
}
function binResp(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
    text: () => Promise.resolve(""),
  };
}

describe("JiraClient.downloadAttachment", () => {
  it("fetches metadata then content bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp(META))
      .mockResolvedValueOnce(binResp(bytes));
    const client = new JiraClient(fetchMock as any, BASE);

    const { meta, bytes: out } = await client.downloadAttachment("42");

    expect(meta.filename).toBe("shot.png");
    expect(Array.from(out)).toEqual([1, 2, 3]);
    expect(fetchMock.mock.calls[0][0]).toContain("/rest/api/2/attachment/42");
    expect(fetchMock.mock.calls[1][0]).toBe(META.content);
  });

  it("follows a single non-login redirect on the content URL", async () => {
    const bytes = new Uint8Array([9]);
    const redirect = {
      ok: false,
      status: 302,
      headers: { get: (h: string) => (h.toLowerCase() === "location" ? `${BASE}/blob/xyz` : null) },
      text: () => Promise.resolve(""),
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp(META))
      .mockResolvedValueOnce(redirect)
      .mockResolvedValueOnce(binResp(bytes));
    const client = new JiraClient(fetchMock as any, BASE);

    const { bytes: out } = await client.downloadAttachment("42");
    expect(Array.from(out)).toEqual([9]);
    expect(fetchMock.mock.calls[2][0]).toBe(`${BASE}/blob/xyz`);
  });

  it("throws with status on failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResp(META))
      .mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null }, text: () => Promise.resolve("gone") });
    const client = new JiraClient(fetchMock as any, BASE);
    await expect(client.downloadAttachment("42")).rejects.toThrow("Failed to download attachment 42 (404)");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/jira-mcp/src/__tests__/jira-client-download.test.ts`
Expected: FAIL — `downloadAttachment` is not a function.

- [ ] **Step 3: Write minimal implementation**

In `raven/packages/jira-mcp/src/jira-client.ts`, immediately after the `getAttachmentMetadata` method (before the `// User search` divider), add:
```ts
  /**
   * Download an attachment's bytes by ID. Returns metadata + raw bytes.
   * Follows a single non-login redirect on the content URL (the authenticated
   * fetch uses redirect:"manual" and only auto-retries SiteMinder login redirects).
   */
  async downloadAttachment(
    attachmentId: string
  ): Promise<{ meta: JiraAttachment; bytes: Uint8Array }> {
    const meta = await this.getAttachmentMetadata(attachmentId);
    let resp = await this.fetch(meta.content);
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (location) {
        resp = await this.fetch(new URL(location, meta.content).toString());
      }
    }
    if (!resp.ok) {
      throw new Error(
        `Failed to download attachment ${attachmentId} (${resp.status}): ${await resp.text()}`
      );
    }
    const buf = await resp.arrayBuffer();
    return { meta, bytes: new Uint8Array(buf) };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/jira-mcp/src/__tests__/jira-client-download.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add raven/packages/jira-mcp/src/jira-client.ts \
        raven/packages/jira-mcp/src/__tests__/jira-client-download.test.ts
git commit -m "Add JiraClient.downloadAttachment"
```

---

### Task 4: PDF text extraction (`pdf-parse`)

**Files:**
- Modify: `raven/packages/jira-mcp/package.json` (add dependency)
- Create: `raven/packages/jira-mcp/src/pdf-parse.d.ts`
- Modify: `raven/packages/jira-mcp/src/attachment-content.ts` (add `extractPdfText`)
- Test: `raven/packages/jira-mcp/src/__tests__/attachment-content-build.test.ts` (created here; extended in Task 5)

**Interfaces:**
- Produces: `extractPdfText(bytes: Uint8Array): Promise<string>`.

- [ ] **Step 1: Add the dependency and install**

Edit `raven/packages/jira-mcp/package.json` — add `pdf-parse` to `dependencies` (keep alphabetical-ish with the existing entries):
```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@nrs/auth": "*",
    "pdf-parse": "^1.1.1",
    "zod": "^3.24.0"
  }
```
Run (from workspace root): `npm install`
Expected: installs `pdf-parse`, updates `package-lock.json`, `found 0 vulnerabilities`.

- [ ] **Step 2: Add the ambient type declaration**

Create `raven/packages/jira-mcp/src/pdf-parse.d.ts`:
```ts
declare module "pdf-parse/lib/pdf-parse.js" {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(data: Buffer | Uint8Array): Promise<PdfParseResult>;
  export default pdfParse;
}
```

- [ ] **Step 3: Write the failing test**

Create `raven/packages/jira-mcp/src/__tests__/attachment-content-build.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("pdf-parse/lib/pdf-parse.js", () => ({
  default: vi.fn(async () => ({ text: "extracted pdf text", numpages: 1, info: {}, metadata: {}, version: "" })),
}));

import { extractPdfText } from "../attachment-content.js";

describe("extractPdfText", () => {
  it("returns the text from a pdf buffer", async () => {
    const out = await extractPdfText(new Uint8Array([0x25, 0x50, 0x44, 0x46]));
    expect(out).toBe("extracted pdf text");
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run packages/jira-mcp/src/__tests__/attachment-content-build.test.ts`
Expected: FAIL — `extractPdfText` is not exported.

- [ ] **Step 5: Write minimal implementation**

In `raven/packages/jira-mcp/src/attachment-content.ts`, add the import at the top of the file (below the existing type export is fine; imports must be at module top — place it as the first line):
```ts
import pdfParse from "pdf-parse/lib/pdf-parse.js";
```
And add this exported function at the end of the file:
```ts
/** Extract all text from a PDF's bytes. */
export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  const result = await pdfParse(Buffer.from(bytes));
  return result.text ?? "";
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/jira-mcp/src/__tests__/attachment-content-build.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify the real library imports (no debug-harness crash)**

Run: `npm run build`
Expected: `tsc --build` succeeds with no errors (confirms the `pdf-parse/lib/pdf-parse.js` subpath + ambient decl typecheck).

- [ ] **Step 8: Commit**

```bash
git add raven/packages/jira-mcp/package.json \
        raven/packages/jira-mcp/src/pdf-parse.d.ts \
        raven/packages/jira-mcp/src/attachment-content.ts \
        raven/packages/jira-mcp/src/__tests__/attachment-content-build.test.ts \
        raven/package-lock.json
git commit -m "Add PDF text extraction for attachments"
```

---

### Task 5: `buildAttachmentContent`

**Files:**
- Modify: `raven/packages/jira-mcp/src/attachment-content.ts` (add `buildAttachmentContent` + `McpContentBlock`)
- Test: `raven/packages/jira-mcp/src/__tests__/attachment-content-build.test.ts` (extend)

**Interfaces:**
- Consumes: `classifyAttachment`, `decodeUtf8`, `extractPdfText` (same module).
- Produces: `type McpContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }`; `buildAttachmentContent(meta: { filename: string; mimeType: string; size: number }, bytes: Uint8Array, savedPath: string, scrub: (s: string) => string): Promise<McpContentBlock[]>`.

- [ ] **Step 1: Write the failing test**

Append to `raven/packages/jira-mcp/src/__tests__/attachment-content-build.test.ts` (add `buildAttachmentContent` to the import, and add this block). The `pdf-parse` mock at the top of the file already returns `"extracted pdf text"`; add a second mock return for the SIN case inline via the fake scrub:
```ts
import { buildAttachmentContent } from "../attachment-content.js";

describe("buildAttachmentContent", () => {
  const upper = (s: string) => s.toUpperCase(); // stand-in scrub: proves scrubbing is applied

  it("image → header + image block, bytes not scrubbed", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/jira-mcp/src/__tests__/attachment-content-build.test.ts`
Expected: FAIL — `buildAttachmentContent` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `raven/packages/jira-mcp/src/attachment-content.ts`, add:
```ts
export type McpContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/jira-mcp/src/__tests__/attachment-content-build.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add raven/packages/jira-mcp/src/attachment-content.ts \
        raven/packages/jira-mcp/src/__tests__/attachment-content-build.test.ts
git commit -m "Build MCP content blocks for attachments"
```

---

### Task 6: Register the `download_attachment` tool

**Files:**
- Modify: `raven/packages/jira-mcp/src/server.ts` (imports; new tool after `list_attachments` ~line 1108; tweak `list_attachments` description ~line 1078)

**Interfaces:**
- Consumes: `getClient()` (closure), module `pi`, `safeErr`, `JiraClient.downloadAttachment`, `saveAttachment`, `buildAttachmentContent`.
- Produces: MCP tool `download_attachment`.

- [ ] **Step 1: Add imports**

In `raven/packages/jira-mcp/src/server.ts`, below the existing `import { JiraClient } from "./jira-client.js";` line, add:
```ts
import { saveAttachment } from "./attachment-fs.js";
import { buildAttachmentContent } from "./attachment-content.js";
```

- [ ] **Step 2: Update `list_attachments` description (point at the new tool)**

Replace the `list_attachments` description string (the second argument to that `server.tool(` call) with:
```ts
    "List attachments on a Jira issue — filename, author, size, mime type, ID, and download URL. Use download_attachment (with the attachment ID) to fetch and save the actual file contents.",
```

- [ ] **Step 3: Register the tool**

Immediately after the closing `);` of the `list_attachments` `server.tool(...)` call (before the `// User search` divider), add:
```ts
  server.tool(
    "download_attachment",
    "Download file(s) attached to a Jira ticket. Provide attachmentId to download ONE file — it is saved to disk AND its contents are returned inline (full text for text/PDF, the image itself for screenshots). Provide issueKey to download ALL attachments on the issue — each is saved to disk and a manifest of paths is returned (call again with a specific attachmentId to read one inline). Files save to the current working directory unless destDir is given. NOTE: inlined image content (e.g. screenshots) may contain personal information visible to the AI.",
    {
      attachmentId: z.string().optional().describe("Download a single attachment by ID (from list_attachments)"),
      issueKey: z.string().optional().describe("Download ALL attachments on this issue (e.g., RRS-123)"),
      destDir: z.string().optional().describe("Directory to save into; defaults to the current working directory"),
    },
    { readOnlyHint: false },
    async ({ attachmentId, issueKey, destDir }) => {
      try {
        if ((!attachmentId && !issueKey) || (attachmentId && issueKey)) {
          return {
            content: [{ type: "text", text: "Provide exactly one of attachmentId or issueKey." }],
            isError: true,
          };
        }
        const jira = await getClient();

        if (attachmentId) {
          const { meta, bytes } = await jira.downloadAttachment(attachmentId);
          const path = await saveAttachment(bytes, meta.filename, destDir);
          const content = await buildAttachmentContent(meta, bytes, path, (s) => pi.scrubText(s));
          return { content };
        }

        const attachments = await jira.listAttachments(issueKey as string);
        if (attachments.length === 0) {
          return { content: [{ type: "text", text: `No attachments on ${issueKey}.` }] };
        }
        const lines: string[] = [`### Downloaded ${attachments.length} attachment(s) from ${issueKey}\n`];
        for (const att of attachments) {
          const { bytes } = await jira.downloadAttachment(att.id);
          const path = await saveAttachment(bytes, att.filename, destDir);
          const sizeKb = Math.round(att.size / 1024);
          lines.push(`- **${att.filename}** (${sizeKb} KB, ${att.mimeType}) → ${path}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Error downloading attachment: ${safeErr(err)}` }],
          isError: true,
        };
      }
    }
  );
```

- [ ] **Step 4: Typecheck / build**

Run: `npm run build`
Expected: `tsc --build` succeeds (the tool handler's return shapes match the SDK's content union).

- [ ] **Step 5: Manual smoke test (optional — needs live Jira + a real issue key with an attachment)**

Only if credentials are configured in `~/.raven/.env`. From a scratch directory:
```bash
cd /tmp && node ~/Projects/raven/raven/packages/jira-mcp/dist/index.js
```
This starts the stdio server; drive it from your MCP client (Claude Code/Desktop) with `download_attachment` on a known issue key, and confirm the file lands in the working dir and the inline content appears. If no credentials/VPN, skip — the unit tests plus build cover the logic.

- [ ] **Step 6: Commit**

```bash
git add raven/packages/jira-mcp/src/server.ts
git commit -m "Add download_attachment Jira MCP tool"
```

---

### Task 7: Regenerate inventory + full verification

**Files:**
- Modify: `raven/docs/TOOL_INVENTORY.md` (regenerated)

- [ ] **Step 1: Full build + test suite**

Run: `npm run build && npm test`
Expected: build clean; all tests pass (existing suite + the 4 new test files), 0 failures.

- [ ] **Step 2: Regenerate the tool inventory**

Run: `npm run gen-inventory`
Expected: writes `docs/TOOL_INVENTORY.md`; jira-mcp now shows one more **write** tool (`download_attachment`), and the local write/total counts increase by 1.

- [ ] **Step 3: Verify the drift gate passes**

Run: `npm run gen-inventory:check`
Expected: `TOOL_INVENTORY.md is up to date.`

- [ ] **Step 4: Inspect the inventory diff**

Run: `git -C ~/Projects/raven diff --stat -- raven/docs/TOOL_INVENTORY.md`
Expected: `TOOL_INVENTORY.md` changed; the jira-mcp section lists `download_attachment` under Write and the summary counts are bumped by one write/tool.

- [ ] **Step 5: Commit**

```bash
git add raven/docs/TOOL_INVENTORY.md
git commit -m "Regenerate tool inventory for attachment tool"
```

---

## Verification Summary

After Task 7, the branch `feature/jira-attachment-download` should have: a new `download_attachment` tool (save + inline), full unit coverage on the client method and all pure helpers, a green build, a passing inventory drift gate, and the spec's FOIPPA split (disk = original, inline text = scrubbed, images inlined as-is). Then open a PR per the standard workflow (`/ship` or manual), targeting `main`.
