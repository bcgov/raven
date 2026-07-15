# Jira MCP — Download Attachments (Design)

- **Date:** 2026-07-08
- **Status:** Approved design — pending spec review
- **Component:** `raven/packages/jira-mcp`
- **Branch:** `feature/jira-attachment-download`

## Context

The Jira MCP server can *list* attachments (`list_attachments`): it returns each
attachment's metadata plus a download URL and tells the caller to fetch the file
manually with `curl`/`wget`. There is no way to actually pull an attachment's
contents through the MCP.

We want the AI to download files attached to Jira tickets — both to **save** them
locally and to **read** their contents (screenshots, logs, PDFs).

Auth is already solved. `JiraClient` uses an injected `AuthenticatedFetch`
(SiteMinder `SMSESSION` / Basic Auth) that returns a standard `Response`, so
downloading is just an authenticated `GET` of the attachment content URL followed
by reading the body bytes (`arrayBuffer()`). The existing `getAttachmentMetadata(id)`
and `listAttachments(issueKey)` already resolve the content URL(s).

## Goals

- Download **one** attachment (by ID) or **all** attachments on an issue (by key),
  over the existing authenticated session.
- **Always save** the complete file to the local filesystem (any type, any size).
- Let the AI **read the content inline, untruncated**, using **standard MCP content
  types** so any MCP client/model works — not only Claude:
  - text-like files → full text
  - images → MCP `image`
  - PDF → full extracted text
- FOIPPA-safe handling of PII.

## Non-goals (v1)

- Word / Excel / PowerPoint text extraction — those save to disk but are not inlined.
- Uploading / attaching files (separate feature).
- Rendering non-PDF documents as images.
- Chunked / paged reading of very large files (the client can re-read from the saved path).

## Design

### 1. Tool API — `download_attachment`

| Param | Type | Notes |
|---|---|---|
| `attachmentId` | string, optional | Download a single attachment by ID (IDs come from `list_attachments`). |
| `issueKey` | string, optional | Download **all** attachments on the issue. |
| `destDir` | string, optional | Override the save directory. |

- **Exactly one** of `attachmentId` / `issueKey` must be provided → validation error otherwise.
- **`readOnlyHint: false`.** The tool does not mutate Jira (it's a `GET`), but it
  **writes files to the local filesystem** — a side effect on the environment. Per
  the MCP `readOnlyHint` contract ("does not modify its environment") this is a
  write tool, and it should not be auto-approved as read-only by a client. This is
  the honest, safer classification and is how it will appear in `TOOL_INVENTORY.md`.

### 2. Download + save to disk (always, full file, any type)

1. Resolve targets: by ID → `getAttachmentMetadata(id)`; by issue → `listAttachments(issueKey)`.
2. For each attachment: authenticated `GET` of the `content` URL; read `arrayBuffer()`.
3. **Redirects:** the authed fetch uses `redirect: "manual"` (to detect SiteMinder
   login pages). Jira DC normally serves `/secure/attachment/...` with a direct
   `200`, but if the content URL returns a `3xx` to a **non-login** location, follow
   it once with auth. A login redirect is treated as session expiry (existing path).
4. **Save location:** default = the MCP server's current working directory
   (`process.cwd()`) — i.e., where the AI is working; `destDir` overrides (relative
   resolved against cwd). Create the directory if missing.
5. **Filename safety:** reduce the Jira-supplied filename to a safe basename
   (`path.basename`, strip/replace path separators and `..`); the resolved write
   path must stay inside the destination dir. Write with `mode 0o600`.
6. **Collisions:** overwrite (Jira is the source of truth); return the absolute path.

### 3. Content routing (the inline "AI reads it" part — never truncated)

**Inlining applies to single-attachment (`attachmentId`) downloads.** For issue-wide
(`issueKey`) downloads, save every file to disk and return a **manifest** (each file's
saved path + metadata) **without** inlining contents — this avoids an unbounded
response. To read one of them inline, call again with its `attachmentId` (or, since the
files are saved in the working directory, the client can read a saved path directly).

Route a single attachment by `mimeType`, with an extension fallback:

- **Images** (`image/png|jpeg|gif|webp`) → MCP `image` content
  `{ type: "image", data: <base64>, mimeType }`. Full image.
- **Text-like** (`text/*`, `application/json`, `application/xml`, `*+xml`, `text/csv`,
  yaml, ndjson; extension fallback `.txt .md .log .csv .json .xml .yml .yaml`) →
  decode UTF-8, return the **complete** text (PII-scrubbed — see §4).
- **PDF** (`application/pdf`) → `pdf-parse` full text (PII-scrubbed). If extraction
  fails or yields empty text, fall back to a disk-only note (don't fail the download).
- **Everything else** (Word/Excel/binary/video) → disk-only; return a text block with
  path + metadata + "inline preview not available for `<mimeType>`".
- **No size-based truncation** anywhere. Every response also includes the saved path
  so a client may re-read from disk if it wants to chunk.

### 4. FOIPPA / PII

- **On-disk file = the original**, unredacted (the user already has Jira access — same
  as downloading via a browser).
- **Inline text and PDF-extracted text** run through `PiScrubber.scrubText` before
  entering the model context. Scrubbing **redacts**, it does not truncate — so "AI
  reads the full document" still holds.
- **Images cannot be scrubbed.** Inlining a screenshot exposes any PII in it to the
  model — the direct consequence of "let the AI see images". Called out in the tool
  description so it's a conscious choice.

### 5. Errors / edge cases

- Neither or both of `attachmentId` / `issueKey` → validation error.
- Attachment / issue not found (`404`) → clear error.
- Session expiry → handled by the authed fetch (invalidate + retry once).
- Non-login redirect on the content URL → follow once with auth.
- Empty / corrupt PDF → save to disk, return "text extraction failed" note.
- Unwritable `destDir` → clear error naming the path.
- Issue with zero attachments (by `issueKey`) → informative message, no error.

### 6. Testing

Following the existing `src/__tests__/jira-client-write.test.ts` patterns
(mock `AuthenticatedFetch`):

- `JiraClient.downloadAttachment` fetches the content URL and returns bytes + metadata.
- Content-type routing: image → image block; text → scrubbed text; PDF → extracted
  text (mock `pdf-parse`); other → disk-only note.
- Filename sanitization: path-traversal input (`../../etc/x`, `a/b.png`) resolves to a
  safe basename inside `destDir`.
- PII scrub applied to inline text.
- Validation: neither / both params provided.

## Dependencies

- Add **`pdf-parse`** to `raven/packages/jira-mcp` for PDF text extraction.
- **Risk:** `pdf-parse` is CommonJS; the monorepo is ESM. Verify the default import
  works under `NodeNext`; if it's problematic, fall back to `pdfjs-dist` (legacy build).
  To be resolved during implementation.

## Decisions locked (with the user)

1. One tool, two modes (`attachmentId` | `issueKey`).
2. Default save dir = `process.cwd()`; `destDir` override.
3. Overwrite on filename collision.
4. FOIPPA split: disk = original, inline text = scrubbed, images inlined as-is.
5. Inline types: text + image + PDF; all other types disk-only.
6. `readOnlyHint: false` (local filesystem side effect).
7. `attachmentId` mode saves **and** inlines; `issueKey` mode saves all + returns a
   manifest (no inlining).

## Inventory impact

`TOOL_INVENTORY.md` must be regenerated: jira-mcp gains one **write** tool, bumping
local write/total counts. The CI drift gate enforces this at merge time.
