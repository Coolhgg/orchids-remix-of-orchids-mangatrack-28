#!/usr/bin/env bash
# =============================================================================
# start-dev-safe.sh — Safe dev server wrapper
#
# WHY: Repeated `npm run dev` / `bun run dev` invocations can create zombie
# processes and port conflicts when the previous instance is still running.
# This wrapper checks if port 3000 is already in use *before* spawning a new
# server.  If a listener is detected it prints the owner PID and exits 1.
#
# BEHAVIOUR:
#   - Port occupied  -> print info, exit 1  (no new instance)
#   - Port free      -> start dev server in background, write PID & log to .dev/
#
# The script is intentionally non-destructive: it never kills existing
# processes.  It only *refuses* to start a second one.
# =============================================================================

set -euo pipefail

PORT="${DEV_PORT:-3000}"
DEV_DIR=".dev"
PID_FILE="${DEV_DIR}/pid"
LOG_FILE="${DEV_DIR}/dev.log"

# ---- port detection ---------------------------------------------------------
# We try four methods in order of specificity.  In some container environments
# lsof/ss cannot see listeners owned by child processes, so /proc/net/tcp and
# curl serve as reliable fallbacks.

DETECTED_PID=""
OCCUPIED=""

# Method 1: lsof (most portable across macOS + Linux)
if command -v lsof &>/dev/null; then
  DETECTED_PID=$(lsof -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1) || true
fi

# Method 2: ss (Linux)
if [ -z "$DETECTED_PID" ] && command -v ss &>/dev/null; then
  DETECTED_PID=$(ss -ltnp "sport = :${PORT}" 2>/dev/null \
        | grep -oP 'pid=\K[0-9]+' | head -1) || true
fi

if [ -n "$DETECTED_PID" ]; then
  OCCUPIED="true"
fi

# Method 3: /proc/net/tcp (Linux containers where lsof/ss can't see children)
# State 0A = LISTEN. We must filter for LISTEN only; TIME_WAIT (06) entries
# linger after a server exits and cause false positives.
if [ -z "$OCCUPIED" ] && [ -f /proc/net/tcp ]; then
  HEX_PORT=$(printf '%04X' "$PORT")
  if awk -v port=":${HEX_PORT}" '$2 ~ port && $4 == "0A"' /proc/net/tcp 2>/dev/null | grep -q .; then
    DETECTED_PID="unknown"
    OCCUPIED="true"
  fi
fi

# Method 4: curl probe (last resort — works everywhere)
if [ -z "$OCCUPIED" ] && curl -s --max-time 2 -o /dev/null http://127.0.0.1:"${PORT}" 2>/dev/null; then
  DETECTED_PID="unknown"
  OCCUPIED="true"
fi

# ---- main -------------------------------------------------------------------

if [ "$OCCUPIED" = "true" ]; then
  echo "Port ${PORT} is already in use (PID: ${DETECTED_PID})."
  echo "Dev server appears to be running — not starting a second instance."
  exit 1
fi

# Ensure .dev directory exists
mkdir -p "$DEV_DIR"

echo "Starting dev server on port ${PORT}..."

# Use setsid to detach the server into its own process group so it survives
# if this wrapper's parent terminal exits.
if command -v setsid &>/dev/null; then
  setsid bun run next dev --turbopack -H 0.0.0.0 -p "$PORT" \
    > "$LOG_FILE" 2>&1 &
else
  # macOS / environments without setsid — nohup fallback
  nohup bun run next dev --turbopack -H 0.0.0.0 -p "$PORT" \
    > "$LOG_FILE" 2>&1 &
fi

DEV_PID=$!
echo "$DEV_PID" > "$PID_FILE"

echo "Dev server started (PID ${DEV_PID})."
echo "  Log: ${LOG_FILE}"
echo "  PID file: ${PID_FILE}"
