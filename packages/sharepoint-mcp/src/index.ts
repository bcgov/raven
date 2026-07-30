#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSharePointServer } from "./server.js";

loadEnv();

const server = createSharePointServer();
const transport = new StdioServerTransport();

await server.connect(transport);
