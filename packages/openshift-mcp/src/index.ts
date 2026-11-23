#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOpenShiftServer } from "./server.js";

loadEnv();
const server = createOpenShiftServer();
const transport = new StdioServerTransport();
await server.connect(transport);
