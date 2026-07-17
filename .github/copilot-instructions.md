# RAVEN — Repository Instructions for Copilot

**Trust these instructions.** They have been validated end-to-end on `main`. Only fall back to file/code search when the answer is genuinely missing or appears wrong.

> **Documentation map:** `README.md` = setup & usage · `docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md` = architecture & security · this file = AI-agent operating guide · `docs/TOOL_INVENTORY.md` = the source of truth for the server/tool catalog, read/write split, and env vars. Don't restate tool counts or the catalog here — link to `docs/TOOL_INVENTORY.md`.

## What this repo is

RAVEN is a **TypeScript / Node.js npm-workspace monorepo** for BC Gov NR Sector. It ships:

- **15 MCP (Model Context Protocol) servers** that bridge a local LLM to Atlassian (Jira, Confluence, Bitbucket), Azure DevOps Server, Jenkins, Artifactory, BC Gov server logs over SSH, IMIS server inventory, Jira Assets CMDB, bug pattern classification, project-health analytics, SonarQube code quality, RFC scheduling, and Jarvis application inventory.
- **`@nrs/server-ui`** — an Express web dashboard at `http://localhost:3777` for monitoring app servers.
- **`@nrs/pipeline`** — an autonomous DevOps CLI (`raven-pipeline`) that detects production errors, triages with AI, generates fixes, and opens PRs.

There are **15 MCP workspaces** under `packages/`. **TypeScript 5.9 strict, ES2022, NodeNext modules.** Tests use **vitest**. **Node ≥20** required (see `engines` in `package.json`).

The repo lives inside the `bcgov-c/epsilon` monorepo at path `raven/`. Most paths in this file are relative to `raven/` (the npm workspace root).

## Build, test, and run — validated commands

ALWAYS run these from the **`raven/` directory** (where `package.json` lives), in this order:

```bash
npm install              # ~2–10s when up-to-date; lockfile is the source of truth
npm run build            # tsc --build across all workspaces; ~2–4s on a warm cache
npm test                 # vitest run; ~1.5–3s; all tests pass on main (CI reports the count)
```

Per-package builds and tests:

```bash
npm run build -w @nrs/<pkg>                                # build one workspace
npx vitest run --root . packages/<pkg>/__tests__           # tests in one package
```

Notes that have bitten us:

- **Build first, then test** is NOT required (vitest reads `.ts` directly), BUT `@nrs/server-ui` consumes `@nrs/server-mcp/client` via its built `dist/` — if you change `server-mcp` and run server-ui's build alone, build `@nrs/server-mcp` first.
- **Lockfile drift breaks `npm ci`.** When you add a dependency, declare it in the workspace's own `package.json`, not the root. After dependency changes run `npm install` and commit the resulting `package-lock.json` change.
- The root `package.json` may list a workspace path that does not yet exist on `main` (e.g., `packages/pipeline` was historically declared before the dir landed). **npm tolerates this; don't "fix" it by removing the entry unless you understand the consequences for in-flight branches.**
- `npm run clean` (= `tsc --build --clean`) removes `dist/` and `tsconfig.tsbuildinfo` across the repo. Use it if a stale build artifact causes weird type errors.
- Server-ui dev: `npm start -w @nrs/server-ui` (binds 127.0.0.1:3777). Override with `SERVER_UI_PORT`.

## Project layout

```
raven/
├── .github/copilot-instructions.md          ← this file
├── .mcp.json                                ← MCP server registry consumed by clients
├── package.json                             ← workspaces list + root scripts
├── tsconfig.json                            ← project references for `tsc --build`
├── tsconfig.base.json                       ← strict TS settings inherited by every workspace
├── vitest.config.ts                         ← test globs: packages/**/__tests__/**/*.test.ts and scripts/**/*.test.mjs
├── README.md                                ← user-facing setup & usage
├── docs/TOOL_INVENTORY.md                    ← source of truth: tool catalog, read/write split, env vars
├── SERVER_MONITOR_UI.md
├── .env.example
├── servers.conf.example                     ← server inventory format for SSH packages
└── packages/
    ├── auth/           — @nrs/auth: BasicAuth + SiteMinder/SMSESSION + PiScrubber + ServerEntry types
    ├── jira-mcp/       — @nrs/jira-mcp: Jira REST client + MCP server. Exports `./client` for in-process use.
    ├── confluence-mcp/ — @nrs/confluence-mcp
    ├── bitbucket-mcp/  — @nrs/bitbucket-mcp
    ├── overview-mcp/   — @nrs/overview-mcp (cross-system project summary)
    ├── health-mcp/     — @nrs/health-mcp (project/portfolio analytics)
    ├── assets-mcp/     — @nrs/assets-mcp (Jira Assets / Insight CMDB)
    ├── bug-classifier-mcp/ — @nrs/bug-classifier-mcp (Bug pattern classifier)
    ├── ado-mcp/        — @nrs/ado-mcp (Azure DevOps Server MCP)
    ├── jarvis-mcp/     — @nrs/jarvis-mcp (Jarvis secure proxy MCP)
    ├── sonar-mcp/      — @nrs/sonar-mcp (SonarQube issues/quality gate/hotspots/metrics + local scan)
    ├── artifactory-mcp/ — @nrs/artifactory-mcp (Artifactory artifacts, build-info, guarded transfers)
    ├── jenkins-mcp/    — @nrs/jenkins-mcp (Jenkins jobs/builds/config/queue/artifacts/promotions/credentials)
    ├── server-mcp/     — @nrs/server-mcp: in-process ssh2 + log search. Exports `./client`.
    ├── imis-mcp/       — @nrs/imis-mcp: SSH explorer for IMIS-tracked servers. Exports `./client`.
    ├── server-ui/      — @nrs/server-ui (Express dashboard, port 3777)
    └── raven-cli/      — @nrs/raven-cli (CLI entry point binding several MCPs)
```

