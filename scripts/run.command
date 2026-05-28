#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log_step() {
  printf '\n==> %s\n' "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

pause_on_failure() {
  local status="$1"
  if [[ "$status" -ne 0 && "$status" -ne 130 ]]; then
    echo
    echo "tapebox run failed with exit code $status."
    read -r -p "Press Enter to close..."
  fi
}

trap 'pause_on_failure $?' EXIT

# ── Safe kill of any leftover tapebox dev processes ──────────────────────────
# Only kills processes whose full command line contains this repo's absolute
# path — never other Electron apps or unrelated node/vite invocations. Skips
# this script's own PID and any other shell scripts named run.command so we
# never SIGTERM ourselves while iterating.

kill_leftover_tapebox() {
  local self_pid="$$"
  local pids=()
  # ps -axww: list every process, full command line, no truncation.
  while IFS=' ' read -r pid rest; do
    [[ -z "${pid:-}" ]] && continue
    [[ "$pid" == "$self_pid" ]] && continue
    case "$rest" in
      *run.command*) continue ;;
    esac
    case "$rest" in
      *"$REPO_DIR"*) pids+=("$pid") ;;
    esac
  done < <(ps -axww -o pid=,command=)

  if [[ ${#pids[@]} -eq 0 ]]; then
    return 0
  fi

  log_step "Stopping ${#pids[@]} leftover tapebox process(es): ${pids[*]}"
  for pid in "${pids[@]}"; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  # Give them a moment to exit on SIGTERM, then SIGKILL any survivors.
  local waited=0
  while [[ $waited -lt 5 ]]; do
    local alive=()
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then alive+=("$pid"); fi
    done
    if [[ ${#alive[@]} -eq 0 ]]; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done

  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "  force-killing $pid"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

require_command node
require_command npm

cd "$REPO_DIR"

log_step "Stopping any leftover tapebox processes"
kill_leftover_tapebox

log_step "Installing dependencies"
npm install

log_step "Starting TapeBox in development mode"
npm run dev
