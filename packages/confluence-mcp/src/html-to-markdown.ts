import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// Remove script and style elements
turndown.remove(["script", "style"]);

/**
 * Convert Confluence HTML storage format to clean Markdown.
 * Equivalent of html_to_markdown() from confluence_mcp.py (line 279).
 */
export function htmlToMarkdown(html: string): string {
  try {
    return turndown.turndown(html);
  } catch {
    // Fallback: return raw HTML if conversion fails
    return html;
  }
}
