# Autonomous DevOps Pipeline — Usage Guide

## Prerequisites

- RAVEN monorepo built: `npm run build` from the project root
- Atlassian credentials in `~/.raven/.env`:
  - `ATLASSIAN_BASE_URL`
  - `ATLASSIAN_EMAIL`
  - `ATLASSIAN_PASSWORD`
- Server monitoring credentials: `SERVER_A_PASSWORD` in `~/.raven/.env`
- GitHub Copilot license (the pipeline uses the Copilot SDK for AI calls)
- `gh` CLI authenticated (`gh auth login`)

## Quick Start

```bash
# Build the pipeline
npm run build -w @nrs/pipeline

# Run a dry-run to see what it would fix (no tickets or PRs created)
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --dry-run --verbose

# Run for real — creates ticket, fixes code, opens PR
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --verbose
```

---

## CLI Reference

```
raven-pipeline --server <server> --app <APP> --component <component> [options]
```

### Required Arguments

| Flag | Description | Example |
|------|-------------|---------|
| `--server` | Target server (required unless `--jira-query`) | `prod01`, `int01`, `test01` |
| `--app` | Application name / log directory name | `SOS`, `DMS`, `RRS` |
| `--component` | Component name (matches log file name) | `cwm-sos-api`, `dms-document-api` |

### Common Options

| Flag | Description | Default |
|------|-------------|---------|
| `--dry-run` | Run DETECT → TRIAGE → PLAN only, no code changes | `false` |
| `--verbose` | Show timing and debug output | `false` |
| `--jira-project` | Jira project key (if different from `--app`) | same as `--app` |
| `--bitbucket-project` | Bitbucket project key | `NRS` |
| `--bitbucket-repo` | Bitbucket repo slug (if non-standard) | inferred from component |
| `--model` | AI model to use | `claude-sonnet-4.6` |

### Pipeline Control

| Flag | Description |
|------|-------------|
| `--stop-after <N>` | Stop after step N (1=detect, 2=triage, 3=plan, 4=implement, 5=pr) |
| `--force-new` | Skip duplicate detection, always create a new Jira ticket |
| `--ticket <KEY>` | Use an existing Jira ticket, skip triage entirely |
| `--skip-tests` | Skip test execution (when tests need unavailable infrastructure) |
| `--resume` | Resume the last saved run for this app/component (required — resume is opt-in, never automatic) |
| `--fresh` | Silence the saved-state notice and start from scratch (default behavior is already fresh; this flag just hides the notice) |

### Watch Mode (Continuous)

| Flag | Description | Default |
|------|-------------|---------|
| `--watch` | Run in a loop, fixing one error per iteration | — |
| `--watch-interval <N>` | Seconds between iterations | `300` |
| `--max-iterations <N>` | Stop after N iterations | unlimited |

**Rate-limit note:** each iteration makes ~50–100 MCP calls (log scan, Jira search, Bitbucket browse, etc.) and each MCP call is throttled by `@nrs/auth`'s per-host token bucket (Atlassian: burst 30 / 10 rps; SSH: burst 5 / 2 rps). The default 300 s interval keeps these well under the cap. Lowering `--watch-interval` aggressively (e.g., below 60 s) may drain the bucket and stall iterations until tokens refill — the pipeline will still work, just more slowly. Tune via `RATE_LIMIT_*` env vars in `~/.raven/.env` if you genuinely need a tighter cadence.

### Jira Backlog Mode

| Flag | Description |
|------|-------------|
| `--jira-query <JQL>` | Process existing Jira tickets instead of scanning logs. `--server` is not required. |

---

## Example Commands

### Dry Run (Preview)

See what the pipeline would fix without creating tickets or PRs:

```bash
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --dry-run --verbose
```

### Single Fix (Live)

Detect the top error, create a ticket, generate a fix, and open a PR:

```bash
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --verbose
```

### Watch Mode — Dry Run

Preview multiple fixes in a loop without making changes:

```bash
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM \
  --watch --watch-interval 10 --max-iterations 3 --dry-run --verbose
```

### Watch Mode — Live

Continuously detect and fix errors (one per iteration):

```bash
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM \
  --watch --watch-interval 300 --max-iterations 5 --verbose
```

### Jira Backlog

Process existing bug tickets from Jira:

```bash
npx raven-pipeline --app DMS --component dms-document-api \
  --bitbucket-project DMS \
  --jira-query "project = DMS AND type = Bug AND status = Open" --verbose
```

### Fix a Specific Ticket

