#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCssServer } from "./server.js";

loadEnv();
const server = createCssServer();
const transport = new StdioServerTransport();
await server.connect(transport);
