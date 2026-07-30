import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Create the RAVEN SharePoint MCP server. Tools are registered in later tasks. */
export function createSharePointServer(): McpServer {
  const server = new McpServer(
    {
      name: "RAVEN SharePoint",
      version: "0.1.0",
    },
    {
      instructions: `You have access to read-only tools for searching and reading BC Gov SharePoint Online content: project documentation, design documents, architecture diagrams, requirements, and mock-up screens stored in document libraries and site pages. All tools are READ-ONLY — never attempt to create, modify, or delete SharePoint content. The expected workflow is: search_sharepoint first (or list_sites/get_site/list_folder to browse), then read_document or read_page on the most relevant results, then summarize for the user. Always include the SharePoint URL when referencing results. Results are permission-trimmed: the user only sees content their IDIR account can access; a 403 on a specific item means they lack access to it, not that authentication failed. Keep API calls to a minimum — SharePoint Online throttles aggressively. Never call the same tool twice with the same arguments. If you encounter authentication errors ("No valid SharePoint session"), tell the user to run: node packages/auth/dist/cli.js --sharepoint (or npx raven-auth --sharepoint), or to set SPO_FEDAUTH and SPO_RTFA environment variables. NOTE: inlined image content (diagrams, mock-ups, screenshots) may contain personal information visible to the AI and cannot be PI-scrubbed.`,
    }
  );

  return server;
}
