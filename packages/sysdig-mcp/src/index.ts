#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnv } from "@nrs/auth";
import { resolveSysdigMcpUrl } from "./config.js";
import { connectSysdigClient } from "./oauth.js";
import { createSysdigReadOnlyServer, type SysdigUpstreamClient } from "./server.js";

loadEnv();
const sysdigUrl = resolveSysdigMcpUrl();
let connection: Awaited<ReturnType<typeof connectSysdigClient>> | undefined;
let connectionPromise: Promise<Awaited<ReturnType<typeof connectSysdigClient>>> | undefined;

const getClient = async (): Promise<SysdigUpstreamClient> => {
  connectionPromise ??= connectSysdigClient(sysdigUrl)
    .then((connected) => {
      connection = connected;
      return connected;
    })
    .catch((error: unknown) => {
      connectionPromise = undefined;
      throw error;
    });
  return (await connectionPromise).client;
};

const server = createSysdigReadOnlyServer(getClient);
const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = async () => {
  await server.close();
  await connection?.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
