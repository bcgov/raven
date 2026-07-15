# RAVEN Autonomous DevOps Pipeline

The pipeline automatically detects production errors, triages them with AI, finds the relevant source code, generates a fix, applies it, and opens a pull request — all in a single command.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   raven-pipeline CLI                     │
│                    (src/index.ts)                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│                   Orchestrator                           │
│                (src/orchestrator.ts)                      │
│                                                          │
│  Loads env, initializes clients, manages run state,      │
│  executes steps in sequence with checkpointing.          │
└──────┬──────┬──────┬──────┬──────┬──────┬───────────────┘
       │      │      │      │      │      │
       ▼      ▼      ▼      ▼      ▼      ▼
   ┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐┌──────┐
   │DETECT││TRIAGE││ PLAN ││IMPL. ││  PR  ││VALID.│
   │  1   ││  2   ││  3   ││  4   ││  5   ││  6   │
   └──┬───┘└──┬───┘└──┬───┘└──┬───┘└──┬───┘└──────┘
      │       │       │       │       │
      ▼       ▼       ▼       ▼       ▼
  server-  jira-mcp  bitbucket  git    bitbucket
  mcp      + AI      -mcp + AI clone   -mcp
                                       + jira-mcp
```

### Step-by-Step Flow

| Step | Name | What It Does | Side Effects |
|------|------|-------------|--------------|
| 1 | **DETECT** | SSH into server, scan logs for exceptions | None (read-only) |
| 2 | **TRIAGE** | AI analyzes errors, checks Jira for duplicates, creates ticket | Creates Jira ticket |
| 3 | **PLAN** | Finds source files across repos, AI generates fix patch | None (read-only) |
| 4 | **IMPLEMENT** | Clones repo, applies patch, runs tests, commits | Local git changes |
| 5 | **CREATE PR** | Pushes branch, opens Bitbucket PR, comments on Jira ticket (only if tests pass) | PR + Jira comment |
| 6 | **VALIDATE** | Prints summary of everything that happened | None |

### MCP Server Integration

The pipeline uses RAVEN's MCP servers as direct library imports (not over MCP protocol):

| Package | Steps | Operations |
|---------|-------|------------|
| `@nrs/server-mcp` | DETECT | `searchLogs` (in-process ssh2) for log scanning |
| `@nrs/jira-mcp` | TRIAGE, PR | Search issues, create issues, add comments |
| `@nrs/bitbucket-mcp` | PLAN, IMPLEMENT, PR | Browse files, read files, list repos, create PRs |
| `@nrs/auth` | All | Environment loading, basic auth, PI scrubbing |

### AI Integration

Uses GitHub Copilot SDK (`@github/copilot-sdk`) for AI operations:

- **Default model:** `claude-sonnet-4.6` (override with `--model`)
- **TRIAGE:** Analyzes error + stack trace → JSON with severity, root cause, suggested title
- **PLAN:** Given source files + error → JSON fix plan + unified diff patch
- **PI scrubbing:** All prompts scrubbed of personal information before sending (FOIPPA compliance)
- **Zero data retention:** Copilot Business tier

## Code Structure

```
packages/pipeline/
├── __tests__/
│   └── pipeline.test.ts    Unit tests (vitest)
├── src/
│   ├── index.ts            CLI entry point, arg parsing
│   ├── orchestrator.ts     Main pipeline loop, state management
│   ├── types.ts            All shared types (ErrorInfo, TriageResult, FixPlan, PipelineContext)
│   ├── run-state.ts        Persistent run state (save/load/resume)
│   ├── repo-map.ts         Repo mapping cache (app/component → Bitbucket project/repo)
│   ├── ai-client.ts        Copilot SDK wrapper (askAI, setModel, stopAI)
│   ├── steps/
│   │   ├── detect.ts       Step 1 — log scanning + error extraction
│   │   ├── triage.ts       Step 2 — AI analysis + Jira duplicate check + ticket creation
│   │   ├── plan.ts         Step 3 — cross-repo source finding + AI fix generation
│   │   ├── implement.ts    Step 4 — clone, patch, test, commit
│   │   ├── create-pr.ts    Step 5 — push branch, create PR, Jira comment
│   │   └── validate.ts     Step 6 — summary output
│   ├── test-detect.ts      Isolated step 1 test script
│   ├── test-triage.ts      Steps 1-2 test script (read-only)
│   ├── test-plan.ts        Steps 1-3 test script (read-only)
│   └── find-file.ts        Utility — search Bitbucket repos for files
├── package.json
└── tsconfig.json
```

### Key Types

```typescript
// Shared state accumulated across all steps
interface PipelineContext {
  // Input
  server: string;              // Target server (e.g., "prod01")
  app: string;                 // Application key (e.g., "SOS")
  component: string;           // Component name (e.g., "cwm-sos-api")
  dryRun: boolean;
  jiraProject: string;         // May differ from app (e.g., SOS errors → CWM project)

