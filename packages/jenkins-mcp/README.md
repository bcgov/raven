# Jenkins MCP

Generic Jenkins primitives for RAVEN. Migration-specific sequencing and success policy belong in the migration orchestrator, not this server.

## Tool surface

- Controller and inventory: get_controller_info, list_jobs, get_job, list_agents, list_plugins
- Job parameters and configuration: get_job_parameters, get_job_config, create_job, copy_job, update_job_config, enable_job, disable_job
- Queue and builds: get_queue, get_queue_item, cancel_queue_item, list_builds, get_build, trigger_build, stop_build
- Logs and evidence: get_build_console, get_progressive_console, list_build_artifacts, download_build_artifact, get_build_test_report, get_build_changes
- Promotions: list_promotions, get_promotion, trigger_promotion
- Credentials: list_credentials, get_credential_metadata, create_credential, update_credential, delete_credential

## Authentication

Set JENKINS_URL or JENKINS_BASE_URL to an absolute HTTPS URL. The server rejects HTTP before authentication or session setup. Dedicated authentication uses JENKINS_USER with JENKINS_TOKEN, JENKINS_API_TOKEN, or JENKINS_PASSWORD. When those are absent, the server uses the cached SMSESSION flow. The client retains Jenkins servlet-session cookies so password and SMSESSION writes reuse the session that issued their CSRF crumb. Basic-Auth errors are returned directly and never fall back to interactive browser authentication.

On Windows, `scripts/setup-credentials.ps1` stores `JENKINS_URL`, `JENKINS_USER`, `JENKINS_TOKEN`, and `JENKINS_PASSWORD` in the DPAPI-encrypted Raven credential file. API tokens remain the recommended write credential.

## Safety controls

- MCP instructions require user confirmation before write tools are called.
- get_job_config redacts secret-bearing XML elements, including legacy Jenkins build authorization tokens, in model-visible output.
- Exact job XML is exported only beneath RAVEN_JENKINS_CONFIG_DIR (default ~/.raven/jenkins-configs) with mode 0600.
- update_job_config requires the SHA-256 of the current controller config, refuses stale updates, writes a mode-0600 backup, and re-reads the controller config after the update.
- Artifact downloads are restricted to RAVEN_JENKINS_DOWNLOAD_DIR (default ~/.raven/jenkins-downloads).
- Credential writes accept `JENKINS_`-prefixed environment-variable references or mode-restricted regular files beneath RAVEN_JENKINS_SECRET_DIR (default ~/.raven/jenkins-secrets). Raw secrets and references to other Raven services' environment variables are not accepted in MCP arguments or returned in responses.
- Protected paths reject traversal and symlink escapes.
- Write requests reject redirects to authentication pages instead of reporting false success.
- Jenkins base URLs must use HTTPS, so authentication headers and credential payloads cannot be sent over cleartext HTTP.

Credential create/update/delete and promotion operations are plugin-provided endpoints, not stable Jenkins core APIs. Validate them against the configured controller and installed plugin versions before autonomous live mutations.

## Verification

Run from the raven workspace root:

    npm run build
    npm test
    npm run gen-inventory:check

The focused Jenkins tests are in src/__tests__/jenkins-client.test.ts and src/__tests__/server.test.ts.
