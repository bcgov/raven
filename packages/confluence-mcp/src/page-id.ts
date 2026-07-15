/**
 * Extracts a bare Confluence page ID from any of the supported input forms:
 *
 *   - Plain numeric string:          "298126062"
 *   - viewpage.action query param:   "…/viewpage.action?pageId=298126062"
 *   - /pages/<id> path segment:      "…/pages/298126062" or "…/pages/298126062/Title"
 *
 * Whitespace is trimmed before parsing. Throws if no page ID can be extracted.
 */
export function parsePageId(input: string): string {
  const trimmed = input.trim();

  if (trimmed === "") {
    throw new Error(
      `Cannot extract a Confluence page ID from: "". Pass a plain numeric ID (e.g. "298126062") or a full Confluence page URL.`
    );
  }

  // Plain numeric ID — most common fast path.
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }

  // Try parsing as a URL (handles both full URLs and bare paths via a dummy base).
  let url: URL;
  try {
    url = new URL(trimmed, "https://placeholder.invalid");
  } catch {
    throw new Error(
      `Cannot extract a Confluence page ID from: "${trimmed}". Pass a plain numeric ID (e.g. "298126062") or a full Confluence page URL.`
    );
  }

  // viewpage.action?pageId=<id>
  const pageIdParam = url.searchParams.get("pageId");
  if (pageIdParam && /^\d+$/.test(pageIdParam)) {
    return pageIdParam;
  }

  // /pages/<numeric-id>[/anything]
  const pagesMatch = url.pathname.match(/\/pages\/(\d+)(?:\/|$)/);
  if (pagesMatch) {
    return pagesMatch[1];
  }

  throw new Error(
    `Cannot extract a Confluence page ID from: "${trimmed}". Pass a plain numeric ID (e.g. "298126062") or a full Confluence page URL.`
  );
}
