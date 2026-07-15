# RAVEN - Resource Analytics, Visibility & Enterprise Navigator

Local-first AI analysis suite for BC Gov NR Sector. Connects Jira, Confluence, and Bitbucket behind SiteMinder SSO to any LLM — running locally, with personal information scrubbed by default before anything reaches the model.

Built by the Epsilon team at Connected Services BC (NR Sector Digital Services).

> **Docs:** setup & usage (this file) · [tool catalog & env vars](docs/TOOL_INVENTORY.md) · [architecture & security](docs/SYSTEM_DESIGN_AND_ARCHITECTURE.md)

## What It Does

RAVEN gives your local LLM direct access to our Atlassian tools via [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) servers, and includes an **autonomous DevOps pipeline** that detects production errors, triages them with AI, generates code fixes, and creates pull requests.

| Server | What You Can Do |
|--------|-----------------|
| **Jira** | Search by JQL; read/create/update/comment/transition issues (Epic Link aware); log time; manage watchers, versions, and the sprint lifecycle; link issues |
| **Confluence** | Search (CQL + filtered); navigate the space tree; read/create/update/delete/move pages as Markdown; manage attachments, labels, and comments |
| **Bitbucket** | Browse/search code; review PRs end-to-end (diff, comment, approve, merge, decline); commit history and blame; tags; CI build status; create branches and PRs |
| **Azure DevOps** | Work items (WIQL), repos and branches, pull requests, and build pipelines on on-prem Azure DevOps Server |
| **Assets (CMDB)** | Query the Jira Assets CMDB — apps, environments, tech stacks, people, org portfolios; object/schema introspection |
| **Server Monitor** | Discover deployed apps; search Tomcat/Apache logs; compare versions; diff configs; JVM heap (read-only, over SSH) |
| **IMIS** | Search the server inventory and SSH in to browse apps and configs (read-only) |
| **Sonar** | Code issues, quality gates, security hotspots, project metrics, and local `sonar-scanner` runs |
| **Artifactory** | Repositories, artifacts, checksums, properties, AQL searches, build-info, protected transfers, and guarded copy/move/delete operations |
| **Jenkins** | Inspect and configure jobs; run and monitor builds; manage queue items, artifacts, promotions, and credential metadata/lifecycle |
| **RFC Buddy** | Filter and search RFCs from current/completed schedule; updates/advances the API-side baseline |
| **Health** | Sprint velocity, issue aging, composite health scores, workload, portfolio comparison |
| **Overview** | One-shot cross-system project summary (Jira + Confluence + Bitbucket) |
| **Bug Classifier** | Cluster Jira bugs by shared root cause across projects |
| **Jarvis** | Query the central Jarvis application inventory (dynamic proxy to a BC Gov API) |

See **[`docs/TOOL_INVENTORY.md`](docs/TOOL_INVENTORY.md)** for the complete tool catalog, per-server counts, and the read/write split. The Atlassian-backed servers (Jira, Confluence, Bitbucket, Assets, Overview, Health, Bug Classifier) share a single authentication session — log in once, use everywhere. Server Monitor, IMIS, Azure DevOps, Jarvis, Sonar, Jenkins, Artifactory, and RFC Buddy authenticate separately via credentials in `~/.raven/.env`.

### Autonomous Pipeline (`@nrs/pipeline`)

A standalone CLI that detects production errors via SSH, triages them with AI, generates code fixes, and creates pull requests — all autonomously. Uses the GitHub Copilot SDK with `claude-sonnet-4.6`. Supports single run, watch mode, and Jira backlog mode.

See [AUTONOMOUS_DEVOPS_PIPELINE.md](AUTONOMOUS_DEVOPS_PIPELINE.md) for architecture and [DEVOPS_PIPELINE_USAGE.md](DEVOPS_PIPELINE_USAGE.md) for CLI usage.

### Server Monitor Web UI (`@nrs/server-ui`)

A web dashboard for monitoring BC Gov application servers — error counts, log searching, JVM heap, deployed versions, config diffs, deployment history, and alerting. Runs locally at `http://localhost:3777`.

See [SERVER_MONITOR_UI.md](SERVER_MONITOR_UI.md) for setup and usage.

### Search Ranking

Jira search results are scored and ranked by relevance (0-100) using:
- **Recency** (35%) — recently updated issues rank higher
- **Status** (25%) — In Progress/Open above Done/Closed
- **Content richness** (20%) — well-described tickets with labels/components score higher
- **Search rank** (10%) — Jira's own relevance ordering
- **Priority** (10%) — Blocker/Critical above Low

