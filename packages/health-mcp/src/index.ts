#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHealthServer } from "./server.js";

loadEnv();

const server = createHealthServer();
const transport = new StdioServerTransport();

await server.connect(transport);
