#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBugClassifierServer } from "./server.js";

loadEnv();

const server = createBugClassifierServer();
const transport = new StdioServerTransport();

await server.connect(transport);
