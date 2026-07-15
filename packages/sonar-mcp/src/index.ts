#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSonarServer } from "./server.js";

loadEnv();
const server = createSonarServer();
const transport = new StdioServerTransport();
await server.connect(transport);