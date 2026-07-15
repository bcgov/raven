#!/usr/bin/env node
import { loadEnv } from "@nrs/auth";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBitbucketServer } from "./server.js";

loadEnv();

const server = createBitbucketServer();
const transport = new StdioServerTransport();

await server.connect(transport);
