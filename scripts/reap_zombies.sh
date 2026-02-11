#!/usr/bin/env bash
# reap_zombies.sh — Zombie Process Reaper Advisor
# Audits zombie (<defunct>) processes, identifies parents, and produces
# a safe action plan. Does NOT kill any process automatically.
#
# Usage: bash scripts/reap_zombies.sh [--output /path/to/plan.txt]
#
# Output: /tmp/reap-plan.txt (or custom path via --output)

set -euo pipefail

OUTPUT="/tmp/reap-plan.txt"
ZOMBIE_LIST="/tmp/zombie-processes.txt"
PARENT_LIST="/tmp/zombie-parent-pids.txt"
PARENT_INFO="/tmp/zombie-parent-info.txt"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

echo "=== Zombie Process Reaper Advisor ==="
echo "Date: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo ""

# 1. Collect zombies
ps -eo pid,ppid,stat,cmd 2>/dev/null | awk '$3 ~ /Z/ {print}' > "$ZOMBIE_LIST"
ZOMBIE_COUNT=$(wc -l < "$ZOMBIE_LIST" | tr -d ' ')

echo "Zombie count: $ZOMBIE_COUNT"

if [ "$ZOMBIE_COUNT" -eq 0 ]; then
  echo "No zombie processes found. Nothing to do."
  echo "ZOMBIE_COUNT=0" > "$OUTPUT"
  echo "STATUS=clean" >> "$OUTPUT"
  exit 0
fi

# 2. Extract unique parent PIDs
awk '{print $2}' "$ZOMBIE_LIST" | sort -un > "$PARENT_LIST"
UNIQUE_PARENTS=$(wc -l < "$PARENT_LIST" | tr -d ' ')
echo "Unique parent PIDs: $UNIQUE_PARENTS"
echo ""

# 3. Gather parent info
> "$PARENT_INFO"
while IFS= read -r ppid; do
  echo "PARENT $ppid:" >> "$PARENT_INFO"
  ps -o pid,ppid,stat,cmd -p "$ppid" 2>/dev/null >> "$PARENT_INFO" || echo "  (process $ppid no longer exists)" >> "$PARENT_INFO"
  echo "" >> "$PARENT_INFO"
done < "$PARENT_LIST"

# 4. Generate action plan
{
  echo "=== ZOMBIE REAP ACTION PLAN ==="
  echo "Generated: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "Total zombies: $ZOMBIE_COUNT"
  echo "Unique parents: $UNIQUE_PARENTS"
  echo ""
  echo "--- PARENT ANALYSIS ---"
  echo ""

  while IFS= read -r ppid; do
    # Count zombies under this parent
    child_count=$(awk -v p="$ppid" '$2 == p {count++} END {print count+0}' "$ZOMBIE_LIST")
    # Get parent command
    parent_cmd=$(ps -o cmd= -p "$ppid" 2>/dev/null || echo "(exited)")

    if [ "$ppid" -eq 1 ]; then
      echo "SKIP: parent=$ppid cmd='$parent_cmd' zombies=$child_count"
      echo "  Reason: PID 1 (init/container supervisor) — cannot be restarted."
      echo "  Zombies will persist until container restart or init gains a reaper."
      echo "  Recommendation: Use 'tini' or 'dumb-init' as container entrypoint."
      echo ""
    elif [ "$ppid" -eq 0 ]; then
      echo "SKIP: parent=$ppid (kernel) zombies=$child_count"
      echo "  Reason: Kernel-owned process — no action possible."
      echo ""
    else
      # Check if parent is still alive
      if kill -0 "$ppid" 2>/dev/null; then
        echo "REAP_CANDIDATE: parent=$ppid cmd='$parent_cmd' zombies=$child_count"
        echo "  action='restart parent: kill -TERM $ppid then wait'"
        echo "  Manual command:"
        echo "    kill -TERM $ppid   # graceful shutdown"
        echo "    sleep 2"
        echo "    kill -0 $ppid 2>/dev/null && kill -KILL $ppid  # force if still alive"
        echo "  WARNING: Verify this process is safe to restart before executing."
        echo ""
      else
        echo "ORPHANED: parent=$ppid (no longer running) zombies=$child_count"
        echo "  Zombies should have been reparented to init. They will be reaped"
        echo "  when init calls wait(), or on container restart."
        echo ""
      fi
    fi
  done < "$PARENT_LIST"

  echo "--- ZOMBIE DETAILS ---"
  echo ""
  printf "%-8s %-8s %-6s %s\n" "PID" "PPID" "STAT" "CMD"
  while IFS= read -r line; do
    # shellcheck disable=SC2086
    set -- $line
    printf "%-8s %-8s %-6s %s\n" "$1" "$2" "$3" "${4:-[unknown]}"
  done < "$ZOMBIE_LIST"

  echo ""
  echo "--- END OF PLAN ---"
  echo "NOTE: No processes were killed. Review candidates above and run commands manually."
} > "$OUTPUT"

echo ""
echo "Action plan written to: $OUTPUT"
cat "$OUTPUT"
