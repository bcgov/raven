import type { PipelineContext, PipelineResult } from "../types.js";

/**
 * Step 6: VALIDATE — Log pipeline run results and produce summary.
 */
export function validate(ctx: PipelineContext, startTime?: number): PipelineResult {
  console.log("\n========================================");
  console.log("  RAVEN Pipeline — Run Summary");
  console.log("========================================\n");

  console.log(`Target:      ${ctx.server}/${ctx.app}/${ctx.component}`);
  console.log(`Dry run:     ${ctx.dryRun}`);
  console.log(`Errors found: ${ctx.errors.length}`);

  if (ctx.errors.length === 0) {
    console.log("\nNo errors detected — nothing to do.");
    return { success: true, stoppedAt: "detect", context: ctx };
  }

  console.log(`\nTop error:   ${ctx.errors[0]!.message.slice(0, 100)}`);
  console.log(`Occurrences: ${ctx.errors[0]!.occurrences}`);

  if (ctx.triageResult) {
    console.log(`Severity:    ${ctx.triageResult.severity}`);
    console.log(`Root cause:  ${ctx.triageResult.rootCause.slice(0, 120)}`);
  }

  if (ctx.isDuplicate) {
    console.log(`\nDuplicate of: ${ctx.ticketKey}`);
    return { success: true, stoppedAt: "triage (duplicate)", context: ctx };
  }

  if (ctx.ticketKey) {
    console.log(`Ticket:      ${ctx.ticketKey}`);
  }

  if (ctx.branchName) {
    console.log(`Branch:      ${ctx.branchName}`);
    console.log(`Commit:      ${ctx.commitHash ?? "none"}`);
    console.log(`Tests:       ${ctx.testsPass ? "passing" : "failing"}`);
  }

  if (ctx.prUrl) {
    console.log(`PR:          ${ctx.prUrl}`);
  }

  const stoppedAt = ctx.prUrl
    ? "complete"
    : ctx.branchName
      ? "create-pr"
      : ctx.fixPlan
        ? "implement"
        : ctx.ticketKey
          ? "plan"
          : "triage";

  if (startTime) {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    console.log(`Elapsed:     ${mins > 0 ? `${mins}m ${secs}s` : `${secs}s`}`);
  }
  console.log(`\nPipeline completed at step: ${stoppedAt}`);
  return { success: true, stoppedAt, context: ctx };
}