Skip detection/triage and jump straight to fixing a known ticket:

```bash
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM \
  --ticket CWM-775 --verbose
```

### Resume a Failed Run

If the pipeline fails mid-run (e.g., network issue during IMPLEMENT), resume from the last completed step:

```bash
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --resume --verbose
```

### Clear Saved State

Delete saved run state before starting fresh:

```bash
rm -f ~/.raven/runs/SOS-cwm-sos-api-*.json
```

---

## Server Names

| Name | Environment |
|------|-------------|
| `int01` | INT |
| `test01` | TEST |
| `prod01` | PROD |

To find available applications and components on a server, use the `discover_apps` MCP tool from your MCP client, browse the Server Monitor UI's Discover view, or run `ls {appsBase}/` directly via SSH (e.g., `ls /apps_ux/` on a Tomcat server).

---

## What the Pipeline Does (Step by Step)

| Step | What Happens | Tools Used |
|------|-------------|------------|
| 1. DETECT | SSH into server, scan logs for ERROR/FATAL | `searchLogs` from `@nrs/server-mcp/client` (in-process ssh2) |
| 2. TRIAGE | AI analyzes root cause, search Jira for duplicates, create ticket | Copilot SDK + Jira REST API |
| 3. PLAN | Find source in Bitbucket, AI generates fix plan + unified diff | Bitbucket REST API + Copilot SDK |
| 4. IMPLEMENT | Clone repo, create branch, apply patch, run tests, commit | `git` + `mvn test` / `npm test` |
| 5. CREATE PR | Push branch, create Bitbucket PR, link PR to Jira ticket | Bitbucket REST API + Jira REST API |
| 6. VALIDATE | Print summary, save run state | — |

In `--dry-run` mode, the pipeline stops after PLAN (step 3). No tickets, branches, or PRs are created.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `ATLASSIAN_EMAIL ... must be set` | Check `~/.raven/.env` has all three Atlassian variables |
| `Log file not found` | Verify `--component` matches the actual log file name. Run the `discover_apps` MCP tool, or `ls {logsBase}/{app}/` on the server. |
| `No errors found` | Logs may be clean. Try `--stop-after 1 --verbose` to see raw scan output. Check date range (7-day lookback). |
| `Duplicate found` | The error already has an open Jira ticket. Use `--force-new` to create a new ticket anyway. |
| `Source not found` | The pipeline couldn't find the Java class in Bitbucket. Check `--bitbucket-project` is correct. |
| `Patch failed to apply` | AI-generated diff didn't match the source. Branch is cleaned up automatically. Check the PLAN output for the proposed fix. |
| `Tests failed` | Fix is applied but tests didn't pass. Branch is preserved for manual review — no PR is created. |
| `Saved state exists for this app/component` notice | Informational — pipeline is starting fresh (saved state will be overwritten). Pass `--resume` to pick up where the previous run left off, or `--fresh` to silence the notice. To clear state entirely: `rm -f ~/.raven/runs/<APP>-<component>-*.json` |
| Copilot SDK auth failure | Run `gh auth login` to refresh GitHub CLI authentication |

---

## Demo Script

### Opening

> "RAVEN's autonomous pipeline detects production errors, triages them with AI, generates code fixes, and opens pull requests — all from a single CLI command."

### Demo Command (Dry Run)

```bash
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --dry-run --verbose
```

### What the Audience Sees

1. Pipeline SSHs into the server and scans logs for errors
2. AI analyzes the error and identifies root cause + severity
3. Pipeline searches Jira for duplicate tickets
4. AI locates the source code in Bitbucket and generates a fix plan
5. Fix plan displayed: root cause, affected files, proposed fix, unified diff patch

### Live Demo (Full Run)

```bash
npx raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --verbose
```

Additional steps after dry run:
6. Pipeline creates a Jira Bug ticket with full error details
7. Clones the repo, creates a branch, applies the fix, runs tests
8. Pushes the branch and creates a Bitbucket pull request
9. Links the PR back to the Jira ticket

### Key Talking Points

- End-to-end automation: one command goes from production error to pull request
- Uses GitHub Copilot SDK with `claude-sonnet-4.6` for AI analysis
- All data scrubbed for PI (FOIPPA compliance) before reaching the LLM
- Human still approves PRs — AI assists, doesn't replace
- Works with our existing Bitbucket + Jira + Jenkins infrastructure
- Watch mode can continuously detect and fix errors in a loop
- Each tool (Jira, Bitbucket, server monitoring) is independently useful outside the pipeline
