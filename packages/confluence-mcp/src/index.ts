#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createConfluenceServer } from "./server.js";

loadEnv();

const server = createConfluenceServer();
const transport = new StdioServerTransport();

await server.connect(transport);
