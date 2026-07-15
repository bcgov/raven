import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute filesystem path to the raven-auth CLI (`packages/auth/dist/cli.js`).
 * Resolved from this module's own location so it works regardless of where
 * the repo is checked out. Use it when surfacing a "run this to authenticate"
 * hint to the user — the path embedded in static instruction strings can
 * easily drift from the actual layout.
 */
export const authCliPath: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "cli.js",
);
