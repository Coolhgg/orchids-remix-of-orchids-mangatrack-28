#!/usr/bin/env bash
# monitor_zombies.sh — Zombie Process Monitor
# Counts zombie processes and alerts when count exceeds threshold.
# Designed to run via cron every 5 minutes.
#
# Usage: bash scripts/monitor_zombies.sh [--threshold N]
#
# Alerts: /tmp/zombie-alert-<epoch>.log
# Log:    /var/log/zombie-monitor.log

set -euo pipefail

THRESHOLD=5
LOG_FILE="/var/log/zombie-monitor.log"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --threshold) THRESHOLD="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

TIMESTAMP=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
EPOCH=$(date +%s)

# Count zombies
ZOMBIE_COUNT=$(ps -eo stat 2>/dev/null | grep -c '^Z' || true)

# Always log the check
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
echo "$TIMESTAMP zombie_count=$ZOMBIE_COUNT threshold=$THRESHOLD" >> "$LOG_FILE" 2>/dev/null || \
  echo "$TIMESTAMP zombie_count=$ZOMBIE_COUNT threshold=$THRESHOLD" >> "/tmp/zombie-monitor.log"

if [ "$ZOMBIE_COUNT" -gt "$THRESHOLD" ]; then
  ALERT_FILE="/tmp/zombie-alert-${EPOCH}.log"
  {
    echo "=== ZOMBIE ALERT ==="
    echo "Time: $TIMESTAMP"
    echo "Zombie count: $ZOMBIE_COUNT (threshold: $THRESHOLD)"
    echo ""
    echo "--- Zombie Processes ---"
    ps -eo pid,ppid,stat,cmd 2>/dev/null | awk 'NR==1 || $3 ~ /Z/ {print}'
    echo ""
    echo "--- Parent Processes ---"
    ps -eo pid,ppid,stat,cmd 2>/dev/null | awk '$3 ~ /Z/ {print $2}' | sort -un | while read -r ppid; do
      echo "Parent $ppid:"
      ps -o pid,ppid,stat,cmd -p "$ppid" 2>/dev/null || echo "  (no longer running)"
    done
    echo ""
    echo "--- System Info ---"
    echo "Total processes: $(ps -e --no-headers 2>/dev/null | wc -l)"
    echo "Uptime: $(uptime 2>/dev/null || echo 'unavailable')"
  } > "$ALERT_FILE"

  # Also append alert summary to the log
  echo "$TIMESTAMP ALERT: $ZOMBIE_COUNT zombies exceed threshold ($THRESHOLD). Details: $ALERT_FILE" >> "$LOG_FILE" 2>/dev/null || \
    echo "$TIMESTAMP ALERT: $ZOMBIE_COUNT zombies exceed threshold ($THRESHOLD). Details: $ALERT_FILE" >> "/tmp/zombie-monitor.log"

  echo "ALERT: $ZOMBIE_COUNT zombie processes detected (threshold: $THRESHOLD)"
  echo "Alert written to: $ALERT_FILE"
  exit 1
else
  echo "OK: $ZOMBIE_COUNT zombie processes (threshold: $THRESHOLD)"
  exit 0
fi
