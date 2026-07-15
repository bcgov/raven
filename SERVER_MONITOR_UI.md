# Server Monitor Web UI

A web dashboard for monitoring BC Gov application servers — error counts, log searching, JVM heap, deployed versions, config diffs, deployment history, and alerting. All read-only operations via SSH.

## What It Does

The Server Monitor UI is an Express web application that shells out to SSH-based CLI scripts to query BC Gov application servers. It provides:

- **Dashboard** — Morning overview: error counts and deployed versions across all servers
- **Log Search** — Grep application logs by pattern, date, log type (app, catalina, access)
- **Log Tail** — Real-time log streaming via Server-Sent Events (SSE)
- **JVM Heap** — Live heap monitoring with one-shot snapshots or continuous streaming
- **Versions** — Compare deployed versions across DEV/TEST/PROD environments
- **Config Diff** — Compare `context.xml`, `web.xml`, `server.xml` between environments
- **Deploys** — Deployment timeline with version history from server filesystem
- **Server Load** — System metrics: uptime, load averages, memory, disk usage (live streaming)
- **Connection Pool** — JDBC pool settings from `context.xml` + pool-related log events
- **Trends** — Historical error charts (90 days) and version change history (180 days) via Chart.js
- **Alerts** — Threshold-based alerting (heap %, error counts) with email, webhook, and browser notifications
- **Settings** — View and edit server configuration (`servers.conf`)

## Prerequisites

