// Library entry point for in-process use:
//   import { KubeOpenShiftReader } from "@nrs/openshift-mcp/client";
export { KubeOpenShiftReader, loadKubeConfig } from "./openshift-client.js";
export type { KubeObject, ListOptions, ListResult, OpenShiftReader, PodLogOptions } from "./openshift-client.js";
export { createOpenShiftServer } from "./server.js";
export type { OpenShiftServerOptions } from "./server.js";
