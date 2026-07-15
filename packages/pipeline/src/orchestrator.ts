import {
  loadEnv,
  createBasicAuthFetch,
} from "@nrs/auth";
import { JiraClient } from "@nrs/jira-mcp/client";
import { BitbucketClient } from "@nrs/bitbucket-mcp/client";

import type { CliArgs, PipelineContext, PipelineResult } from "./types.js";
import { setModel, stopAI } from "./ai-client.js";
import { loadRunState, saveRunState, createRunState, type RunState } from "./run-state.js";
import { detect } from "./steps/detect.js";
import { triage, selectErrorMatchingTicket } from "./steps/triage.js";
import { plan } from "./steps/plan.js";
import { implement } from "./steps/implement.js";
import { createPr } from "./steps/create-pr.js";
import { validate } from "./steps/validate.js";
import { extractFromTicket } from "./steps/extract-from-ticket.js";

/**
 * Run the full 6-step autonomous DevOps pipeline.
 */
export async function runPipeline(args: CliArgs, processedDedupeKeys?: Set<string>): Promise<PipelineResult> {
  // Bootstrap environment and auth
  loadEnv();

  // Configure AI model
  if (args.model) {
    setModel(args.model);
  }

  const email = process.env["ATLASSIAN_EMAIL"];
  const password = process.env["ATLASSIAN_PASSWORD"];
  const baseUrl = process.env["ATLASSIAN_BASE_URL"];
  if (!email || !password || !baseUrl) {
    throw new Error(
      "ATLASSIAN_EMAIL, ATLASSIAN_PASSWORD, and ATLASSIAN_BASE_URL must be set in ~/.raven/.env"
    );
  }
  const authFetch = createBasicAuthFetch(email, password);
  const jiraClient = new JiraClient(authFetch, `${baseUrl}/int/jira`);
  const bitbucketClient = new BitbucketClient(authFetch, `${baseUrl}/int/stash`);

  // Check for existing run state. Resume only when explicitly requested
  // via --resume; saved state is otherwise informational. The previous
  // behavior auto-resumed on any saved progress, which silently swapped
  // CLI-supplied --server / --app / --component with whatever the saved
  // state targeted — a real safety issue (e.g., --server int01 could
  // end up running against prod01/PROD).
  let runState: RunState | null = null;
  let ctx: PipelineContext;
  let resumedFrom = 0;

  if (!args.fresh) {
    runState = loadRunState(args.app, args.component);
  }

  // Surface saved state to the user when present but not being resumed,
  // so they can see what's there and choose whether to --resume.
  if (
    runState &&
    !args.resume &&
    !args.fresh &&
    runState.lastCompletedStep > 0
  ) {
    const saved = runState.context;
    const targetingMatches =
      saved.server === (args.server ?? "") &&
      saved.app === args.app &&
      saved.component === args.component;
    if (targetingMatches) {
      console.log(
        `\n[RAVEN] Saved state exists for this app/component (last completed step ${runState.lastCompletedStep}).\n` +
        `        Re-run with --resume to pick up where it left off, or --fresh to silence this notice.\n` +
        `        Continuing as a fresh run; saved state will be overwritten.`,
      );
    } else {
      console.log(
        `\n[RAVEN] Saved state exists but targets a different server/app/component:\n` +
        `        saved:    ${saved.server}/${saved.app}/${saved.component}\n` +
        `        current:  ${args.server ?? "(none)"}/${args.app}/${args.component}\n` +
        `        Continuing as a fresh run; saved state will be overwritten. Pass --fresh to silence this notice.`,
      );
    }
  }

  if (runState && args.resume) {
    resumedFrom = runState.lastCompletedStep;
    ctx = runState.context;
    // Apply any overrides from current args
    ctx.dryRun = args.dryRun;
    ctx.skipTests = args.skipTests;
    ctx.verbose = args.verbose;
    if (args.existingTicket) ctx.existingTicket = args.existingTicket;
    if (args.forceNew) ctx.forceNew = args.forceNew;
    console.log(`\n[RAVEN] Resuming pipeline from step ${resumedFrom + 1}: ${ctx.app}/${ctx.component} on ${ctx.server}`);
  } else {
    ctx = {
      server: args.server ?? "",
      app: args.app,
      component: args.component,
      dryRun: args.dryRun,
      forceNew: args.forceNew,
      jiraProject: args.jiraProject ?? args.app,
      bitbucketProject: args.bitbucketProject,
      bitbucketRepo: args.bitbucketRepo,
      skipTests: args.skipTests,
      verbose: args.verbose,
      errors: [],
      processedDedupeKeys: processedDedupeKeys,
    };
    runState = createRunState(args, ctx);
  }

  const maxStep = args.stopAfter ?? 6;
  const startTime = Date.now();
  if (resumedFrom === 0) {
    console.log(`\n[RAVEN] Starting pipeline: ${ctx.app}/${ctx.component} on ${ctx.server}`);
  }
  const flags = [
    ctx.dryRun ? "DRY RUN" : "LIVE",
    maxStep < 6 ? `stop after step ${maxStep}` : "",
    args.skipTests ? "skip-tests" : "",
    args.verbose ? "verbose" : "",
  ].filter(Boolean).join(", ");
  console.log(`[RAVEN] Mode: ${flags}`);

  // PI scrubber visibility — every prompt that goes to the LLM passes
  // through PiScrubber from @nrs/auth, but the default can be overridden
  // by RAVEN_SCRUB_PI=false. Surface the actual state at run start so an
  // operator can never accidentally ship raw PII to GitHub Copilot
  // without realizing the scrubber is off.
  const scrubEnabled = process.env["RAVEN_SCRUB_PI"] !== "false" && process.env["RAVEN_SCRUB_PI"] !== "0";
  if (scrubEnabled) {
    console.log(`[RAVEN] PI scrubbing: ENABLED (FOIPPA-compliant — PII stripped from all LLM prompts)`);
  } else {
    console.warn(`[RAVEN] PI scrubbing: DISABLED — RAVEN_SCRUB_PI=${process.env["RAVEN_SCRUB_PI"]}. Raw ticket text and stack traces will be sent to the LLM. Confirm this is intentional.`);
  }
  console.log("");

  const verbose = args.verbose ?? false;
  const stepTime = (label: string, start: number) => {
    if (verbose) {
      const ms = Date.now() - start;
      console.log(`[VERBOSE] ${label} completed in ${(ms / 1000).toFixed(1)}s`);
    }
  };

  try {
    // Step 1: DETECT — always re-run (logs may have changed)
    let t = Date.now();
    await detect(ctx);
    stepTime("DETECT", t);

    // In watch mode, filter out errors already processed in previous iterations
    if (ctx.processedDedupeKeys && ctx.processedDedupeKeys.size > 0) {
      const before = ctx.errors.length;
      ctx.errors = ctx.errors.filter((e) => !ctx.processedDedupeKeys!.has(e.dedupeKey));
      if (before !== ctx.errors.length) {
        console.log(`[DETECT] Filtered ${before - ctx.errors.length} already-processed error(s), ${ctx.errors.length} remaining`);
      }
    }

    runState.lastCompletedStep = 1;
    runState.context = ctx;
    saveRunState(runState);
    if (ctx.errors.length === 0 || maxStep <= 1) {
      return validate(ctx, startTime);
    }

    // Step 2: TRIAGE — skip if ctx.ticketKey already exists (from previous run)
    if (resumedFrom >= 2 && ctx.ticketKey) {
      console.log(`[TRIAGE] Resuming — using saved ticket: ${ctx.ticketKey}`);
    } else if (args.existingTicket) {
      ctx.ticketKey = args.existingTicket;
      ctx.isDuplicate = false;
      console.log(`[TRIAGE] Using existing ticket: ${ctx.ticketKey}`);

      // Reorder ctx.errors so the one matching the ticket is first.
      // Without this, PLAN/IMPLEMENT pick errors[0] (highest occurrence count)
      // even when the ticket describes a different, less-frequent error.
      if (ctx.errors.length > 1) {
        try {
          const ticket = await jiraClient.getIssue(ctx.ticketKey);
          const ticketText = `${ticket.fields.summary}\n${ticket.fields.description ?? ""}`;
          const matchIdx = selectErrorMatchingTicket(ctx.errors, ticketText);
          if (matchIdx > 0) {
            const matched = ctx.errors[matchIdx]!;
            ctx.errors.splice(matchIdx, 1);
            ctx.errors.unshift(matched);
            console.log(
              `[TRIAGE] Reordered errors: matched error #${matchIdx + 1} to ticket subject (${matched.message.slice(0, 80)})`,
            );
          } else if (matchIdx === -1) {
            console.log(
              `[TRIAGE] Warning: no detected error matched ticket ${ctx.ticketKey} — proceeding with top error by occurrence count`,
            );
          }
        } catch (e) {
          console.log(
            `[TRIAGE] Could not fetch ticket ${ctx.ticketKey} for matching: ${(e as Error).message} — proceeding with top error by occurrence count`,
          );
        }
      }
    } else {
      t = Date.now();
      await triage(ctx, jiraClient);
      stepTime("TRIAGE", t);
    }
    runState.lastCompletedStep = 2;
    runState.context = ctx;
    saveRunState(runState);
    if (maxStep <= 2) {
      return validate(ctx, startTime);
    }

    // In dry-run mode, stop after plan unless --stop-after explicitly requests more steps
    // (dry-run still generates the fix plan so we can show what would be fixed)

    // Step 3: PLAN — skip if ctx.fixPlan already exists
    if (resumedFrom >= 3 && ctx.fixPlan) {
      console.log(`[PLAN] Resuming — using saved fix plan`);
    } else if (!ctx.isDuplicate) {
      t = Date.now();
      await plan(ctx, bitbucketClient);
      stepTime("PLAN", t);
    }
    runState.lastCompletedStep = 3;
    runState.context = ctx;
    saveRunState(runState);
    if (maxStep <= 3) {
      return validate(ctx, startTime);
    }

    // In dry-run mode, stop after plan unless --stop-after explicitly requests more
    if (ctx.dryRun && !args.stopAfter) {
      return validate(ctx, startTime);
    }

    // Step 4: IMPLEMENT — skip if ctx.commitHash already exists
    if (resumedFrom >= 4 && ctx.commitHash) {
      console.log(`[IMPLEMENT] Resuming — using saved commit: ${ctx.commitHash.slice(0, 8)}`);
    } else if (ctx.fixPlan?.patch) {
      t = Date.now();
      await implement(ctx, bitbucketClient);
      stepTime("IMPLEMENT", t);
    }
    runState.lastCompletedStep = 4;
    runState.context = ctx;
    saveRunState(runState);
    if (maxStep <= 4) {
      return validate(ctx, startTime);
    }

    // Step 5: CREATE PR — skip if ctx.prUrl already exists
    if (resumedFrom >= 5 && ctx.prUrl) {
      console.log(`[PR] Resuming — using saved PR: ${ctx.prUrl}`);
    } else if (ctx.branchName) {
      t = Date.now();
      await createPr(ctx, bitbucketClient, jiraClient);
      stepTime("CREATE-PR", t);
    }
    runState.lastCompletedStep = 5;
    runState.context = ctx;
    saveRunState(runState);

    // Step 6: VALIDATE — always re-run
    const result = validate(ctx);
    runState.lastCompletedStep = 6;
    runState.context = ctx;
    saveRunState(runState);
    return result;
  } catch (error) {
    console.error(`\n[RAVEN] Pipeline failed: ${(error as Error).message}`);
    if (runState) {
      runState.error = (error as Error).message;
      runState.context = ctx;
      saveRunState(runState);
    }
    return {
      success: false,
      error: (error as Error).message,
      context: ctx,
    };
  } finally {
    await stopAI();
  }
}

