/**
 * Force PI scrubbing ON for pipeline runs unless the operator explicitly
 * set RAVEN_SCRUB_PI in the shell for this invocation.
 *
 * The pipeline sends ticket text and stack traces to an external LLM, so
 * it must not inherit a global RAVEN_SCRUB_PI=false from ~/.raven/.env
 * (which other RAVEN tools may rely on). loadEnv() never overwrites a
 * variable that is already set in process.env, so pre-setting the value
 * here scopes the scrub-on default to this process only.
 *
 * Must be called BEFORE the first loadEnv() call.
 */
export function applyPipelineScrubDefault(): void {
  if (!("RAVEN_SCRUB_PI" in process.env)) {
    process.env["RAVEN_SCRUB_PI"] = "true";
  }
}