  // Step outputs (populated as pipeline progresses)
  errors: ErrorInfo[];         // Step 1
  ticketKey?: string;          // Step 2
  triageResult?: TriageResult; // Step 2
  fixPlan?: FixPlan;           // Step 3
  sourceProject?: string;      // Step 3 (when fix is in a different repo)
  sourceRepo?: string;         // Step 3
  branchName?: string;         // Step 4
  commitHash?: string;         // Step 4
  testsPass?: boolean;         // Step 4
  prUrl?: string;              // Step 5
}
```

### Source Discovery Strategy (Step 3)

The PLAN step uses a 4-stage strategy to find the source code that needs fixing:

1. **Direct file paths** — extract `src/main/java/...` paths from stack traces
2. **Repo tree walk** — search the app repo for matching class names
3. **Dependency parsing** — read `pom.xml`, extract internal `ca.bc.gov` dependencies, search those repos
4. **Sibling repo search** — list all repos in the Bitbucket project, search each for target classes

This enables fixes in shared libraries (e.g., `cwm-generic-lib`) when the error originates in the app repo (e.g., `cwm-sos-api`).

### Patch Application (Step 4)

Two fallback strategies for applying AI-generated patches:

1. **`git apply`** — tries strict, then `--ignore-whitespace`, then `-C1` (fuzzy context)
2. **Line-level replacement** — parses the diff for `-`/`+` lines, finds matching content by trimmed comparison, replaces preserving original indentation

The fallback handles AI-generated patches where whitespace (tabs vs spaces) doesn't match the target file exactly.

### State Persistence

After each step, the pipeline saves its state to `~/.raven/runs/<APP>-<COMPONENT>-<YYYYMMDD>.json`. If interrupted, the next run automatically resumes:

| Step | Resume Behavior |
|------|----------------|
| DETECT | Always re-runs (logs may have changed) |
| TRIAGE | Skips if `ticketKey` already saved (avoids duplicate tickets) |
| PLAN | Skips if `fixPlan` already saved |
| IMPLEMENT | Skips if `commitHash` already saved (branch/commit on disk) |
| CREATE PR | Skips if `prUrl` already saved (avoids duplicate PRs) |
| VALIDATE | Always re-runs |

Cloned repositories persist at `~/.raven/repos/<project>/<repo>/` and are reused across runs.

### Repo Mapping Cache

When the PLAN step discovers that a fix lives in a different repo (e.g., `cwm-generic-lib` instead of `cwm-sos-api`), it saves this mapping to `~/.raven/repo-map.json`. On subsequent runs for the same app/component, the cached mapping is used automatically — skipping the expensive cross-repo search.

If the primary Bitbucket project doesn't exist (404), the PLAN step falls back to searching other known projects from the repo map, then common projects like "CWM" and "NRS".

### PR Gating

The CREATE PR step will **not** create a pull request if tests fail. The branch and commit are preserved so the developer can fix tests locally and re-run the pipeline.

## Operating the Pipeline

### Prerequisites

```bash
# Environment variables in ~/.raven/.env
ATLASSIAN_EMAIL="your.name@gov.bc.ca"
ATLASSIAN_PASSWORD="your-atlassian-token"
ATLASSIAN_BASE_URL="https://apps.example.gov.bc.ca"
RAVEN_SCRUB_PI="true"
```

### Build

```bash
cd ~/Projects/raven
npm run build -w @nrs/pipeline
```

### Basic Usage

```bash
# Full pipeline — detect errors, create ticket, generate fix, open PR
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM

