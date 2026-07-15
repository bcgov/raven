#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdoServer } from "./server.js";

loadEnv();

const server = createAdoServer();
const transport = new StdioServerTransport();

await server.connect(transport);