Each MCP package follows the same shape: `src/index.ts` (stdio server entry), `src/server.ts` (tool definitions), `src/<topic>-client.ts` (HTTP/SSH client), `src/exports.ts` (the `./client` subpath export), `src/__tests__/*.test.ts`, `package.json` (`type: module`, `main: dist/index.js`, `bin: { raven-<pkg>: dist/index.js }`), `tsconfig.json` (extends `../../tsconfig.base.json`, references `../auth`).

## Wire-up checklist for adding a new package

If you add `packages/foo-mcp/`, you MUST also:

1. Add `"packages/foo-mcp"` to root `package.json` `workspaces`.
2. Add `{ "path": "packages/foo-mcp" }` to root `tsconfig.json` `references`.
3. If it's an MCP server, add an entry to root `.mcp.json` (`{"command": "node", "args": ["./packages/foo-mcp/dist/index.js"]}`).
4. Run `npm install` from `raven/` to update `package-lock.json`.
5. Add tests under `packages/foo-mcp/src/__tests__/` (vitest discovers automatically).
6. Build: `npm run build` — must succeed clean.

Skipping any of (1)–(3) leaves the package as dead code that the standard `npm install` / `npm run build` flow won't compile or expose.

## Adding or changing an MCP tool

Every `server.tool(...)` registration **must** declare a read/write annotation as the argument just before the handler — `{ readOnlyHint: true }` for read-only tools, `{ readOnlyHint: false }` for tools that mutate state (create / update / delete / run):

```ts
server.tool("read_thing",  "…", { /* schema */ }, { readOnlyHint: true  }, handler);
server.tool("write_thing", "…", { /* schema */ }, { readOnlyHint: false }, handler);
```

**"Mutates" means it changes the connected upstream system** (Jira / Confluence / Bitbucket / Azure DevOps / SonarQube / a monitored server) — not purely-local effects. A tool that only writes to the local machine is read-only here: e.g. `clone_repo` clones a repo to local disk but does not modify the Bitbucket remote, so it is `readOnlyHint: true`.

The read/write split in `docs/TOOL_INVENTORY.md` (and the security doc) is **generated from these annotations** and is enforced by CI: `npm run gen-inventory:check` fails if any tool is missing the hint or the inventory is stale. After adding / removing / renaming a tool, run `npm run gen-inventory` and commit the result — never hand-edit the block between the `GEN` markers.

## Conventions (CLAUDE.md / WORKFLOW.md restated)

