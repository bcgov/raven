import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult, ListToolsResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSysdigReadOnlyServer, type SysdigUpstreamClient } from "../server.js";

describe("createSysdigReadOnlyServer", () => {
  let localServer: ReturnType<typeof createSysdigReadOnlyServer> | undefined;
  let localClient: Client | undefined;

  afterEach(async () => {
    await localClient?.close().catch(() => {});
    await localServer?.close().catch(() => {});
    localClient = undefined;
    localServer = undefined;
  });

  it("advertises and forwards only approved read-only tools", async () => {
    const callTool = vi.fn(async (): Promise<CallToolResult> => ({
      content: [{ type: "text", text: "Contact jane.smith@gov.bc.ca" }],
    }));
    const upstream: SysdigUpstreamClient = {
      listTools: async (): Promise<ListToolsResult> => ({
        tools: [
          { name: "list_runtime_events", inputSchema: { type: "object" } },
          { name: "save_skill_state", inputSchema: { type: "object" } },
          { name: "explicit_read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
        ],
      }),
      callTool,
    };

    localServer = createSysdigReadOnlyServer(async () => upstream);
    localClient = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      localServer.connect(serverTransport),
      localClient.connect(clientTransport),
    ]);

    const listed = await localClient.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(["list_runtime_events", "explicit_read"]);

    const response = await localClient.callTool({ name: "list_runtime_events", arguments: {} });
    expect(callTool).toHaveBeenCalledOnce();
    expect(response.content).toEqual([
      { type: "text", text: "Contact [EMAIL]" },
    ]);
  });

  it("blocks a write-capable call even if a client invokes it directly", async () => {
    const callTool = vi.fn(async (): Promise<CallToolResult> => ({ content: [] }));
    const upstream: SysdigUpstreamClient = {
      listTools: async (): Promise<ListToolsResult> => ({
        tools: [
          { name: "save_skill_state", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
        ],
      }),
      callTool,
    };

    localServer = createSysdigReadOnlyServer(async () => upstream);
    localClient = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      localServer.connect(serverTransport),
      localClient.connect(clientTransport),
    ]);

    await expect(
      localClient.callTool({ name: "save_skill_state", arguments: {} }),
    ).rejects.toThrow(/not approved as read-only/);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("normalizes the legacy upstream result shape and scrubs its strings", async () => {
    const upstream: SysdigUpstreamClient = {
      listTools: async (): Promise<ListToolsResult> => ({
        tools: [{ name: "legacy_read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } }],
      }),
      callTool: async () => ({ toolResult: { email: "jane.smith@gov.bc.ca" } }),
    };

    localServer = createSysdigReadOnlyServer(async () => upstream);
    localClient = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      localServer.connect(serverTransport),
      localClient.connect(clientTransport),
    ]);

    const response = await localClient.callTool({ name: "legacy_read", arguments: {} });
    expect(response.content).toEqual([
      { type: "text", text: "{\"email\":\"[EMAIL]\"}" },
    ]);
  });
});