/**
 * Watch mode: run the pipeline in a loop, sleeping between iterations.
 * Each iteration starts fresh. Stops on Ctrl-C, --max-iterations, or
 * 2 consecutive zero-error scans.
 */
export async function runPipelineWatch(args: CliArgs): Promise<void> {
  const interval = args.watchInterval ?? 300;
  const maxIter = args.maxIterations ?? Infinity;
  let iteration = 0;
  let consecutiveEmpty = 0;
  let stopping = false;
  // Track processed errors across iterations so dry-run watch can skip them
  const processedKeys = new Set<string>();

  process.on("SIGINT", () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log("\n[WATCH] Ctrl-C received — finishing current run then exiting...");
  });

  while (iteration < maxIter && !stopping) {
    iteration++;
    console.log(`\n${"=".repeat(50)}`);
    console.log(`  WATCH — Iteration ${iteration}${maxIter < Infinity ? `/${maxIter}` : ""}`);
    console.log(`${"=".repeat(50)}\n`);

    const iterArgs = { ...args, fresh: true, watch: false };
    const result = await runPipeline(iterArgs, processedKeys);

    // Track which error was processed this iteration
    const topError = result.context.errors[0];
    if (topError) {
      processedKeys.add(topError.dedupeKey);
    }

    if (result.context.errors.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) {
        console.log(`\n[WATCH] No errors found for 2 consecutive scans — stopping.`);
        break;
      }
    } else {
      consecutiveEmpty = 0;
    }

    if (stopping || iteration >= maxIter) break;

    console.log(`\n[WATCH] Sleeping ${interval}s before next scan...`);
    await sleep(interval * 1000, () => stopping);
    if (stopping) break;
  }

  console.log(`\n[WATCH] Completed ${iteration} iteration(s).`);
}