1. **Node.js** >= 20
2. **RAVEN monorepo built** — `npm run build` from the project root
3. **VPN connection** — Required to SSH into BC Gov servers
4. **Server credentials** — `SERVER_A_PASSWORD` in `~/.raven/.env`
5. **CLI tools** — SSH-based scripts installed in `~/bin/` (see [CLI Tools](#cli-tools) below)
6. **Server config** — `~/bin/servers.conf` defining your server inventory

## Quick Start

```bash
# From the raven project root
npm run build

# Start the server (builds, starts, opens browser)
cd packages/server-ui
./start.sh

# Or start manually
node dist/index.js
```

The dashboard opens at **http://localhost:3777**.

### start.sh Commands

```bash
./start.sh            # Build + start in background + open browser
./start.sh --no-build # Skip build, just start
./start.sh stop       # Stop the running server
./start.sh status     # Check if server is running
```

The script starts the server detached via `nohup`, logging to `~/.raven/logs/server-ui.log`. It manages a PID file at `.server.pid` for clean stop/status.

## Environment Variables

Set these in `~/.raven/.env`:

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SERVER_A_PASSWORD` | **Yes** | — | SSH and sudo password for `_A` account |
| `SERVER_UI_PORT` | No | `3777` | HTTP listen port |
| `SERVER_TOOLS_BIN` | No | `~/bin` | Directory containing CLI tools |
| `SMTP_HOST` | No | — | SMTP relay for email alerts (disabled if unset) |
| `SMTP_PORT` | No | `25` | SMTP port |
| `SMTP_FROM` | No | `raven-alerts@example.gov.bc.ca` | From address for alert emails |

## CLI Tools

The UI delegates all server operations to shell scripts in `~/bin/` (override with `SERVER_TOOLS_BIN`). These scripts use `expect` to handle SSH authentication.

Required scripts:

| Script | Used By |
|--------|---------|
| `server-dashboard` | Dashboard view |
| `server-discover` | Discover view, app dropdowns |
| `server-versions` | Versions view |
| `server-heap` | JVM Heap view |
| `server-load` | Server Load view |
| `server-log-search` | Log Search view |
| `server-tail-batch` | Log Tail view |
| `server-read-config` | Connection Pool view |
| `server-config-diff` | Config Diff (not exposed as a view, used internally) |
| `server-deploy-history` | Deploys view |
| `server-download` | Log Download |

These scripts are **not part of the RAVEN repo** — they are separately distributed expect-based SSH scripts. Ask the RAVEN maintainer for access.

## Server Configuration

Server definitions live in `~/bin/servers.conf` — a pipe-delimited file with one server per line:

```
name|hostname|ssh_user|sudo_user|role|description|apps_base|logs_base
```

Fields:
- **name** — Short name (e.g., `int01`, `test01`, `prod01`)
- **hostname** — FQDN for SSH
- **ssh_user** — `_A` account username
- **sudo_user** — Account for sudo operations
- **role** — `DEV`, `TEST`, or `PROD`
- **description** — Human-readable label
- **apps_base** — Base path for deployed applications (e.g., `/apps_ux`)
- **logs_base** — Base path for log files

You can also edit server config via the **Settings** view in the UI.

### Server Names

| Name | Environment |
|------|-------------|
| `int01` | INT (Integration) |
| `int02` | INT (Integration) |
| `test01` | TEST |
| `test02` | TEST |
| `prod01` | PROD |
| `prod02` | PROD |

## Features

### Dashboard

Morning status overview with error counts and deployed versions for all configured servers. Optionally filtered by application.

### Log Search

Search application logs with:
- **Log types**: `app` (default), `catalina` (Tomcat), `access` (HTTP)
- **Date or date range** queries
- **Context lines** to see surrounding stack trace
- **Max line** limits (up to 500)

### Log Tail (Live)

Real-time log streaming via SSE. Shows the last N lines, then streams new lines as they appear. Deduplicates already-seen lines.

### JVM Heap

One-shot snapshot or live SSE stream (minimum 3-second interval). Shows PID, heap used/max, heap %, eden space, GC counts and pause times.

### Versions

Compare deployed versions across environments. Detects mismatches between DEV/TEST/PROD.

### Deploys

Deployment timeline showing version, previous version, deploy date, and which version is currently active. Reads timestamps from the server filesystem via `stat`.

### Server Load

System metrics: uptime, load averages, memory, disk usage. Supports live SSE streaming for one or all servers simultaneously.

### Connection Pool

Extracts JDBC pool settings from `context.xml` (with **passwords always masked**) and greps recent logs for pool-related events (exhaustion, abandoned connections, DBCP/HikariPool errors).

### Trends

Historical charts powered by Chart.js:
- **Error trends** — up to 90 days of error count data
- **Version history** — up to 180 days of version changes

Data comes from the background collector (see below).

### Alerts

Threshold-based alerting system:
- **Alert types**: heap % exceeds threshold, error count exceeds threshold in a time window (1h, 6h, 24h)
- **Notifications**: real-time SSE push to browser, webhook (HTTP POST), email (SMTP via nodemailer)
- **Cooldown**: 30 minutes between re-fires of the same rule
- **History**: last 500 alert events, viewable in the UI

### Health Endpoint

`GET /api/health` — Reports status (`healthy`, `degraded`, `starting`), server reachability, collector status, uptime, and version. OpenShift-ready.

## Background Data Collector

Runs every 30 minutes (and once on startup):

1. Calls `server-dashboard` to collect error counts and versions for all servers
2. Records snapshots to `~/.raven/server-ui-data.json` (atomic writes)
3. Evaluates alert rules and fires alerts when thresholds are breached

**Retention**: error snapshots 90 days, version snapshots 180 days, alert history 500 entries max.

## Security

- Binds to **127.0.0.1 only** — not accessible from the network
- Input validation on all routes: server names checked against config, app/component names restricted to `[A-Za-z0-9_-]`, patterns reject shell metacharacters
- Passwords never logged or stored in the data file
- Database passwords masked in pool config responses
- Atomic file writes to prevent data corruption

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `SERVER_A_PASSWORD must be set` | Add `SERVER_A_PASSWORD` to `~/.raven/.env` |
| `Connection refused` on port 3777 | Check `./start.sh status`. Rebuild with `npm run build` if needed |
| CLI tool not found | Ensure scripts are in `~/bin/` (or set `SERVER_TOOLS_BIN`). Check they're executable: `chmod +x ~/bin/server-*` |
| SSH timeout | Verify VPN is connected and the server is reachable |
| No data in Trends | The background collector runs every 30 min. Wait for at least one cycle, or check `~/.raven/server-ui-data.json` |
| Email alerts not sending | Set `SMTP_HOST` in `~/.raven/.env`. Test via the Alerts view's "Send Test Email" button |
| Stale PID file | `./start.sh stop` then `./start.sh` — or delete `.server.pid` manually |