Results are grouped by age tier: Current (<1yr), Recent (1-3yr), Legacy (>3yr).

### Confluence Ranking

Confluence search results are scored and ranked by relevance (0-100) using:
- **Recency** (40%) — recently updated pages rank higher (pages go stale faster than issues)
- **Search rank** (30%) — Confluence's own CQL relevance ordering
- **Content signal** (20%) — excerpt presence and length as a proxy for page richness
- **Title match** (10%) — bonus when query terms appear in the page title

Results are grouped by age tier: Current (<1yr), Recent (1-3yr), Outdated (>3yr). The search tool instructs the LLM to always read the top pages via `read_pages` before summarizing — never just listing search results.

## Prerequisites

- **Node.js** >= 20 (check: `node -v`)
- **Playwright** browsers (installed automatically on first build)
- **An MCP-capable chat client** — see [Choosing a Client](#choosing-a-client)
- **BC Gov IDIR credentials** for SiteMinder authentication

## Quick Start

### 1. Clone and Build

RAVEN is a TypeScript monorepo (npm workspaces):

```bash
git clone https://github.com/bcgov/raven.git ~/Projects/raven
cd ~/Projects/raven
npm install
npm run build
```

### 2. Configure Authentication

Copy the environment template and fill in your credentials:

```bash
mkdir -p ~/.raven && chmod 700 ~/.raven
cp .env.example ~/.raven/.env
chmod 600 ~/.raven/.env
```

Then edit `~/.raven/.env` with your values:

```env
ATLASSIAN_BASE_URL=<base url including https>
ATLASSIAN_EMAIL=<your gov.bc.ca email>
ATLASSIAN_PASSWORD=<your IDIR password>
RAVEN_SCRUB_PI=true
```

Optional Jira setting for Epic Link writes:

```env
# Jira Epic Link custom field ID (default: customfield_10006)
JIRA_EPIC_LINK_FIELD=customfield_10006
```

Optional Azure DevOps settings:

```env
# Azure DevOps Server (on-premises)
ADO_BASE_URL=<https://your-ado-server.example.com>
ADO_DEFAULT_COLLECTION=<default collection, e.g. DefaultCollection>
ADO_PAT=<your Personal Access Token>
ADO_DEFAULT_PROJECT=<default team project name>
# ADO_API_VERSION=7.1
```

Optional Jarvis API settings:

```env
# Jarvis application inventory token and custom url (defaults to Jarvis endpoint)
JARVIS_TOKEN=<your Jarvis Authorization Token>
# JARVIS_BASE_URL=https://jarvis-api.example.gov.bc.ca/mcp
```

Optional SonarQube settings:

```env
# SonarQube Base URL and Authentication credentials
SONARQUBE_URL=<SonarQube base URL, e.g. https://sonarqube.example.gov.bc.ca/sonar>
SONARQUBE_TOKEN=<your SonarQube user token>
SONAR_SCANNER_BIN=<optional path to sonar-scanner binary if not on PATH>
```

Optional Jenkins settings:

```env
JENKINS_URL=<your HTTPS Jenkins base URL>
# Dedicated Basic Auth is preferred for autonomous operation:
# JENKINS_USER=<your Jenkins username>
# JENKINS_TOKEN=<your Jenkins API token>
# Optional protected local directories:
# RAVEN_JENKINS_CONFIG_DIR=~/.raven/jenkins-configs
# RAVEN_JENKINS_DOWNLOAD_DIR=~/.raven/jenkins-downloads
# RAVEN_JENKINS_SECRET_DIR=~/.raven/jenkins-secrets
```

If dedicated Jenkins credentials are not set, the Jenkins MCP falls back to cached SMSESSION authentication. Job configuration updates require an expected SHA-256 and exact XML from the protected config directory. Credential writes accept secret references from environment variables or mode-restricted files; raw secret values are not accepted as tool arguments.

Optional RFC Buddy settings:

```env
# RFC Buddy Base URL and Personal Access Token
RFCBUDDY_URL=<base URL for RFC Buddy API, e.g. https://rfcbuddy.example.com/api/v1>
RFCBUDDY_PAT=<your Personal Access Token (PAT)>
```

Optional Artifactory settings:

```env
# HTTPS is mandatory. These dedicated variables intentionally do not fall back
# to ATLASSIAN_* even if both services currently use the same IDIR account.
ARTIFACTORY_URL=<internal Artifactory HTTPS base URL; ask the RAVEN maintainer>
ARTIFACTORY_EMAIL=<your gov.bc.ca email>
ARTIFACTORY_PASSWORD=<your IDIR password>
# RAVEN_ARTIFACTORY_UPLOAD_DIR=~/.raven/artifactory-uploads
# RAVEN_ARTIFACTORY_DOWNLOAD_DIR=~/.raven/artifactory-downloads
# RAVEN_ARTIFACTORY_MAX_TRANSFER_BYTES=536870912
# RAVEN_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS=1800000
# RAVEN_ARTIFACTORY_DOWNLOAD_REDIRECT_HOSTS=<comma-separated approved storage hostnames>
```

Create transfer directories only when needed and restrict them with `chmod 700`; upload source files must be regular files with mode `600`. Artifactory credentials are attached to requests only inside the local MCP process and sent only to the configured HTTPS endpoint.

When using Jira MCP tools, both `create_issue` and `update_issue` accept an optional `epicKey` parameter to set Epic Link.

> **Where do I get the ATLASSIAN_BASE_URL?** This is an internal BWA (Basic Web Auth) hostname that bypasses SiteMinder. It is not published publicly. Ask the RAVEN maintainer or your team lead for the URL.

Each MCP server loads this file at startup via `dotenv` — credentials never appear in your MCP client config or get exposed to the LLM. See [Authentication](#authentication) for details.

### 3. Connect to Your LLM Client

Copy this MCP configuration into your client (see [Choosing a Client](#choosing-a-client) for where to paste it):

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["/path/to/raven/packages/jira-mcp/dist/index.js"]
    },
    "confluence": {
      "command": "node",
      "args": ["/path/to/raven/packages/confluence-mcp/dist/index.js"]
    },
    "bitbucket": {
      "command": "node",
      "args": ["/path/to/raven/packages/bitbucket-mcp/dist/index.js"]
    },
    "overview": {
      "command": "node",
      "args": ["/path/to/raven/packages/overview-mcp/dist/index.js"]
    },
    "health": {
      "command": "node",
      "args": ["/path/to/raven/packages/health-mcp/dist/index.js"]
    },
    "server-monitor": {
      "command": "node",
      "args": ["/path/to/raven/packages/server-mcp/dist/index.js"]
    },
    "imis": {
      "command": "node",
      "args": ["/path/to/raven/packages/imis-mcp/dist/index.js"]
    },
    "assets": {
      "command": "node",
      "args": ["/path/to/raven/packages/assets-mcp/dist/index.js"]
    },
    "bug-classifier": {
      "command": "node",
      "args": ["/path/to/raven/packages/bug-classifier-mcp/dist/index.js"]
    },
    "ado": {
      "command": "node",
      "args": ["/path/to/raven/packages/ado-mcp/dist/index.js"]
    },
    "jarvis": {
      "command": "node",
      "args": ["/path/to/raven/packages/jarvis-mcp/dist/index.js"]
    },
    "sonar": {
      "command": "node",
      "args": ["/path/to/raven/packages/sonar-mcp/dist/index.js"]
    },
    "jenkins": {
      "command": "node",
      "args": ["/path/to/raven/packages/jenkins-mcp/dist/index.js"]
    },
    "rfcbuddy": {
      "command": "node",
      "args": ["/path/to/raven/packages/rfcbuddy-mcp/dist/index.js"]
    },
    "artifactory": {
      "command": "node",
      "args": ["/path/to/raven/packages/artifactory-mcp/dist/index.js"]
    }
  }
}
```

**Important:** Replace `/path/to/raven` with your actual clone path (e.g., `~/Projects/raven`). Credentials and settings (including PI scrubbing) are loaded from `~/.raven/.env` — they do not belong in this config file.

### 4. Configure Server Monitoring (Optional)

The Server Monitor MCP requires two things: a `servers.conf` file listing the servers it can connect to, and SSH credentials in `~/.raven/.env`.

#### 4a. Create `~/bin/servers.conf`

This file is the single source of truth for server names and connection details. The Server Monitor MCP will **fail to start** if this file is missing or empty.

```bash
cp servers.conf.example ~/bin/servers.conf
```

Then edit `~/bin/servers.conf` and replace the example hostnames and `_A` account with your own values. The format is pipe-delimited:

```
name|hostname|ssh_user|sudo_user|role|description
```

See [`servers.conf.example`](servers.conf.example) in the repo root for the full format reference including optional `apps_base` and `logs_base` fields.

> **Custom location:** If you prefer to keep `servers.conf` somewhere other than `~/bin/`, set `SERVER_TOOLS_BIN=/path/to/dir` in `~/.raven/.env`.

#### 4b. Add SSH credentials to `~/.raven/.env`

```env
SERVER_A_PASSWORD=<your _A account password>
```

**Note:** Quote the password if it contains `#` or other special characters. Server Monitor requires VPN connectivity to the BC Gov network.

The `ssh_user` (your `_A` account) is read directly from `servers.conf` — you do not need to set it separately in `.env`.

#### 4c. Optional: SSH key authentication (per-host opt-in)

By default, Server Monitor and IMIS use password authentication via `SERVER_A_PASSWORD`. If you've deployed a public key to one or more target servers, you can opt in to key-based SSH by setting **both**:

```env
SSH_KEY_PATH=/Users/<you>/.ssh/id_ed25519
SSH_KEY_HOSTS=int01,test01,prod01
```

How it works:

- For hosts listed in `SSH_KEY_HOSTS`, Raven uses key auth only — no password is offered to ssh2, so a rejected key (e.g., key removed from the server) fails loudly without a fallback password attempt.
- For hosts **not** listed, Raven uses password auth only — no key is offered, so no failed-publickey log entry is generated.
- This produces zero failed-login attempts in steady state, on any host. (See "Why per-host" below.)

Requirements:

- `SERVER_A_PASSWORD` is needed for password auth (any host not in `SSH_KEY_HOSTS`) and for sudo on the remote server. Most server-monitor workflows use sudo for service-account access, so plan to keep it set unless you key-auth every host AND never sudo.
- The key file must exist at the path specified. If `SSH_KEY_PATH` is set but the file is missing, Raven returns an explicit error rather than attempting any connection.
- Setting `SSH_KEY_PATH` without `SSH_KEY_HOSTS` is rejected with an error — it would be ambiguous whether the key should be used on any given host.
- If your private key is passphrase-protected, also set `SSH_KEY_PASSPHRASE`:
  ```env
  SSH_KEY_PASSPHRASE=<passphrase for the private key>
  ```

`SSH_KEY_HOSTS` matching:

- Comma-separated short names (e.g., `int01`, not `int01.example.internal`). Raven normalizes incoming hostnames by lowercasing and stripping the domain before matching, so an FQDN like `int01.example.internal` matches a list entry of `int01`.
- Whitespace around entries is trimmed. `int01, test01` works.
- Use `SSH_KEY_HOSTS=*` to use the key on every host (strict — will hard-fail on any host that lacks the key in `authorized_keys`).

Why per-host (and not "try key, fall back to password"): a try-then-fallback approach generates one failed-publickey log entry on every server where your key isn't authorized. Multiplied across many calls per day, this looks like a brute-force attack to bastion alerting (fail2ban, MaxAuthTries). The per-host design eliminates this entirely — the cost is maintaining the list when you deploy keys to new servers.

Behavior when `SSH_KEY_PATH` is **not** set is identical to before this option existed — pure password auth, no key offered. There is no auto-detection of `~/.ssh/id_*` files.

### 5. Configure IMIS Server Inventory (Optional)

The IMIS MCP server reads from a local CSV export of the IMIS server database. This file contains sensitive infrastructure data and is **not included in the repo** — you must export it yourself.

1. Export the server list from the IMIS client as CSV
2. Place it at `~/.raven/imis-servers.csv`

```bash
# Or set a custom path via environment variable in ~/.raven/.env:
IMIS_CSV_PATH=/path/to/your/imis-export.csv
```

The three discovery tools (`search_servers`, `get_server`, `server_stats`) read from this CSV locally — no network required. The three SSH tools (`list_server_apps`, `explore_server`, `read_server_file`) connect to servers directly and require VPN access plus `SERVER_A_PASSWORD` in `~/.raven/.env`.

### 6. Verify It Works

Test a single server to confirm authentication is working:

```bash
# Quick smoke test — should print server info without errors
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node packages/jira-mcp/dist/index.js
```

If you see a JSON response listing available tools, you're good. If you get a 401 error, double-check `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, and `ATLASSIAN_PASSWORD` in `~/.raven/.env`.

Then try a real query in your LLM client:
> Search Jira for the 5 most recently updated tickets in project DEMO

If results come back, RAVEN is working.

### 7. Ask Questions

```
Search Jira for all open PROJ1 tickets
Find Confluence pages about DMS architecture
List repos in the CWM Bitbucket project
Give me a project overview for DEMO
Analyze sprint velocity for PROJ1
What's the project health score for DEMO?
Compare portfolio health for DEMO, PROJ2, and PROJ1
Check the heap for RRS rrs-api on int01
What apps are deployed on prod01?
Search for ORA errors in RRS rrs-api on prod
Compare context.xml for RRS rrs-api across all environments
Search IMIS for all Windows servers in the PROD zone
What technology stack does RRS use?
Find all apps using Oracle 19c
Who are the people associated with the CWM application?
```

## Choosing a Client

RAVEN works with any MCP-capable client. Here's what we've tested:

| Client | MCP Tools Limit | Local Models | Setup |
|--------|----------------|--------------|-------|
| **VS Code + GitHub Copilot** | Unlimited | No (uses Copilot models) | Auto-detected via `.mcp.json` in repo root |
| **LM Studio** | Unlimited | Yes (built-in model runner) | Right sidebar > Program > Edit mcp.json |
| **Dive** | Unlimited | Yes (connects to Ollama) | Settings > MCP Config |
| **MstyStudio** | 1 tool (free) / Unlimited (paid) | Yes (connects to Ollama) | Toolbox > Add New Tool > Import from JSON |

### VS Code with GitHub Copilot (Recommended)

RAVEN includes a `.mcp.json` file in the repo root that VS Code detects automatically. You need a GitHub Copilot license — see the [GitHub Copilot setup guide](https://docs.github.com/en/copilot/setting-up-github-copilot/setting-up-github-copilot-for-your-organization) if your org hasn't enabled it yet.

1. Open the RAVEN project folder in VS Code
2. Install the [GitHub Copilot](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot) and [GitHub Copilot Chat](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot-chat) extensions if not already installed
3. Open Copilot Chat (**⌃⌘I** on macOS, **Ctrl+Shift+I** on Windows/Linux) and switch to **Agent** mode
4. You should see the RAVEN MCP servers listed as available tools
5. If prompted to "Start" or approve the MCP servers, click to allow them

**Verify MCP servers are connected:**
- Open the Command Palette (**⌘⇧P** / **Ctrl+Shift+P**) and run **MCP: List Servers**
- All 12 servers should show as registered — click any to start/restart it
- In the Copilot Chat input bar, click the **tools icon** (🔧) to see which tools are available

No manual MCP configuration needed — the `.mcp.json` in the project root handles everything. If you need to customize server paths, edit `.mcp.json` directly.

#### Using RAVEN from any project (global VS Code config)

The `.mcp.json` approach only activates when the RAVEN folder is open. To make all RAVEN tools available in **every** VS Code workspace, add them to your VS Code user-level MCP config instead.

Create or edit the file at:
- **macOS:** `~/Library/Application Support/Code/User/mcp.json`
- **Windows:** `%APPDATA%\Code\User\mcp.json`
- **Linux:** `~/.config/Code/User/mcp.json`

```json
{
  "servers": {
    "jira": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/jira-mcp/dist/index.js"]
    },
    "confluence": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/confluence-mcp/dist/index.js"]
    },
    "bitbucket": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/bitbucket-mcp/dist/index.js"]
    },
    "overview": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/overview-mcp/dist/index.js"]
    },
    "health": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/health-mcp/dist/index.js"]
    },
    "server-monitor": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/server-mcp/dist/index.js"]
    },
    "imis": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/imis-mcp/dist/index.js"]
    },
    "assets": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/assets-mcp/dist/index.js"]
    },
    "bug-classifier": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/bug-classifier-mcp/dist/index.js"]
    },
    "ado": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/ado-mcp/dist/index.js"]
    },
    "jarvis": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/jarvis-mcp/dist/index.js"]
    },
    "sonar": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/sonar-mcp/dist/index.js"]
    },
    "jenkins": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/jenkins-mcp/dist/index.js"]
    },
    "rfcbuddy": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/rfcbuddy-mcp/dist/index.js"]
    },
    "artifactory": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/raven/packages/artifactory-mcp/dist/index.js"]
    }
  }
}
```

Replace `/path/to/raven` with your actual clone path (e.g. `/Users/jsmith/Projects/raven`). Use absolute paths — the user-level config does not support `~` expansion.

> **Note:** The user-level format uses `"servers"` and requires `"type": "stdio"` on each entry. This differs slightly from the workspace `.mcp.json` format. If both are present, VS Code merges them — workspace entries take precedence over user entries with the same name.

### LM Studio

1. Download a model with tool-calling support (see [Recommended Models](#recommended-models))
2. Right sidebar > **Program** tab > **Edit mcp.json**
3. Paste the MCP config above
4. Start a chat and ask a question

### MstyStudio

1. Toolbox > Add New Tool > **Import Tool from JSON Clipboard**
2. Paste each server config individually (inner JSON object only)
3. Create a **Toolset** with your RAVEN tools enabled
4. Create a **Persona** with the Toolset assigned in Add-ons
5. Select a tool-calling capable model
6. Start a new chat, select your Persona with the **@** icon

## Recommended Models

Not all local models support tool calling. These work well with RAVEN:

| Model | Size | Speed | Tool Calling | Best For |
|-------|------|-------|-------------|----------|
| **Qwen3 Coder 30B** (Q4_K_M) | ~18GB | Moderate | Excellent | Deep analysis, code review, synthesis |
| **Qwen 2.5 14B** (Q4_K_M) | ~8GB | Moderate | Excellent | Deep analysis, synthesis |
| Qwen 2.5 7B | ~4GB | Fast | Good | Routine searches, quick lookups |
| Llama 3.1 8B | ~5GB | Fast | Good | General tasks |
| Mistral Nemo 12B | ~7GB | Moderate | Good | Balanced speed/quality |

### Ollama Performance Tuning

If using Ollama as your model runner, add these to `~/.zprofile` for a speed boost:

```bash
# Flash Attention — faster inference, zero quality loss
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
launchctl setenv OLLAMA_FLASH_ATTENTION 1
launchctl setenv OLLAMA_KV_CACHE_TYPE q8_0
```

Restart Ollama after setting these.

## Authentication

RAVEN supports two auth methods. Basic Auth is recommended.

### Basic Auth (Recommended)

Uses HTTP Basic Auth via an internal URL that bypasses SiteMinder. No browser, no session expiry, no Playwright dependency.

Create `~/.raven/.env` with these three variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `ATLASSIAN_BASE_URL` | BWA hostname (ask the RAVEN maintainer or your team lead) | `https://...` |
| `ATLASSIAN_EMAIL` | IDIR email address | `Your.Name@gov.bc.ca` |
| `ATLASSIAN_PASSWORD` | IDIR password | (keep secret) |
| `RAVEN_SCRUB_PI` | Anonymize names before they reach the LLM | `true` |

Each MCP server loads this file at startup via `dotenv`. Credentials are injected into the server process only — they are never exposed to the LLM client.

**Security:** Never commit credentials to git. The `~/.raven/` directory should be `chmod 700` and the `.env` file `chmod 600`. The password stays on your local machine — RAVEN never logs or transmits it.

### SMSESSION Cookie (Fallback)

If Basic Auth env vars are not set, RAVEN falls back to SiteMinder cookie authentication:

1. Checks for a cached session (`~/.workflow-suite/session.json`)
2. If expired or missing, checks the `SMSESSION` environment variable
3. If neither exists, opens a Chromium browser for interactive IDIR login
4. Cookie is cached for 25 minutes, shared across Jira/Confluence/Bitbucket

```bash
# Authenticate via browser
node packages/auth/dist/cli.js
```

## Jira Search Examples (JQL)

The `search_issues` tool accepts [JQL (Jira Query Language)](https://support.atlassian.com/jira-software-cloud/docs/use-advanced-search-with-jql/):

```
-- All tickets in a project (newest first)
project = PROJ1 ORDER BY updated DESC

-- Text search across summary and description
text ~ "NROS Portal Retirement"

-- Open tickets only
project = DEMO AND status != Done ORDER BY updated DESC

-- By assignee
assignee = currentUser() AND status = "In Progress"

-- Cross-project search for an app
text ~ "RRS" AND project IN (PROJ1, PROJ2, DEMO) ORDER BY created DESC

-- Recent tickets in a date range
project = PROJ1 AND created >= 2025-01-01 ORDER BY created DESC

-- By label
labels = "NROS_Portal_Retirement"
```

## Common Queries by Role

Copy-paste these prompts into your LLM chat. They work with RAVEN's data tools and health analysis tools.

### Product Owner

**Sprint health check:**
> Analyze the sprint velocity for PROJ1 over the last 5 sprints. Is our completion rate improving or declining?

**Feature progress:**
> Search Jira for all DEMO tickets with label "Q4-Release" — how many are done vs still open?

**Backlog hygiene:**
> Analyze issue aging for DEMO. Are there tickets sitting in the backlog for over 90 days that we should groom or close?

**Current sprint status:**
> Give me a project overview for DEMO, then tell me which sprint items are at risk of not completing.

**Unassigned work:**
> Analyze workload for DEMO. How many tickets are unassigned and what priority are they?

### Project Manager

**Risk identification:**
> Analyze project health for DEMO. What are the top risk flags I should raise in the next status meeting?

**Resource conflicts:**
> Analyze workload across DEMO and PROJ2. Is anyone overloaded across both projects?

**Milestone tracking:**
> Search Jira for DEMO tickets in fixVersion "2.0-Release" — what percentage are done?

**Stalled work:**
> Analyze issue aging for DEMO. Which in-progress tickets have not been updated in more than 14 days?

**Cross-project visibility:**
> Get portfolio health for DEMO, PROJ2, and PROJ1. Which project needs the most attention this week?

### Executive / Director

**Portfolio health:**
> Run portfolio health analysis for DEMO, DMS, PROJ1, and RRS. Give me a one-page summary of where things stand.

**Stale project detection:**
> Analyze project health for DMS. Has there been any code or documentation activity in the last 30 days?

**Documentation gaps:**
> Search Confluence for pages about DEMO — are the architecture and onboarding docs up to date or stale?

**Team capacity:**
> Analyze workload for DEMO, PROJ2, and PROJ1 together. Are any individuals spread across too many projects?

**Delivery trend:**
> Analyze sprint velocity for DEMO over the last 10 sprints. Is the team delivering more or less over time?

### Developer / DevOps

**Morning check-in:**
> Run the server dashboard for RRS. Are there any errors today?

**Memory pressure:**
> Check the JVM heap for RRS rrs-api on prod01. Is Old Gen above 80%?

**Version alignment:**
> Show me deployed versions for RRS across all environments. Are dev and prod in sync?

**Config drift:**
> Compare context.xml for RRS rrs-api across all environments. Are there differences between dev and prod?

**Log investigation:**
> Search for ORA- errors in RRS rrs-api on prod01 with 3 lines of context

**Discovery:**
> What apps are deployed on int01? List all components and versions.

## Project Structure

RAVEN is a TypeScript monorepo (npm workspaces):

```
raven/                           ← RAVEN root (run npm commands here)
  packages/
    auth/              Shared auth (Basic Auth + SiteMinder cookie cache)
    jira-mcp/          Jira Data Center MCP server (search, issues, sprints, versions, watchers, worklogs, attachments, users)
    confluence-mcp/    Confluence Data Center MCP server (search/CQL, pages, hierarchy, attachments, labels, comments)
    bitbucket-mcp/     Bitbucket Data Center MCP server (code search, PR review, commits, blame, tags, build status)
    overview-mcp/      Cross-system project overview MCP server
    health-mcp/        Project health analysis MCP server
    server-mcp/        Server monitoring MCP server (SSH)
    imis-mcp/          IMIS server inventory MCP server (CSV + SSH)
    assets-mcp/        Jira Assets CMDB MCP server (search, objects, history, schemas)
    bug-classifier-mcp/ Bug pattern classifier MCP server
    ado-mcp/           Azure DevOps Server MCP (work items, repos, PRs, pipelines)
    jarvis-mcp/        Jarvis proxy MCP server (dynamic remote proxy to the Jarvis application inventory)
    sonar-mcp/         SonarQube MCP server (issues, quality gate, hotspots, metrics, local scan)
    jenkins-mcp/       Jenkins MCP server (jobs, builds, queue, artifacts, promotions, credentials)
    rfcbuddy-mcp/      RFC Buddy MCP server (RFC schedules search and baseline tracking)
    artifactory-mcp/   JFrog Artifactory MCP server (artifacts, build-info, guarded transfers)
    pipeline/          Autonomous DevOps pipeline CLI (GitHub Copilot SDK + MCP tools)
    raven-cli/         CLI interface (coming soon)
    server-ui/         Web UI for server monitoring (see SERVER_MONITOR_UI.md)
  .mcp.json            Claude Code auto-config (relative paths)
  tsconfig.json        TypeScript project references
    SERVER_MONITOR_UI.md            Server Monitor Web UI setup & usage
    AUTONOMOUS_DEVOPS_PIPELINE.md   Pipeline architecture & design
    DEVOPS_PIPELINE_USAGE.md        Pipeline CLI reference & examples
```

## Development

All commands run from the repository root:

```bash
cd ~/Projects/raven   # or wherever you cloned raven

# Build all packages
npm run build

# Run tests
npm test

# Watch mode
npm run test:watch

# Clean build artifacts
npm run clean
```

## Privacy & Compliance

- **All data stays local.** No Atlassian data is sent to external LLM providers.
- **FOIPPA compliant.** Personal information from Jira/Confluence is processed locally only.
- **PI scrubbing.** Set `RAVEN_SCRUB_PI=true` in `~/.raven/.env` to automatically anonymize personal information (names, usernames) before it reaches the LLM. One setting controls all servers.
- **Your IDIR credentials.** RAVEN authenticates as you — it sees exactly what you can see, nothing more.
- **No secrets in code.** Credentials are loaded from `~/.raven/.env` at server startup — never passed through MCP client configs, never exposed to the LLM, never logged or stored in the repo.

## Troubleshooting

### Authentication errors (401 or "No valid SMSESSION found")
Check `~/.raven/.env` has the correct `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, and `ATLASSIAN_PASSWORD` values. Ensure the URL includes `https://`. Or run `node packages/auth/dist/cli.js` for SMSESSION fallback (expires after 25 minutes).

### Model describes tools instead of calling them
Your LLM doesn't support tool calling. Switch to **Qwen 2.5 14B** or **Llama 3.1 8B**. See [Recommended Models](#recommended-models).

### Server Monitor MCP fails to start ("No servers configured")
The `server-mcp` reads `~/bin/servers.conf` at startup and refuses to start if it finds no entries. Create the file using the format described in [Configure Server Monitoring](#4-configure-server-monitoring-optional). If your file lives elsewhere, set `SERVER_TOOLS_BIN=/path/to/dir` in `~/.raven/.env`.

### MCP server not loading in client
1. Verify the server works: `echo '{}' | node packages/jira-mcp/dist/index.js` (should not crash, run from `raven/` dir)
2. Check the path in your MCP config is absolute and includes the `raven/` subdirectory
3. Rebuild if needed: `cd raven && npm run build`

### Slow model performance
See [Ollama Performance Tuning](#ollama-performance-tuning). Consider using a 7B model for routine tasks.

## License

    Copyright 2026 Province of British Columbia

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

## Copilot Instructions and AI Agent Behavior

This repository includes a `.github/copilot-instructions.md` file that defines how GitHub Copilot Chat and other Copilot-powered agents interact with the RAVEN MCP servers. These instructions:

- Document all available tools and workflows (Jira, Confluence, Bitbucket, Server Monitor, IMIS, Assets, Health Analytics, etc.)
- Enforce security, privacy, and operational guardrails (e.g., FOIPPA compliance, PI scrubbing, no destructive actions)
- Describe tool chaining patterns for common tasks (error investigation, ticket creation, portfolio health, etc.)
- Specify conventions for ticket writing, PRs, and code changes

If you use Copilot Chat or any MCP-capable AI client, these instructions ensure safe, predictable, and compliant automation. You can review or customize them in `.github/copilot-instructions.md`.

### Making the instructions available globally

By default, `.github/copilot-instructions.md` only applies when the RAVEN folder is your VS Code workspace root. To load the RAVEN instructions in **every** workspace (e.g. when working on `nr-rrs` or any other project), add this to your VS Code user `settings.json` (**⌘⇧P** → "Open User Settings JSON"):

```json
"github.copilot.chat.codeGeneration.instructions": [
  {
    "file": "/path/to/raven/.github/copilot-instructions.md"
  }
]
```

Replace `/path/to/raven` with your actual clone path. This tells Copilot to always include the RAVEN tool instructions regardless of which project you have open — useful since you'll often want to query Jira or search logs while working in a completely different repo.

> **Note:** This repository is for internal BC Gov NR Sector use only. It is not intended for public distribution or external adoption.
