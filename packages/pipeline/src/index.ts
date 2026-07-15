#!/usr/bin/env node

import { parseArgs } from "node:util";
import type { CliArgs } from "./types.js";
import { runPipeline, runPipelineWatch, runJiraBacklog } from "./orchestrator.js";

function printUsage(): void {
  console.log(`
RAVEN Autonomous DevOps Pipeline

Usage:
  raven-pipeline --server <server> --app <APP> --component <component> [options]

Required:
  --server       Target server (e.g., prod01, int01)
  --app          Application/Jira project key (e.g., DMS, RRS)
  --component    Component name (e.g., dms-document-api)

Options:
  --dry-run              Run detect + triage + plan, then stop (no code changes, no PR)
  --stop-after <N>       Stop after step N (1=detect, 2=triage, 3=plan, 4=implement, 5=pr)
  --force-new            Skip duplicate detection, always create a new ticket
  --ticket <KEY>         Use existing Jira ticket, skip triage (e.g., CWM-775)
  --jira-project         Jira project key (default: same as --app)
  --bitbucket-project    Bitbucket project key (default: same as --app)
  --bitbucket-repo       Bitbucket repo slug (default: inferred from component)
  --resume               Resume the last run for this app/component
  --fresh                Ignore saved state, start from scratch
  --skip-tests           Skip test execution (when tests need unavailable infrastructure)
  --verbose              Enable verbose logging
  --model                AI model to use (default: claude-sonnet-4.6)
  --help                 Show this help message

Watch mode (continuous):
  --watch                Run continuously, looping detect→fix→PR
  --watch-interval <N>   Seconds between iterations (default: 300)
  --max-iterations <N>   Stop after N iterations

Jira backlog mode:
  --jira-query <JQL>     Process existing Jira tickets (--server not required)

Examples:
  raven-pipeline --server prod01 --app DMS --component dms-document-api
  raven-pipeline --server prod01 --app DMS --component dms-document-api --dry-run
  raven-pipeline --server int01 --app RRS --component rrs-api --bitbucket-repo nr-rrs
  raven-pipeline --server prod01 --app DMS --component dms-document-api --watch --watch-interval 60
  raven-pipeline --app DMS --component dms-document-api --jira-query "project = DMS AND type = Bug AND status = Open"
`);
}

/**
 * Parse a numeric CLI flag value; reject NaN. parseInt("abc", 10) returns
 * NaN and silently flowed through to the orchestrator before, where the
 * later `?? defaults` checks couldn't distinguish "user typed garbage"
 * from "user didn't pass the flag".
 */
function parseIntFlag(name: string, raw: string): number {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    console.error(`Error: --${name} must be an integer (got "${raw}").\n`);
    printUsage();
    process.exit(1);
  }
  return n;
}

function parseCliArgs(): CliArgs | null {
  try {
    const { values } = parseArgs({
      options: {
        server: { type: "string" },
        app: { type: "string" },
        component: { type: "string" },
        "dry-run": { type: "boolean", default: false },
        "stop-after": { type: "string" },
        "force-new": { type: "boolean", default: false },
        ticket: { type: "string" },
        "bitbucket-project": { type: "string" },
        "jira-project": { type: "string" },
        "bitbucket-repo": { type: "string" },
        resume: { type: "boolean", default: false },
        fresh: { type: "boolean", default: false },
        "skip-tests": { type: "boolean", default: false },
        verbose: { type: "boolean", default: false },
        watch: { type: "boolean", default: false },
        "watch-interval": { type: "string" },
        "max-iterations": { type: "string" },
        "jira-query": { type: "string" },
        model: { type: "string" },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });

    if (values.help) {
      printUsage();
      return null;
    }

    const jiraQuery = values["jira-query"];

    // --server is required unless in jira-query mode
    if (!jiraQuery && !values.server) {
      console.error("Error: --server is required (unless using --jira-query).\n");
      printUsage();
      process.exit(1);
    }
    if (!values.app || !values.component) {
      console.error("Error: --app and --component are required.\n");
      printUsage();
      process.exit(1);
    }

    return {
      server: values.server,
      app: values.app,
      component: values.component,
      dryRun: values["dry-run"] ?? false,
      stopAfter: values["stop-after"] ? parseIntFlag("stop-after", values["stop-after"]) : undefined,
      forceNew: values["force-new"] ?? false,
      existingTicket: values.ticket,
      jiraProject: values["jira-project"],
      bitbucketProject: values["bitbucket-project"],
      bitbucketRepo: values["bitbucket-repo"],
      model: values.model,
      resume: values.resume ?? false,
      fresh: values.fresh ?? false,
      skipTests: values["skip-tests"] ?? false,
      verbose: values.verbose ?? false,
      watch: values.watch ?? false,
      watchInterval: values["watch-interval"] ? parseIntFlag("watch-interval", values["watch-interval"]) : undefined,
      maxIterations: values["max-iterations"] ? parseIntFlag("max-iterations", values["max-iterations"]) : undefined,
      jiraQuery,
    };
  } catch (error) {
    console.error(`Error: ${(error as Error).message}\n`);
    printUsage();
    process.exit(1);
  }
}

const args = parseCliArgs();
if (args) {
  if (args.jiraQuery) {
    await runJiraBacklog(args);
  } else if (args.watch) {
    await runPipelineWatch(args);
  } else {
    const result = await runPipeline(args);
    process.exit(result.success ? 0 : 1);
  }
}
