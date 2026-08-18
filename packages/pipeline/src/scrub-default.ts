/**
 * Force PI scrubbing ON for pipeline runs — unconditionally.
 *
 * The pipeline sends ticket text and stack traces to an external LLM, so
 * scrubbing is mandatory (FOIPPA): there is no opt-out, not even an
 * explicit RAVEN_SCRUB_PI=false in the shell. A global false in
 * ~/.raven/.env still applies to other RAVEN tools — only this process
 * pins the variable.
 *
 * Must be called BEFORE the first loadEnv() call, and it wins regardless
 * because it overwrites whatever is already set.
 */
export function applyPipelineScrubDefault(): void {
  process.env["RAVEN_SCRUB_PI"] = "true";
}
