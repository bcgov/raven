# Autonomous DevOps Pipeline

An AI-driven pipeline that detects production errors, triages them, generates code fixes, and creates pull requests — with minimal human intervention.

## Architecture

The pipeline is implemented as `@nrs/pipeline`, a standalone CLI (`raven-pipeline`) that orchestrates six steps end-to-end. It uses the **GitHub Copilot SDK** (`@github/copilot-sdk`) for AI analysis and code generation, and RAVEN's existing MCP server packages for Jira, Bitbucket, and server monitoring integration.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        raven-pipeline CLI                              │
│                                                                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌────────┐ │
│  │  DETECT   │→│  TRIAGE   │→│   PLAN    │→│ IMPLEMENT  │→│ CREATE │ │
│  │ (Step 1)  │  │ (Step 2)  │  │ (Step 3)  │  │ (Step 4)   │  │  PR    │ │
│  └──────────┘  └──────────┘  └──────────┘  └───────────┘  └────────┘ │
│       │              │              │              │              │     │
│  server-mcp     Copilot SDK    Copilot SDK    git clone      Bitbucket │
│  (SSH logs)     + Jira MCP     + Bitbucket    git apply      REST API  │
│                                  MCP           mvn test                 │
│                                                                        │
│                    ┌──────────┐                                        │
│                    │ VALIDATE │ ← Step 6: Summary + run state          │
│                    │ (Step 6)  │                                        │
│                    └──────────┘                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### AI Layer: GitHub Copilot SDK

All AI calls go through `ai-client.ts`, which wraps the `@github/copilot-sdk`:

- **Authentication**: Uses the developer's GitHub Copilot license (via `gh` CLI auth)
- **Default model**: `claude-sonnet-4.6` (configurable via `--model`)
- **PI scrubbing**: All prompts are scrubbed for personal information (names, emails, IDIRs, SINs) via `@nrs/auth` PiScrubber before being sent to the API — FOIPPA compliance
- **Session lifecycle**: Each AI call creates a fresh Copilot session with no built-in tools (text-only responses), then destroys it
- **Timeout**: 120 seconds per AI call

### Internal Dependencies

| Package | Used For |
|---------|----------|
| `@nrs/server-mcp` | SSH log scanning via the in-process `searchLogs` function |
| `@nrs/jira-mcp` | Search, create, update, and comment on Jira tickets |
| `@nrs/bitbucket-mcp` | Browse files, list repos, search code, create branches and PRs |
| `@nrs/auth` | SiteMinder/Basic Auth for Atlassian APIs, PI scrubbing |
| `@github/copilot-sdk` | AI analysis (triage, planning, code generation) |

---

## Pipeline Steps

### Step 1: DETECT

Scans server logs for ERROR/FATAL entries via SSH.

- Uses `searchLogs` (from `@nrs/server-mcp/client`) to SSH into the target server via `ssh2` in-process — same path as the rest of RAVEN's SSH operations, so it inherits the per-host rate limiter and circuit breaker
- Checks today's log first, then walks back up to 7 days
- Parses log output into structured `ErrorInfo` entries with stack traces
- Deduplicates errors by exception class + first stack frame
- Merges related errors (e.g., same app class across different stack traces)
- Filters shell noise from prompts, grep commands, and control sequences

**Output**: `ctx.errors[]` — sorted by occurrence count, highest first.

### Step 2: TRIAGE

AI-analyzes the top error and checks Jira for duplicates.

- Sends the stack trace to the Copilot SDK for root cause analysis (severity, summary, suggested ticket title)
- Searches Jira for existing tickets matching the error (last 90 days, open status)
- If duplicate found: adds a "seen again" comment to the existing ticket, tries the next error
- If all errors are duplicates: stops the pipeline (nothing new to fix)
- If new error found: checks for resolved historical tickets (regression detection)
- Creates a new Jira Bug ticket with: error details, root cause analysis, stack trace, severity, `raven-pipeline` + `auto-detected` labels

**Output**: `ctx.ticketKey`, `ctx.triageResult`, `ctx.isDuplicate`

### Step 3: PLAN

Locates source code in Bitbucket and generates a fix plan with AI.

- Extracts Java class/file names from the stack trace
- Searches for source files across Bitbucket repos using three strategies:
  1. **Repo map cache** (`~/.raven/repo-map.json`) — instant lookup from previous runs
  2. **Bitbucket `/files` endpoint** — single API call returns flat recursive file list per repo
  3. **Sibling repos** — searches up to 10 filtered repos in the same Bitbucket project (parallel, batches of 5)
- Always searches the original component repo even when cache points elsewhere
- Validates Bitbucket project keys against a known-good list (200+ projects) to avoid 404s
- Reads matching source files and sends them + the stack trace to AI for fix planning
- AI returns: root cause, proposed fix, affected files, and a unified diff patch

**Output**: `ctx.fixPlan` (with `.patch` in unified diff format)

### Step 4: IMPLEMENT

Clones the repo, applies the patch, runs tests, and commits.

- Clones the target repo to `~/.raven/repos/<project>/<repo>` (or updates existing clone)
- Creates branch: `bugfix/<ticket-key>-<description>`
- Applies the AI-generated patch using:
  1. `git apply` (strict, then fuzzy with `--ignore-whitespace`)
  2. Line-level text replacement fallback (handles whitespace/indent mismatches from AI output)
