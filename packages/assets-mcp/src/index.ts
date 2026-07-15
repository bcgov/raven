#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAssetsServer } from "./server.js";

loadEnv();

const server = createAssetsServer();
const transport = new StdioServerTransport();

await server.connect(transport);
