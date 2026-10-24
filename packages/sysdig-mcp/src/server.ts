import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CompatibilityCallToolResult,
  type CallToolResult,
  type ListToolsResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { PiScrubber } from "@nrs/auth";
import { filterReadOnlyTools } from "./read-only.js";

export interface SysdigUpstreamClient {
  listTools(params?: { cursor?: string }): Promise<ListToolsResult>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
  ): Promise<CallToolResult | CompatibilityCallToolResult>;
}

function scrubStringValues(value: unknown, scrubber: PiScrubber): unknown {
  if (typeof value === "string") return scrubber.scrubText(value);
  if (Array.isArray(value)) return value.map((item) => scrubStringValues(item, scrubber));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubStringValues(item, scrubber)]),
    );
  }
  return value;
}

function normalizeToolResult(
  result: CallToolResult | CompatibilityCallToolResult,
): CallToolResult {
  if ("content" in result && Array.isArray(result.content)) return result as CallToolResult;
  if (!("toolResult" in result)) {
    throw new Error("Sysdig returned an unsupported tool result.");
  }
  const serialized = typeof result.toolResult === "string"
    ? result.toolResult
    : JSON.stringify(result.toolResult) ?? String(result.toolResult);
  return { content: [{ type: "text", text: serialized }] };
}

async function findReadOnlyTool(
  client: SysdigUpstreamClient,
  toolName: string,
): Promise<Tool | undefined> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    const matchingTool = filterReadOnlyTools(page.tools).find((tool) => tool.name === toolName);
    if (matchingTool) return matchingTool;
    if (!page.nextCursor) return undefined;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("Sysdig returned a repeated tools-list cursor.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("Sysdig tool catalog exceeded the pagination safety limit.");
}

export function createSysdigReadOnlyServer(
  getClient: () => Promise<SysdigUpstreamClient>,
): Server {
  const server = new Server(
    { name: "Raven Sysdig Read-only MCP", version: "0.2.0" },
    { capabilities: { tools: {} } },
  );
  const scrubber = new PiScrubber();

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await (await getClient()).listTools(request.params);
    return {
      ...result,
      tools: filterReadOnlyTools(result.tools),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const upstream = await getClient();
    const tool = await findReadOnlyTool(upstream, request.params.name);
    if (!tool) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Sysdig tool '${request.params.name}' is unavailable or is not approved as read-only.`,
      );
    }
    const result = normalizeToolResult(await upstream.callTool(request.params));
    return scrubStringValues(result, scrubber) as CallToolResult;
  });

  return server;
}
