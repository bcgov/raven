#!/usr/bin/env node
/**
 * Test script: Run ONLY the detect step (log scanning).
 * No AI calls, no Jira, no git operations.
 *
 * Usage: node packages/pipeline/dist/test-detect.js --server prod01 --app DMS --component dms-document-api
 */
import { parseArgs } from "node:util";
import { loadEnv } from "@nrs/auth";
import { detect } from "./steps/detect.js";
import type { PipelineContext } from "./types.js";

loadEnv();

const { values } = parseArgs({
  options: {
    server: { type: "string" },
    app: { type: "string" },
    component: { type: "string" },
  },
  strict: true,
});

if (!values.server || !values.app || !values.component) {
  console.error("Usage: test-detect --server <server> --app <APP> --component <component>");
  process.exit(1);
}

const ctx: PipelineContext = {
  server: values.server,
  app: values.app,
  component: values.component,
  dryRun: true,
  jiraProject: values.app,
  errors: [],
};

await detect(ctx);

console.log(`\n--- Raw errors (${ctx.errors.length}) ---`);
for (const err of ctx.errors) {
  console.log(`\n[${err.occurrences}x] ${err.dedupeKey}`);
  console.log(err.stackTrace.split("\n").slice(0, 8).join("\n"));
  if (err.stackTrace.split("\n").length > 8) {
    console.log("  ...(truncated)");
  }
}
