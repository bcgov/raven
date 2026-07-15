#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOverviewServer } from "./server.js";

loadEnv();

const server = createOverviewServer();
const transport = new StdioServerTransport();

await server.connect(transport);
