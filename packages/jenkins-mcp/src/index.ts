#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createJenkinsServer } from "./server.js";

loadEnv();

const server = createJenkinsServer();
const transport = new StdioServerTransport();

await server.connect(transport);
