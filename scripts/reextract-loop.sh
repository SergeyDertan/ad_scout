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
#   0   finished        → stop, success.
#   2   usage limit     → sleep $SLEEP_SECS, then resume. This is the retry case.
#   *   real failure    → stop, propagating the code. A crash (bad env, dead
#                         store, unparseable CLI output) recurs identically every
#                         cycle, so retrying would burn the next window on the
#                         same broken input. Set RETRY_ANY=1 to retry these too.
#
#   ./scripts/reextract-loop.sh [extra flags, e.g. --concurrency 5]
#
# Env:
#   SLEEP_SECS=3600   how long to wait after a usage limit (default 1 hour).
#   MAX_CYCLES=24     stop after this many runs, whatever happens (default 24).
#   RETRY_ANY=1       also retry non-zero exits other than 2 (default: off).
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
RETRY_ANY="${RETRY_ANY:-0}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# Clock time we would wake up at — BSD (macOS) and GNU date take different flags.
resume_at() {
  date -v+"${SLEEP_SECS}"S '+%H:%M:%S' 2>/dev/null ||
    date -d "+${SLEEP_SECS} seconds" '+%H:%M:%S' 2>/dev/null ||
    echo "+${SLEEP_SECS}s"
}

# Ctrl-C during the sleep must end the loop, not just the sleep.
trap 'echo; log "interrupted — nothing is lost; resume with: pnpm reextract:stored --extract-only"; exit 130' INT TERM

cycle=1
while [ "$cycle" -le "$MAX_CYCLES" ]; do
  log "cycle ${cycle}/${MAX_CYCLES}: pnpm reextract:stored --extract-only $*"
  pnpm reextract:stored --extract-only "$@"
  code=$?

  case "$code" in
  0)
    log "re-extraction finished."
    exit 0
    ;;
  2)
    if [ "$cycle" -eq "$MAX_CYCLES" ]; then
      log "usage limit again, and MAX_CYCLES reached — stopping. Re-run to continue."
      exit 2
    fi
    log "usage limit hit. Sleeping ${SLEEP_SECS}s, resuming ~$(resume_at). (DB unlocked meanwhile.)"
    sleep "$SLEEP_SECS"
    ;;
  *)
    if [ "$RETRY_ANY" = "1" ]; then
      log "exit ${code} — RETRY_ANY set, sleeping ${SLEEP_SECS}s before retrying."
      sleep "$SLEEP_SECS"
    else
      log "exit ${code} — not a usage limit. Stopping; check logs/adscout-*.log."
      exit "$code"
    fi
    ;;
  esac

  cycle=$((cycle + 1))
done

log "MAX_CYCLES (${MAX_CYCLES}) exhausted."
exit 2