# Dry run — detect and triage only, no code changes or tickets
raven-pipeline --server prod01 --app DMS --component dms-document-api --dry-run
```

### All Flags

| Flag | Description |
|------|-------------|
| `--server <name>` | **(required)** Target server (e.g., `prod01`, `int01`) |
| `--app <key>` | **(required)** Application key (e.g., `DMS`, `SOS`, `RRS`) |
| `--component <name>` | **(required)** Component name (e.g., `dms-document-api`) |
| `--dry-run` | Detect + triage only, no code changes or tickets |
| `--stop-after <N>` | Stop after step N (1=detect, 2=triage, 3=plan, 4=implement, 5=pr) |
| `--force-new` | Skip duplicate detection, always create a new ticket |
| `--ticket <KEY>` | Use existing Jira ticket, skip triage (e.g., `CWM-775`) |
| `--jira-project <key>` | Jira project key if different from `--app` |
| `--bitbucket-project <key>` | Bitbucket project key (default: same as `--app`) |
| `--bitbucket-repo <slug>` | Bitbucket repo slug (default: inferred from component) |
| `--model <name>` | AI model override (default: `claude-sonnet-4.6`) |
| `--resume` | Resume the last run for this app/component |
| `--fresh` | Ignore saved state, start from scratch |

### Common Workflows

```bash
# Test detection only
raven-pipeline --server prod01 --app SOS --component cwm-sos-api --stop-after 1

# Detect + triage + plan (no git operations)
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --stop-after 3

# Use an existing ticket (skip triage, no new ticket)
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --ticket CWM-775

# Resume after a crash
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --resume

# Fresh run, ignore any saved state
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --fresh

# Force new ticket even if duplicate exists
raven-pipeline --server prod01 --app SOS --component cwm-sos-api \
  --jira-project CWM --bitbucket-project CWM --force-new
```

### Test Scripts

For incremental testing without side effects:

```bash
# Step 1 only (no AI, no Jira)
node packages/pipeline/dist/test-detect.js --server prod01 --app DMS --component dms-document-api

# Steps 1-2 (AI analysis, Jira search — read-only, no ticket creation)
node packages/pipeline/dist/test-triage.js --server prod01 --app SOS --component cwm-sos-api

# Steps 1-3 (source discovery + AI fix plan — read-only, no git operations)
node packages/pipeline/dist/test-plan.js --server prod01 --app SOS --component cwm-sos-api \
  --bb-project CWM --bb-repo cwm-sos-api
```

### File Locations

| Path | Purpose |
|------|---------|
| `~/.raven/.env` | Atlassian credentials |
| `~/.raven/runs/*.json` | Pipeline run state (for resume) |
| `~/.raven/repo-map.json` | Cached app/component → Bitbucket project/repo mappings |
| `~/.raven/repos/<project>/<repo>/` | Cloned repositories |

### Security Notes

- Credentials are never stored in git — only in `~/.raven/.env`
- Clone URLs temporarily embed credentials for auth, then reset to non-auth URLs
- Git error messages are scrubbed of credentials before logging
- All AI prompts are PI-scrubbed (names, emails, phones, IDIRs, SINs, tokens) per FOIPPA
- Copilot Business tier provides zero data retention