- **Branches:** `type/TICKET-### short-desc` where type ∈ {feature, bugfix, refactor, documentation, spike}.
- **Commits:** imperative subject ≤ 50 chars (e.g., `TICKET-### Fix UUID parse on empty`). Body explains *why*, not *what*.
- **PR title:** `TICKET-### - Description` (e.g., `DEMO-291 - Create build pipeline for CWM`).
- **PR target:** `main`. Branch protection (ruleset "Epsilon main branch") requires 1 approval from someone other than the last pusher; squash-merge is the convention.
- **Tests:** vitest, lives at `packages/<pkg>/src/__tests__/*.test.ts` (or `packages/<pkg>/__tests__/`).
- **Jira project key is `PROJ1`** (three S's), NOT `ISSDP`. Bitbucket project keys often differ from their Jira counterparts (try `NR-XXX` / `NRS-XXX` variants).

## Trust & security model — DO NOT flag these as bugs

- **SSH host key verification is intentionally disabled** in every `packages/*-mcp` SSH helper (`hostVerifier: () => true`, matching legacy `server-cmd.exp` / `StrictHostKeyChecking=no`). RAVEN reaches BC Gov internal servers (prod01/test01/int01) over an authenticated VPN; the trust boundary is the VPN tunnel + `SERVER_A_PASSWORD`, not TLS-style host pinning. Do not flag MITM concerns for SSH code in these packages.
- **`ca.bc.gov*` strings in stack-trace parsers are Java package names**, not URLs/hosts. `startsWith("ca.bc.gov.")` style checks are not URL sanitization — do not treat them as such.
- **PI scrubbing via `PiScrubber` from `@nrs/auth` is mandatory** before any prompt is sent to an LLM (FOIPPA). Anonymized strings like `Person-1` / `Person-2` are intentional output, not a bug.
- **All `server-mcp`, `imis-mcp`, `health-mcp`, `assets-mcp`, `overview-mcp` operations are READ-ONLY** by design.
- **Atlassian MCP packages must accept dual auth.** Prefer `ATLASSIAN_EMAIL` + `ATLASSIAN_PASSWORD` Basic Auth, fall back to SiteMinder via `SessionManager` + `createAuthenticatedFetch` from `@nrs/auth`. A package that hard-fails when env vars are missing is a bug — flag it.

## CI / checks that run on PRs

- **CodeQL** (org-level workflow on `bcgov-c/epsilon`): `Analyze (actions)`, `Analyze (javascript-typescript)`, plus a top-level `CodeQL` summary run. Must be SUCCESS to merge under the ruleset.
- **`Add Jira Task Link to PR`** (`.github/workflows/jira_task.yml` at the epsilon-monorepo root) auto-comments a Jira link when the branch name contains `DEMO-###`.
- **No repo-level build/test workflow** is run in CI; reviewers rely on `npm run build` + `npm test` succeeding locally. **Always run both before pushing.**

## When to search vs. trust these instructions

Trust this file for build/test commands, project layout, conventions, and trust-model rules above. **Search the codebase only when:**

- A path here is missing (e.g., a new package introduced after this file was written).
- A command above produces output that contradicts this file (then update this file in the same PR).
- You need a specific symbol or call site that's not described here — use `grep`/`rg` against `packages/*/src/`.

---

# RAVEN MCP Tools — Chat-time Reference

Everything above is for repo navigation and PR review. **The sections below are for Copilot Chat in IDEs when this repo's MCP servers are connected** (clients pick these up via `.mcp.json`). RAVEN's MCP servers connect only to your configured BC Gov upstreams (Jira, Confluence, Bitbucket, app servers, and — when enabled — ADO, Sonar, Artifactory, RFC Buddy, and the `jarvis-mcp` remote proxy); they add no third-party data sinks beyond those. Artifactory direct downloads may additionally read from explicitly allowlisted HTTPS storage hosts without sending Artifactory credentials. See [`../docs/TOOL_INVENTORY.md`](../docs/TOOL_INVENTORY.md).

**CRITICAL:** When a user asks you to do something, **actively call the tools** — do not just describe what you would do. Chain multiple tool calls together to complete multi-step tasks.

> **Team Standards:** The Epsilon team's version control workflow, branching strategy, commit guidelines, and PR process are documented in [`../WORKFLOW.md`](../WORKFLOW.md) (one level above this repo, in the root of the epsilon repository). Read and follow those standards for all Git and GitHub operations in this workspace.

## Available Tools

> The authoritative catalog, per-server tool counts, and read/write split live in [`../docs/TOOL_INVENTORY.md`](../docs/TOOL_INVENTORY.md). The entries below add **operational guidance** (when and how to call each tool), not an exhaustive list.

### Server Monitoring (7 tools — READ-ONLY)

- `server_dashboard` — Error counts and versions across all servers. Optional: `app` filter.
- `search_server_logs` — Search app logs. Params: `server`, `app`, `component`, `pattern`, `maxLines`, `context`, `logType`, `date`.
- `search_httpd_logs` — Search Apache httpd reverse-proxy logs (DMZ / internal NR proxy servers).
- `discover_apps` — List all deployed apps on a server.
- `get_versions` — Compare deployed versions across environments.
- `diff_server_config` — Compare config (context.xml, web.xml, server.xml) between environments.
- `jvm_heap` — Live JVM memory usage for a component.

Log search tips: `logType` can be "app" (default), "catalina", or "access". Use `context: 3` to see stack traces. Common apps: RRS, DMS, CIRRAS, FTA, FNCS, CWM, SNCSC, SOS, ILRR.

### Jenkins

Uses `JENKINS_URL` / `JENKINS_BASE_URL`. Dedicated authentication uses `JENKINS_USER` plus `JENKINS_TOKEN`, `JENKINS_API_TOKEN`, or `JENKINS_PASSWORD`; otherwise it falls back to cached SMSESSION authentication. It does not reuse Atlassian Basic Auth credentials.

Jenkins tools are generic primitives across controller/job/build/queue/artifact/test/change/promotion/credential domains. Confirm before write calls. Job config writes require protected XML plus the current SHA-256. Credential writes accept only environment/file secret references. See `docs/TOOL_INVENTORY.md` and `packages/jenkins-mcp/README.md` for the generated tool surface and safety controls.

### IMIS Server Inventory (6 tools — READ-ONLY)

Discovery tools search a local CSV export of the IMIS database (no network needed). Exploration tools SSH into servers (requires VPN + `SERVER_A_PASSWORD` in `~/.raven/.env`).

- `search_servers` — Search IMIS server inventory. Filter by `type`, `status`, `business_area`, `os`, `zone`. Free-text searches name/FQDN/description/notes/IP.
- `get_server` — Full details for a specific server — identity, network, OS, hardware, storage, services, agent status, notes.
- `server_stats` — Summary statistics — totals and breakdowns by status, type, OS family, zone, business area.
- `list_server_apps` — List app directories on a remote server (default: `/apps_ux`, `/sw_ux`). Requires VPN + SSH.
- `explore_server` — Run a read-only command on a remote server. Whitelisted commands only (ls, cat, grep, find, df, ps, etc.). Requires VPN + SSH.
- `read_server_file` — Read a file from a remote server. Absolute path only. Requires VPN + SSH.

**CSV data**: Loaded from `IMIS_CSV_PATH` env var or `~/.raven/imis-servers.csv`. If not found, discovery tools will return an error.

### Assets / CMDB (14 tools — READ-ONLY)

Query the Jira Assets (Insight) CMDB for ministry applications, environments, technologies, and people. Uses AQL (Asset Query Language) for `search_assets`.

**Application-centric helpers:**
- `search_assets` — Search Jira Assets via AQL. Example: `objectType = "Applications" AND Name LIKE "RRS"`.
- `get_application` — Look up an app by name or acronym. Returns all CMDB attributes.
- `list_app_environments` — Get DEV/TEST/PROD environment details — URLs, servers, DB instances.
- `get_app_people` — Get all people associated with an app and their roles (PO, Dev, Architect, etc.).
- `get_app_technologies` — Get technology stack — languages, frameworks, databases, servers.
- `find_apps_by_technology` — Find all apps using a specific technology. Useful for CVE impact analysis.
- `find_apps_by_person` — Find all apps associated with a person in any role. Uses `outboundReferences` AQL — aggregates across all matching People objects so partial names like "Smith" return all relevant apps with attribution.
- `find_apps_by_org` — Find apps by org unit — Ministry, Division, Branch. Portfolio reporting.
- `get_app_connected_tickets` — Get Jira tickets linked to an application asset.

**Generic object / schema introspection:**
- `get_object` — Fetch any asset object by numeric ID with full attributes.
- `get_object_attributes` — Raw attribute list (with IDs and types) for an object. More granular than `get_object`.
- `get_object_history` — Change history for an object — who changed which attribute, when, from→to.
- `list_schemas` — All accessible CMDB schemas with their IDs and object counts.
- `list_object_types` — Object types within a schema (e.g., "Applications", "Application Environments", "People").

### Jira (30 tools)

**Search & read:**
- `search_issues` — Search by JQL. Example: `project = DEMO AND status != Done ORDER BY updated DESC`. Supports `startAt` for paging beyond `maxResults` (up to 200/page).
- `read_issue` — Full issue details (description, changelog, metadata). Use after `search_issues`.
- `list_comments` — All comments on an issue.
- `list_worklogs` — Time entries on an issue with author, date, total hours.
- `list_attachments` — Files on an issue with filename, size, mime type, and download URL.

**Write (issues & comments):**
- `create_issue` — Create a ticket. Params: `projectKey`, `summary`, `description`, `issueType`, `priority`, `labels`, `epicKey`.
- `update_issue` — Update ticket fields. Supports `epicKey` for Epic Link updates.
- `add_comment` — Add a comment. Uses Jira wiki markup.
- `update_comment` — Replace an existing comment's body.
- `delete_comment` — Remove a comment (confirm with user first).
- `transition_issue` — Change status (e.g., "Under Review", "In Progress", "Done").
- `link_issues` — Create a directional link between two issues (e.g. "Blocks", "Relates", "Duplicates"). Omit both keys to list available link types. Use automatically when creating batches of tickets that reference dependencies.
- `add_worklog` — Log time on an issue. Time format: "2h 30m", "1d", "45m". Optional comment + start time.

**Versions (release planning):**
- `list_versions` — All versions for a project with release dates and flags.
- `get_version` — Single version details.
- `create_version` — New version. Params: `projectKey`, `name`, optional `description`/`startDate`/`releaseDate`/`released`/`archived`.
- `update_version` — Partial update; pass only the fields to change.
- `delete_version` — Delete; if issues reference it, supply `moveFixIssuesTo` / `moveAffectedIssuesTo` to relocate references.

**Watchers:**
- `list_watchers` — Users watching an issue + whether the authenticated user is watching.
- `add_watcher` — Add a user as watcher (use `search_users` first to get canonical username).
- `remove_watcher` — Remove a user from the watcher list.

**User lookup:**
- `search_users` — Find users by username/display name/email substring.
- `search_assignable_users` — Project-scoped — only users with permission to be assigned to issues in that project.

**Sprint management:**
- `get_sprint` — Sprint details and all issues (needs sprint ID). Supports `startAt` for large sprints.
- `get_board` — List sprints on a board (needs board ID). Filter by state: active, closed, future.
- `list_boards` — List agile boards, optionally filtered by project key. Use this to find board IDs.
- `create_sprint` — Create a new sprint on a board (initial state: future).
- `update_sprint` — Update name/goal/dates OR transition state. Starting a sprint = `state=active` with both `startDate` and `endDate`; closing = `state=closed`.
- `delete_sprint` — Issues return to backlog (confirm with user first).
- `move_issues_to_sprint` — Up to 50 issue keys per call (Agile API limit).

**IMPORTANT:** Jira `assignee` requires the **username**, NOT the display name. Use `search_users` to find canonical usernames before assigning.
**Epic Link config:** Jira Epic Link writes use custom field `customfield_10006` by default. Override with env var `JIRA_EPIC_LINK_FIELD` when your Jira instance uses a different field ID.
**Pagination:** `search_issues` and `get_sprint` no longer silently truncate at 50 — they report the total count and offer `startAt` for continuation. When asked for "all" of something, page through to completion.

### Confluence (18 tools)

**Search & read:**
- `search_confluence` — Search pages by keyword or phrase. Supports `limit` (1-50) and `start` for pagination.
- `search_space` — Same, scoped to a single space key.
- `search_cql` — Raw CQL escape hatch — exposes operators the helpers don't (`lastmodified`, `creator`, `contributor`, `label`, `mention`, `ancestor`, `type=blogpost`). Example: `type = page AND label = "policy" AND lastmodified > now("-30d")`.
- `read_pages` — Read full content of one or more pages by page ID (comma-separated, up to 10 at a time).
- `list_spaces` — List all accessible Confluence spaces.

**Navigation (page hierarchy):**
- `list_page_children` — Immediate child pages of a given page. Paginated.
- `get_page_ancestors` — Breadcrumb path from space root down to a page's parent.

**Write (page lifecycle):**
- `create_page` — Create a new page. Params: `spaceKey`, `title`, `body` (markdown format).
- `update_page` — Update an existing page. Params: `pageId`, `title`, `body` (markdown format).
- `delete_page` — Move a page to space trash (confirm with user first; space admins can restore).
- `move_page` — Re-parent a page. Title/body/labels preserved.

**Attachments:**
- `list_attachments` — Page attachments with filename, size, mime, version, download URL.
- `upload_attachment` — Upload a file from the local filesystem. If the filename matches an existing attachment, Confluence auto-versions it.

**Labels:**
- `get_labels` — Read all labels on a page.
- `add_labels` — Add one or more labels (default `global` prefix).
- `remove_label` — Remove a single label by name.

**Comments:**
- `list_page_comments` — Footer / inline / resolved comments with bodies converted to Markdown.
- `add_page_comment` — Post a footer comment in Markdown.

**IMPORTANT:** After searching Confluence, you MUST call `read_pages` with the top relevant page IDs before summarizing. Never just list search result titles — read the actual pages.
**Pagination:** `search_confluence` / `search_space` previously capped at 10 results silently. They now report the total count and offer `start` for continuation — use it when results clearly extend beyond the page.

### Bitbucket (25 tools)

**Repo & file browsing:**
- `list_repos` — List repos in a project by project key.
- `list_branches` — List branches. **Always call this first** to find the newest release branch.
- `browse_files` — Browse files/directories. Specify branch with `at` parameter.
- `list_all_files` — Flat, recursive list of every file path in a repo (paginated up to 50K, with optional client-side filter).
- `read_file` — Read file content. Specify branch with `at` parameter.
- `clone_repo` — Clone a repo locally for analysis.
- `search_code` — Search code across repos using Elasticsearch syntax. Params: `query`, `projectKey`, `repoSlug`, `limit`. **Limitation:** indexes default branch only — for release branches, clone and grep locally.

**Pull requests — read:**
- `list_pull_requests` — List PRs. Filter by state: OPEN, MERGED, DECLINED, ALL.
- `read_pull_request` — Full PR details — description, reviewers, branches.
- `get_pr_diff` — Unified diff text for a PR (configurable context lines + truncation cap).
- `list_pr_comments` — Walks the activity stream and filters for COMMENTED entries. Preserves inline anchors (file/line) and reply threads.
- `list_pr_commits` — Commits actually in the PR.

**Pull requests — write:**
- `create_pull_request` — Create a PR. Params: `projectKey`, `repoSlug`, `title`, `fromBranch`, `toBranch`, `description`, `reviewers`.
- `add_pr_comment` — General PR comment (omit `path`) or inline (provide `path`, optional `line` + `lineType`).
- `review_pr` — Set status: `APPROVED`, `NEEDS_WORK`, or `UNAPPROVED`.
- `merge_pr` — Pre-checks mergeability so vetoes surface clearly. **Confirm with the user — destructive.**
- `decline_pr` — Close without merging. **Confirm with the user.**

**Commit history & blame:**
- `list_commits` — Log with optional filters: `until`, `since`, `path` (file history), `merges` (include/exclude/only). Range example: `until=release/3.2 since=main` for "what's on release that's not on main yet".
- `get_commit` — Full message, author, parents for a single SHA.
- `blame_file` — Line-by-line authorship at a ref. Each line shows commit/author/date. Pages through long files; supports `startLine`/`endLine` to narrow.

**Tags:**
- `list_tags` — Filterable + orderable (`ALPHABETICAL` or `MODIFICATION` for "most recent release first").
- `get_tag` — Single tag by name with commit info.
- `create_tag` — Lightweight (no message) or annotated (with message). **Confirm with the user — release-visible.**

**Branches & CI:**
- `create_branch` — Create a new branch from a starting point.
- `get_build_status` — CI build statuses attached to a commit (via `/rest/build-status/1.0/`). Useful before `merge_pr` to confirm CI is green.

**Use MCP tools for ALL remote Bitbucket operations:**
- Use `clone_repo` to clone (NOT `git clone` — CLI git does not have credentials)
- Use `create_branch` to create branches (NOT `git push`)
- Use `create_pull_request` to create PRs (NOT `gh` or `git push`)
- Use `review_pr` / `merge_pr` / `decline_pr` to act on PRs (NOT the web UI for routine review)
- Use `create_tag` to tag releases (NOT `git push --tags` — would fail without credentials)
- You CAN use `git` CLI for local operations: `checkout`, `add`, `commit`, `branch`, `diff`

**IMPORTANT — PR target branch:** Most BC Gov repos do NOT have a `main` branch. The default target for PRs should be the **release branch** you branched from (e.g., `release/2.0.3`), NOT `main`. Always set `toBranch` to the release branch.

### Azure DevOps (14 tools)

On-prem Azure DevOps Server — work items (WIQL), repos, and pipelines. Requires `ADO_BASE_URL` + `ADO_PAT` in `~/.raven/.env`.

**Search & read:**
- `list_projects` — List all projects across all collections.
- `search_work_items` — Search work items via WIQL.
- `get_work_item` — Full work-item details by ID.
- `list_repos` / `list_branches` — Repos and branches in a project.
- `browse_files` / `read_file` — Browse and read repo files.
- `list_pull_requests` / `get_pull_request` — PR list and details.
- `list_pipelines` — Build/release pipeline definitions.

**Write:**
- `create_work_item` — Create a work item. **Confirm with the user.**
- `update_work_item` — Update work-item fields.
- `add_work_item_comment` — Comment on a work item.
- `create_pull_request` — Open a PR.

### Health Analytics (5 tools — READ-ONLY)

- `analyze_project_health` — Composite health score (0–100) for a single project.
- `analyze_sprint_velocity` — Sprint velocity trends from closed sprints.
- `analyze_issue_aging` — Open issue aging distribution, stalled work, unassigned issues.
- `analyze_workload` — Work distribution across team members. Flags overloaded individuals.
- `portfolio_health` — Compare health scores across 2–6 projects side by side. Params: `projectKeys` (JSON array, e.g. `["CWM", "DGEN", "WEBADE"]`).

**Choosing the right health tool:**
- Multiple projects → `portfolio_health` (one call, runs in parallel — do NOT manually search issues per project)
- Single project health → `analyze_project_health`
- Sprint trends → `analyze_sprint_velocity`
- Stale issues → `analyze_issue_aging`
- Team workload → `analyze_workload`
- Specific tickets or sprints → use Jira `search_issues`, `get_board`, `get_sprint`

### Bug Classifier (1 tool — READ-ONLY)

- `classify_bugs` — Cluster Jira bug tickets across one or more projects by shared root cause using five heuristic signals (text similarity, error patterns, component/label overlap, affected-area keywords, temporal proximity). Returns a structured summary or full markdown report.

### Cross-System (1 tool)

- `project_overview` — One-shot summary: active sprint, recent issues, Confluence docs, Bitbucket repos and PRs for a project key.

### Jarvis (6 tools)

- `get_application` — Get complete details for a single application by its acronym (e.g. `acronym="ACAT"`). Returns ownership, technology, hosting, status, URLs, and environments.
- `list_ministries` — List all distinct ministries managing applications in the inventory, including their total application counts.
- `update_application` — Create or merge-update an application's fields (such as status, technology tags, contacts) using a payload and source name.
- `search_applications` — Search the application inventory. Filters and parameters include: `query` (text search across acronym, name, aliases), `ministry` (exact match), `status` (active, dormant, retired, unknown, maintenance), `technology` (partial match tag), `isCritical`, and `limit` (max results count).
- `list_technologies` — List all distinct technology tags (databases, frameworks, runtimes, servers, etc.) with usage counts across the full inventory. Accepts optional prefix filter `query`.
- `get_application_provenance` — Retrieve the field-level audit trail / provenance history showing when fields were modified, what data sources modified them, and their previous vs. new values.

### SonarQube (6 tools)
- `sonar_list_issues` — List open issues for a SonarQube project and branch (supports scope/new-code filters).
- `sonar_get_quality_gate` — Get quality gate status for a project/branch, including failing conditions.
- `sonar_get_last_scan` — Get the latest analysis for a project/branch plus its quality gate status.
- `sonar_list_security_hotspots` — List security hotspots for a project/branch (optionally include acknowledged hotspots).
- `sonar_get_project_metrics` — Retrieve headline metrics for the project’s main branch (ratings, coverage, duplications, LOC, etc.).
- `sonar_run_scan` — Run a local sonar-scanner analysis for a given working directory.

---

## Tool Chaining Patterns

### Investigate a Production Error
```
search_server_logs → browse_files → read_file → explain bug
```

### Create a Bug Ticket from Error
```
Investigate (above) → search_issues (check duplicates) → create_issue
```

### Morning Standup
```
search_issues (my open tickets) → list_comments (context) → summarize priorities
```

### Portfolio Health
```
portfolio_health (one call for all projects) → analyze and recommend
```

### Cross-System Status Query
When asked about the status of an initiative, project, or technology:
```
search_issues (Jira tickets) → search_confluence (docs, decisions) → combine findings
```
**IMPORTANT:** For status questions, ALWAYS search both Jira AND Confluence. Jira has the work items; Confluence has the context and decisions.

### Navigate Bitbucket to Find a Java Class
```
list_branches → browse_files (root) → browse_files (deeper) → read_file
```
Java package paths: `<module>/src/main/java/<package-as-dirs>/ClassName.java`

### Project Overview
```
project_overview (one call) → drill into specifics with individual tools
```

### Server Inventory Lookup
```
search_servers (find by name/type/zone) → get_server (full details) → list_server_apps / explore_server (inspect remotely)
```

### CVE Impact Assessment
```
find_apps_by_technology (find affected apps) → get_app_people (find contacts) → search_issues (check existing tickets)
```

### Application Discovery
```
get_application (CMDB details) → list_app_environments (env URLs/servers) → get_app_technologies (tech stack) → get_app_people (team)
```

### End-to-End PR Review
```
list_pull_requests (find open PRs) → read_pull_request (metadata) → get_pr_diff (what changed) → list_pr_commits (history) → list_pr_comments (existing discussion) → add_pr_comment (general or inline) → review_pr (APPROVED / NEEDS_WORK) → get_build_status (CI green?) → merge_pr (confirm with user)
```
For "review this PR" requests, always pull the diff before approving. For "merge this PR", confirm CI is green via `get_build_status` first.

### Blame-Driven Investigation
```
search_server_logs (find error) → blame_file (who last touched the bad line) → get_commit (full message of the flagged SHA) → search_issues (find related ticket) → create_issue (if none exists)
```
Useful when an error stack trace points at a specific file/line and you want to find both the originating commit and any existing tracking ticket.

### Release Planning (Versions + Tags)
```
list_versions (check what exists) → create_version (new release version in Jira) → search_issues (find candidates for fixVersion) → update_issue (set fixVersion on each) → list_tags (find current tag) → create_tag (cut release tag in Bitbucket)
```
Use this when "cutting a release" — Jira version for tracking, Bitbucket tag for the actual ref. `update_version` with `released=true` marks the Jira version released once shipped.

### Sprint Kickoff
```
list_boards (find board ID) → create_sprint (initial state: future) → update_sprint (state='active' with startDate + endDate) → search_issues (find backlog candidates) → move_issues_to_sprint (50 issues max per call)
```
For "start a sprint" requests, confirm the dates and goal with the user before transitioning state to active — it is visible to the team.

### Confluence Space Exploration
```
list_spaces → search_space (or list_page_children from a known root) → get_page_ancestors (orient on a hit) → read_pages (full content of the most relevant pages)
```
When asked "what docs are in space X", prefer `list_page_children` from the space root over CQL search — it gives the structural view rather than just keyword hits.

---

## Rules for chat-time tool use

### Flag MCP Workarounds
> Only applies when the `RAVEN_FLAG_WORKAROUNDS` environment variable is set on the MCP server.

When completing any task that involved an MCP tool call, check whether you needed to work around a tool limitation. A workaround includes:
- A tool returned an error and you had to try something different
- You had to use multiple calls to do what one call should have done (e.g. extract an ID from a URL before calling a tool)
- A tool returned unexpected or incomplete results and you compensated
- You had to convert or transform input/output in a way the tool should handle natively

When this happens, **append a ⚠️ WORKAROUND note at the end of your response** (after the main answer) with:
1. What limitation you hit
2. What workaround you used
3. What fix in the MCP code would eliminate it

This is how we catch fixable friction before it becomes a habit of wasted tokens.

### Always include links
- Jira: `https://apps.example.gov.bc.ca/int/jira/browse/ISSUE-KEY`
- Confluence: include the full page URL from search results
- Bitbucket: include repo name, branch, and file path when referencing code

### Writing Jira Tickets
Only create tickets when the user explicitly asks you to. Do NOT create tickets as a side effect of other tasks.

When you ARE asked to create or update a Jira issue:
- Use **Jira wiki markup** (NOT Markdown): `h3.` for headings, `*bold*`, `{code}...{code}` for code, `[link text|URL]` for links
- For bug tickets, include: Description, Proposed Solution, Acceptance Criteria, Expected Unit Tests
- Add appropriate labels
- Link the tickets mentioned in the description using `link_issues` with the correct relationship type (e.g., "Blocks", "Relates").
- If the ticket is an Epic, set the `issueType` to "Epic" and use `epicKey` to link child issues.
- Ask the user to write up a summary of the reason for creating the ticket themselves, rather than trying to infer it from the conversation. The summary should be a concise statement of the problem or task, ideally starting with the affected system or component (e.g., "RRS API returns 500 on invalid input" or "Add retry logic to DMS file upload"). This ensures the ticket title captures the user's intent accurately.


**When creating a batch of related tickets**, scan every ticket description for dependency language (e.g. "blocked by", "requires", "depends on", "must complete first", "before X can proceed") and add the corresponding issue links using `link_issues` after all tickets are created:
- "A blocks B" → `link_issues(linkType="Blocks", outwardIssueKey=A, inwardIssueKey=B)`
- "A relates to B" → `link_issues(linkType="Relates", outwardIssueKey=A, inwardIssueKey=B)`
- Do this automatically without asking — it is part of completing the ticket creation task
- If the referenced ticket does not exist yet, create it first, then link

### Git Conventions
See the **Conventions** section near the top of this file for branch / commit / PR-title format. In chat: never commit directly to `main`; always check for duplicate Jira tickets before creating new ones; for Bitbucket-hosted repos use `create_branch` / `create_pull_request` rather than `git push` (the CLI lacks credentials in that path).

### Testing
When fixing bugs:
- Write a failing test first that reproduces the bug
- Test the behavior, not the structure
- Include negative cases and edge cases

### Privacy and Security
- This is a BC Government environment subject to FOIPPA
- Personal information may be anonymized as "Person-1", "Person-2" — this is intentional PI scrubbing, do not try to reverse it
- Never log, store, or transmit credentials or personal information
- All server monitoring and IMIS operations are READ-ONLY
- If a tool call fails, say so and suggest an alternative approach
