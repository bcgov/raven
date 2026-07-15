import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  // Self-close void elements (<br/>, <hr/>, <img/>) so output is valid XHTML.
  // Confluence storage format requires XHTML-compliant markup; HTML5-style
  // open <br>, <hr>, <img> tags are rejected by the storage-format parser.
  xhtmlOut: true,
});

/**
 * Post-process markdown-it's table output to match Confluence storage format.
 *
 * Confluence's storage format does not accept <thead>; tables use <tbody>
 * only, with <th> cells in the first row indicating headers. Markdown-it
 * produces <thead><tr>...</tr></thead><tbody><tr>...</tr></tbody>, which
 * Confluence rejects as invalid XHTML when posted via the API.
 *
 * This rewrite merges the thead's contents into the tbody, preserving the
 * header row's <th> cells so Confluence still styles them as headers. The
 * standalone-thead fallback handles the degenerate case of a header-only
 * table (no <tbody> follows), converting <thead> directly to <tbody>.
 *
 * Exported for testing.
 */
export function fixConfluenceTableFormat(html: string): string {
  // Case 1: <thead>...</thead><tbody>...</tbody> → merged <tbody>
  const merged = html.replace(
    /<thead>([\s\S]*?)<\/thead>\s*<tbody>([\s\S]*?)<\/tbody>/g,
    "<tbody>$1$2</tbody>",
  );
  // Case 2: any remaining <thead> with no following <tbody> → convert to <tbody>
  return merged
    .replace(/<thead>/g, "<tbody>")
    .replace(/<\/thead>/g, "</tbody>");
}

/**
 * Convert Markdown to HTML suitable for Confluence storage format.
 *
 * Output is XHTML-compliant (void elements self-closed) with table markup
 * adjusted to match Confluence's storage-format expectations (<tbody> only,
 * no <thead>).
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown || markdown.trim().length === 0) {
    return "";
  }
  try {
    return fixConfluenceTableFormat(md.render(markdown));
  } catch {
    return `<p>${markdown}</p>`;
  }
}
