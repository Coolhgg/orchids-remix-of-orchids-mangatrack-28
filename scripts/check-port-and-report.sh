#!/usr/bin/env bash
# =============================================================================
# check-port-and-report.sh — CI pre-start health check
#
# Exits non-zero if a dev server is already listening on the target port.
# Intended for CI pipelines to fail early rather than create port conflicts.
# =============================================================================

set -euo pipefail

PORT="${DEV_PORT:-3000}"

is_port_occupied() {
  # Method 1: lsof
  if command -v lsof &>/dev/null; then
    local pid
    pid=$(lsof -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1)
    if [ -n "$pid" ]; then echo "PID $pid"; return 0; fi
  fi

  # Method 2: ss
  if command -v ss &>/dev/null; then
    local pid
    pid=$(ss -ltnp "sport = :${PORT}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1)
    if [ -n "$pid" ]; then echo "PID $pid"; return 0; fi
  fi

  # Method 3: /proc/net/tcp
  local hex_port
  hex_port=$(printf '%04X' "$PORT")
  if [ -f /proc/net/tcp ] && grep -q ":${hex_port} " /proc/net/tcp 2>/dev/null; then
    echo "PID unknown (detected via /proc/net/tcp)"; return 0
  fi

  # Method 4: curl probe
  if curl -s --max-time 2 -o /dev/null http://127.0.0.1:"${PORT}" 2>/dev/null; then
    echo "PID unknown (detected via curl)"; return 0
  fi

  return 1
}

OWNER=$(is_port_occupied) && {
  echo "FAIL: Port ${PORT} is already in use — ${OWNER}."
  echo "A dev server may already be running. Resolve before starting CI."
  exit 1
}

echo "OK: Port ${PORT} is free. Safe to start dev server."
exit 0
