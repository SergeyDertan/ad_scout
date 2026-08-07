#!/usr/bin/env bash
#
# Unattended wrapper for `pnpm reextract:stored --extract-only`: run it, and when
# the Claude subscription window is exhausted, sleep an hour and resume — until
# every stored reply is re-extracted.
#
# Why plain re-running is a valid resume: reextract-stored exits 2 on a usage
# limit, and the reply it was working on (plus everything after it) is left
# 'pending' with no partial writes — the limit is thrown by the model call,
# before anything is persisted. --extract-only then picks up exactly the
# pending/failed replies. See src/scripts/reextract-stored.ts.
#
# Exit codes it reacts to:
#   0   finished        → stop, success. THE ONLY STOP CONDITION. Means every
#                         reply extracted, not merely "the pass ended".
#   *   anything else   → sleep $SLEEP_SECS, then resume. Deliberately
#                         undiscriminating: usage limit, crash, or anything else
#                         is retried the same way. The loop does not judge which
#                         errors are worth retrying — it re-runs until a pass
#                         comes back clean.
#
#   ./scripts/reextract-loop.sh [extra flags, e.g. --concurrency 5]
#
# Env:
#   SLEEP_SECS=3600      how long to wait after any error (default 1 hour).
#   MAX_CYCLES=24        stop after this many runs, whatever happens (default 24).
#                        The only bound on an otherwise endless retry — raise it
#                        for a long unattended run.
#
# Example:
#   STORE=pouchdb LLM_PROVIDER=claude-code ./scripts/reextract-loop.sh --concurrency 5
#
# --extract-only is passed on every cycle and is NOT optional: the bare command
# also runs the wipe phase, which would reset each cycle's progress to 'pending'
# and loop forever. To wipe first, do it once by hand (`pnpm reextract:stored
# --clear-only`), then start this loop.

set -uo pipefail # deliberately NOT -e: the exit code is the signal we branch on

cd "$(dirname "$0")/.." || exit 1

SLEEP_SECS="${SLEEP_SECS:-3600}"
MAX_CYCLES="${MAX_CYCLES:-24}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Clock time we would wake up at, $1 seconds from now — BSD (macOS) and GNU date
# take different flags.
resume_at() {
  date -v+"$1"S '+%H:%M:%S' 2>/dev/null ||
    date -d "+$1 seconds" '+%H:%M:%S' 2>/dev/null ||
    echo "+$1s"
}

# Ctrl-C during the sleep must end the loop, not just the sleep.
trap 'echo; log "interrupted — nothing is lost; resume with: pnpm reextract:stored --extract-only"; exit 130' INT TERM

cycle=1
while [ "$cycle" -le "$MAX_CYCLES" ]; do
  log "cycle ${cycle}/${MAX_CYCLES}: pnpm reextract:stored --extract-only $*"
  pnpm reextract:stored --extract-only "$@"
  code=$?

  if [ "$code" -eq 0 ]; then
    log "re-extraction finished."
    exit 0
  fi

  # Out of cycles: report the last code rather than sleeping for a run we will
  # never make.
  if [ "$cycle" -eq "$MAX_CYCLES" ]; then
    log "exit ${code}, and MAX_CYCLES (${MAX_CYCLES}) reached — stopping. Re-run to continue; check logs/adscout-*.log."
    exit "$code"
  fi

  # Sleep on any failure and retry until MAX_CYCLES is reached
  wait_secs="$SLEEP_SECS"
  why="exit ${code}"
  log "${why}. Sleeping ${wait_secs}s, resuming ~$(resume_at "$wait_secs"). (DB unlocked meanwhile.)"
  sleep "$wait_secs"

  cycle=$((cycle + 1))
done

# Only reachable with MAX_CYCLES < 1 — the in-loop guard exits on the last cycle.
log "MAX_CYCLES (${MAX_CYCLES}) leaves nothing to run."
exit 2