/**
 * Jira backlog mode: fetch tickets from a JQL query and run plan→implement→PR
 * for each one.
 */
export async function runJiraBacklog(args: CliArgs): Promise<void> {
  loadEnv();
  if (args.model) setModel(args.model);

  const email = process.env["ATLASSIAN_EMAIL"];
  const password = process.env["ATLASSIAN_PASSWORD"];
  const baseUrl = process.env["ATLASSIAN_BASE_URL"];
  if (!email || !password || !baseUrl) {
    throw new Error("ATLASSIAN_EMAIL, ATLASSIAN_PASSWORD, and ATLASSIAN_BASE_URL must be set in ~/.raven/.env");
  }
  const authFetch = createBasicAuthFetch(email, password);
  const jiraClient = new JiraClient(authFetch, `${baseUrl}/int/jira`);
  const bitbucketClient = new BitbucketClient(authFetch, `${baseUrl}/int/stash`);

  console.log(`\n[RAVEN] Jira backlog mode: ${args.jiraQuery}`);

  const searchResults = await jiraClient.searchIssues(args.jiraQuery!, 20);
  const tickets = searchResults.issues;

  if (tickets.length === 0) {
    console.log("[RAVEN] No tickets matched the query.");
    return;
  }

  console.log(`[RAVEN] Found ${tickets.length} ticket(s) to process.\n`);

  let processed = 0;
  let failed = 0;

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i]!;
    console.log(`\n${"=".repeat(50)}`);
    console.log(`  Ticket ${i + 1}/${tickets.length}: ${ticket.key} — ${ticket.fields.summary}`);
    console.log(`${"=".repeat(50)}\n`);

    try {
      // Extract error info from ticket
      const { errors, triageResult } = await extractFromTicket(ticket.key, jiraClient);

      // Build context for this ticket
      const ctx: PipelineContext = {
        server: args.server ?? "",
        app: args.app,
        component: args.component,
        dryRun: args.dryRun,
        jiraProject: args.jiraProject ?? args.app,
        bitbucketProject: args.bitbucketProject,
        bitbucketRepo: args.bitbucketRepo,
        skipTests: args.skipTests,
        verbose: args.verbose,
        errors,
        ticketKey: ticket.key,
        isDuplicate: false,
        triageResult,
      };

      const maxStep = args.stopAfter ?? 6;
      const verbose = args.verbose ?? false;
      const t = (label: string, start: number) => {
        if (verbose) console.log(`[VERBOSE] ${label} completed in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      };

      // Step 3: PLAN
      if (maxStep >= 3) {
        const s = Date.now();
        await plan(ctx, bitbucketClient);
        t("PLAN", s);
      }

      // Step 4: IMPLEMENT
      if (maxStep >= 4 && ctx.fixPlan?.patch) {
        const s = Date.now();
        await implement(ctx, bitbucketClient);
        t("IMPLEMENT", s);
      }

      // Step 5: CREATE PR
      if (maxStep >= 5 && ctx.branchName) {
        const s = Date.now();
        await createPr(ctx, bitbucketClient, jiraClient);
        t("CREATE-PR", s);
      }

      validate(ctx);
      processed++;
    } catch (error) {
      console.error(`[RAVEN] Failed on ${ticket.key}: ${(error as Error).message}`);
      failed++;
    }
  }

  console.log(`\n[RAVEN] Jira backlog complete: ${processed} processed, ${failed} failed out of ${tickets.length} tickets.`);
  await stopAI();
}

/** Sleep with early exit support. */
function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (shouldStop()) {
        clearInterval(interval);
        resolve();
      }
    }, 500);
    setTimeout(() => {
      clearInterval(interval);
      resolve();
    }, ms);
  });
}
