#!/usr/bin/env bash
#
# Scheduled wrapper for raven-pipeline (launchd/cron).
#
# Targeting comes from environment variables so this script stays generic
# (and free of environment-specific hostnames):
#
#   PIPELINE_SERVER        target server name (required)
#   PIPELINE_APP           application name (required)
#   PIPELINE_COMPONENT     component / log file name (required)
#   PIPELINE_JIRA_PROJECT  Jira project key (optional)
#   PIPELINE_BB_PROJECT    Bitbucket project key (optional)
#   PIPELINE_BRANCH        source branch for --branch (optional)
#   PIPELINE_EXTRA_FLAGS   extra CLI flags, e.g. "--dry-run" (optional)
#   RAVEN_REPO             raven checkout (default: the repo this script is in)
#   RAVEN_LOG_DIR          log directory (default: ~/.raven/logs)
#
# Behaviour:
#   - Pre-flight: if the Atlassian host from ~/.raven/.env is unreachable
#     (machine off VPN), exits 0 with a log line instead of failing noisily.
#   - Runs a single fresh pipeline pass; the pipeline's persistent triage
#     cooldown keeps repeat runs from re-commenting on known errors.
#   - Appends to a dated log file per app.
#   - Takes a per-target lock (mkdir-based) for the run's duration. launchd
#     serializes same-label jobs natively, so this is a no-op there; it's
#     what keeps cron (which does NOT serialize) and manual overlapping
#     invocations from running the same target concurrently.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${RAVEN_REPO:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"
LOG_DIR="${RAVEN_LOG_DIR:-$HOME/.raven/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/pipeline-${PIPELINE_APP:-unknown}-$(date +%Y%m%d).log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

: "${PIPELINE_SERVER:?PIPELINE_SERVER is required}"
: "${PIPELINE_APP:?PIPELINE_APP is required}"
: "${PIPELINE_COMPONENT:?PIPELINE_COMPONENT is required}"

# Per-target lock: cron doesn't serialize overlapping invocations the way
# launchd does, so two runs for the same target could otherwise clone/patch
# the same working tree concurrently. mkdir is atomic, so this doubles as
# the lock acquisition primitive.
LOCK_DIR="$LOG_DIR/.lock-${PIPELINE_SERVER}-${PIPELINE_APP}-${PIPELINE_COMPONENT}"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Stale-lock guard: a crashed run leaves the dir behind. Locks older
  # than 2 hours are reclaimed.
  if [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +120 2>/dev/null)" ]; then
    rmdir "$LOCK_DIR" 2>/dev/null || true
    mkdir "$LOCK_DIR" 2>/dev/null || { log "SKIP: could not acquire lock"; exit 0; }
  else
    log "SKIP: another run for this target is in progress (lock held)"
    exit 0
  fi
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# Pre-flight: reachability of the Atlassian base host (VPN check). Reads only
# the URL variable from ~/.raven/.env — never secrets.
ATLASSIAN_HOST="$(grep -m1 '^ATLASSIAN_BASE_URL=' "$HOME/.raven/.env" 2>/dev/null \
  | cut -d= -f2- | sed -E -e 's|^"||' -e 's|"$||' -e 's|^https?://||' -e 's|/.*||' || true)"
if [ -n "$ATLASSIAN_HOST" ]; then
  if ! nc -z -w 5 "$ATLASSIAN_HOST" 443 2>/dev/null; then
    log "SKIP: Atlassian host unreachable (off VPN?) — not running"
    exit 0
  fi
else
  log "WARN: could not determine Atlassian host from ~/.raven/.env — skipping pre-flight"
fi

CMD=(node "$REPO/packages/pipeline/dist/index.js"
  --server "$PIPELINE_SERVER"
  --app "$PIPELINE_APP"
  --component "$PIPELINE_COMPONENT"
  --fresh --verbose)
[ -n "${PIPELINE_JIRA_PROJECT:-}" ] && CMD+=(--jira-project "$PIPELINE_JIRA_PROJECT")
[ -n "${PIPELINE_BB_PROJECT:-}" ] && CMD+=(--bitbucket-project "$PIPELINE_BB_PROJECT")
[ -n "${PIPELINE_BRANCH:-}" ] && CMD+=(--branch "$PIPELINE_BRANCH")
# shellcheck disable=SC2206 -- EXTRA_FLAGS is intentionally word-split
[ -n "${PIPELINE_EXTRA_FLAGS:-}" ] && CMD+=(${PIPELINE_EXTRA_FLAGS})

log "START: ${PIPELINE_SERVER}/${PIPELINE_APP}/${PIPELINE_COMPONENT} ${PIPELINE_EXTRA_FLAGS:-}"
if "${CMD[@]}" >> "$LOG_FILE" 2>&1; then
  log "DONE: pipeline run completed"
else
  rc=$?
  log "FAIL: pipeline exited with code $rc — see output above"
  exit $rc
fi