- Runs tests: `mvn test -q -DskipITs` for Maven, `npm test` for Node.js
- Commits with message: `<TICKET-KEY> Fix <summary>`
- Credential handling: temporarily injects auth into clone URL, then scrubs it from git remote

**Output**: `ctx.branchName`, `ctx.commitHash`, `ctx.testsPass`

### Step 5: CREATE PR

Pushes the branch and creates a Bitbucket pull request.

- Pushes branch to Bitbucket with authenticated URL (scrubbed after push)
- Creates PR via Bitbucket REST API with: root cause, fix description, test status
- PR title follows convention: `<TICKET-KEY> - <suggested title>`
- Adds a comment to the Jira ticket with a link to the PR
- Auto-detects default branch (main vs master)

**Output**: `ctx.prUrl`

### Step 6: VALIDATE

Logs a run summary and saves state.

- Prints: target, errors found, severity, root cause, ticket, branch, commit, test status, PR link, elapsed time
- Returns `PipelineResult` with success/failure and the step reached

---

## Operating Modes

### Single Run (default)

Runs the pipeline once for one application component.

```bash
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM
```

### Dry Run (`--dry-run`)

Runs DETECT → TRIAGE → PLAN, shows the fix plan, then stops. No tickets created, no code changes.

```bash
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --dry-run --verbose
```

### Watch Mode (`--watch`)

Runs the pipeline in a continuous loop. Each iteration starts fresh and detects the next unprocessed error.

```bash
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM \
  --watch --watch-interval 60 --max-iterations 5
```

- Tracks processed error `dedupeKey`s across iterations (in-memory Set) to avoid re-analyzing the same error
- Stops on: Ctrl-C, `--max-iterations` reached, or 2 consecutive zero-error scans
- Combines with `--dry-run` to preview what would be fixed without making changes
- Each iteration makes ~50–100 MCP calls (log scan + Jira search + Bitbucket browse). All calls are throttled by `@nrs/auth`'s per-host token bucket (Atlassian: burst 30 / 10 rps; SSH: burst 5 / 2 rps), so a too-aggressive `--watch-interval` will simply pause the pipeline until tokens refill rather than tripping bastion alerts

### Jira Backlog Mode (`--jira-query`)

Processes existing Jira tickets instead of scanning logs. Skips DETECT and TRIAGE.

```bash
raven-pipeline --app DMS --component dms-document-api \
  --jira-query "project = DMS AND type = Bug AND status = Open" \
  --bitbucket-project DMS
```

- Fetches tickets via JQL, extracts error info from description/comments
- For each ticket: runs PLAN → IMPLEMENT → CREATE-PR
- `--server` is not required (no log scanning)

---

## Run State & Resume

Pipeline state is persisted to `~/.raven/runs/<APP>-<component>-<date>.json` after each step. This enables:

- **Default behavior**: starts fresh, overwriting any saved state. If saved state exists, the pipeline prints an informational notice (telling you what's there and how to opt into resuming) but otherwise proceeds with the current CLI args.
- **Resume**: `--resume` is required — never automatic. Picks up from the last completed step using the saved targeting (server / app / component / ticket key); CLI flags `--dry-run`, `--skip-tests`, `--verbose`, `--force-new`, `--ticket` still apply.
- **Fresh start**: `--fresh` silences the saved-state notice (default already runs fresh; this flag just hides the message).
- Transient data (like `processedDedupeKeys` Sets) is stripped from JSON serialization.

Why explicit-only resume: prior auto-resume behavior would silently swap CLI-provided `--server` / `--app` / `--component` with whatever the saved state targeted. That meant invoking the pipeline against `int01` could end up running against `prod01` (PROD) if a previous run had targeted PROD. Resume is now opt-in only.

---

## Human Checkpoints

The pipeline creates PRs but does **not** merge them. Human review is required:

1. **PR review** — A developer reviews the AI-generated fix and approves/requests changes
2. **CI/CD** — Jenkins (Bitbucket) or GitHub Actions runs the full build/test/deploy pipeline
3. **Acceptance testing** — Human verifies the fix in TEST environment

These checkpoints can be progressively reduced as confidence in the pipeline grows.

---

## Key Design Decisions

- **GitHub Copilot SDK** for AI — uses the developer's existing Copilot license, no separate API keys needed
- **PI scrubbing on all AI calls** — FOIPPA compliance, personal information never reaches the LLM
- **Bitbucket `/files` endpoint** — single API call per repo replaces recursive tree walking (10x faster)
- **Repo map cache** — file-to-repo mappings cached across runs to skip Bitbucket searches
- **Validated project keys** — 200+ known Bitbucket project keys prevent searching non-existent projects
- **Dual patch strategy** — `git apply` first, then line-level text replacement for AI-generated patches with whitespace issues
- **Branch naming**: `bugfix/<ticket-key>-<description>` (BC Gov standard)
- **Commit convention**: `<TICKET-KEY> Fix <summary>` with detailed description
- **Credential hygiene**: Auth URLs are injected for clone/push only, then immediately scrubbed from git remotes
