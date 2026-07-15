#!/usr/bin/env bash
#
# start.sh — Build, start the Server Monitor UI, and open it in a browser.
#
# Usage: ./start.sh            (build + start + open browser)
#        ./start.sh --no-build (skip build, just start)
#        ./start.sh stop       (stop the running server)
#        ./start.sh status     (check if server is running)
#
set -euo pipefail

PORT="${SERVER_UI_PORT:-3777}"
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="${DIR}/.server.pid"
LOG_FILE="${HOME}/.raven/logs/server-ui.log"
cd "$DIR"

# --- stop command ---
if [[ "${1:-}" == "stop" ]]; then
    if [[ -f "$PID_FILE" ]]; then
        pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid"
            rm -f "$PID_FILE"
            echo "Server stopped (pid ${pid})."
        else
            rm -f "$PID_FILE"
            echo "Server was not running (stale pid file removed)."
        fi
    else
        echo "No server running (no pid file)."
    fi
    exit 0
fi

# --- status command ---
if [[ "${1:-}" == "status" ]]; then
    if [[ -f "$PID_FILE" ]] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
        echo "Server is running (pid $(cat "$PID_FILE")) → http://localhost:${PORT}"
    else
        echo "Server is not running."
    fi
    exit 0
fi

# --- Kill any existing instance ---
if [[ -f "$PID_FILE" ]]; then
    old_pid=$(cat "$PID_FILE")
    if kill -0 "$old_pid" 2>/dev/null; then
        echo "Stopping existing server (pid ${old_pid})..."
        kill "$old_pid" 2>/dev/null || true
        sleep 1
    fi
    rm -f "$PID_FILE"
fi

# --- Build unless --no-build ---
if [[ "${1:-}" != "--no-build" ]]; then
    echo "Building..."
    npm run build
fi

# --- Start server in background (detached, survives terminal close) ---
echo "Starting Server Monitor UI on port ${PORT}..."
nohup node dist/index.js >> "$LOG_FILE" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for it to be ready
for i in $(seq 1 10); do
    if curl -s -o /dev/null http://localhost:${PORT}/ 2>/dev/null; then
        break
    fi
    sleep 0.5
done

# Open in default browser
URL="http://localhost:${PORT}"
echo ""
echo "  Server Monitor UI → ${URL}"
echo "  Running in background (pid ${SERVER_PID})"
echo ""
echo "  To stop:   ./start.sh stop"
echo "  To check:  ./start.sh status"
echo ""

if command -v open &>/dev/null; then
    open "$URL"
elif command -v xdg-open &>/dev/null; then
    xdg-open "$URL"
fi
