#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadEnv } from "@nrs/auth";
import { resolveJarvisBaseUrl } from "./config.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// Make sure process.env is populated using secure local store

loadEnv();

const token = process.env.JARVIS_TOKEN;
if (!token) {
  console.error("Error: JARVIS_TOKEN is not defined in the secure credential store (DPAPI or .env).");
  process.exit(1);
}

const jarvisUrl = resolveJarvisBaseUrl();

// A custom fetch that injects Authorization headers and logs requests for debugging
const secureFetch = (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const finalInit = { ...init };
  const headers = new Headers(finalInit.headers || {});
  
  // Inject the authorization header
  headers.set("Authorization", `Bearer ${token}`);
  // Print diagnostic info for the request (never log tokens)

  if ((process.env["LOG_LEVEL"] ?? "INFO").toUpperCase() === "DEBUG") {

    const method = finalInit.method || "GET";

    const target = url instanceof Request ? url.url : url.toString();

    console.error(`[Jarvis Proxy Fetch] ${method} ${target}`);

  }
  
  finalInit.headers = headers;
  return fetch(url, finalInit);
};

try {
  // 1. Initialize the remote SSE client
  const client = new Client({
    name: "jarvis-proxy-client",
    version: "0.1.0"
  }, {
    capabilities: {}
  });

  const sseTransport = new StreamableHTTPClientTransport(new URL(jarvisUrl), {
    fetch: secureFetch,
    requestInit: {
      headers: {
        "Authorization": `Bearer ${token}`
      }
    }
  });

  await client.connect(sseTransport);

  // 2. Initialize our local stdio server
  const server = new Server({
    name: "RAVEN Secure Jarvis Proxy",
    version: "0.1.0"
  }, {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {}
    }
  });

  // 3. Register request handlers that dynamically forward to the remote Jarvis server
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    return await client.listTools(request.params);
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return await client.callTool(request.params);
  });

  server.setRequestHandler(ListPromptsRequestSchema, async (request) => {
    return await client.listPrompts(request.params);
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    return await client.getPrompt(request.params);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (request) => {
    return await client.listResources(request.params);
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    return await client.readResource(request.params);
  });

  // Run stdio server
  const transport = new StdioServerTransport();
  await server.connect(transport);
} catch (error) {
  console.error("Error setting up Secure Jarvis Proxy:", error);
  process.exit(1);
}
