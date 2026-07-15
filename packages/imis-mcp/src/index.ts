#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createImisServer } from "./server.js";

loadEnv();

const server = createImisServer();
const transport = new StdioServerTransport();

await server.connect(transport);
