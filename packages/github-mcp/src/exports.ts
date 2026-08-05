// Public subpath export — allows other packages to import the GitHub client
// directly without pulling in the MCP server or the full stdio binary.
//
// Usage:
//   import { GitHubClient } from "@nrs/github-mcp/client";
//
export { GitHubClient } from "./github-client.js";
export type {
  GitHubClientOptions,
} from "./github-client.js";
export { findingsToSarif, validateSarif, encodeSarif, computeFingerprint } from "./github-client.js";
export type { CanonicalFinding, SarifLog } from "./types.js";
