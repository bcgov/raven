import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});
turndown.remove(["script", "style"]);
turndown.addRule("em", {
  filter: ["em"],
  replacement: (content) => `*${content}*`,
});

/**
 * Convert a modern site page's CanvasContent1 markup to markdown.
 *
 * CanvasContent1 is HTML: text webparts carry their content as regular
 * markup inside data-sp-rte containers; non-text webparts serialize their
 * config into data-sp-webpartdata attributes (dropped here). Turndown
 * extracts the readable text and structure. The format is undocumented and
 * can change — on any failure return "" and let the caller degrade to
 * linking the page instead of breaking.
 */
export function extractPageMarkdown(canvasContent: string): string {
  if (!canvasContent || !canvasContent.trim()) return "";
  try {
    return turndown
      .turndown(canvasContent)
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return "";
  }
}
