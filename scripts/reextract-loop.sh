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
#   0   finished        → stop, success. Means every reply extracted, not merely
#                         "the pass ended" — see 3.
#   2   usage limit     → sleep $SLEEP_SECS, then resume. This is the retry case.
#   3   replies failed  → the pass ran to the end but left N replies 'failed'.
#                         Sleep $FAIL_SLEEP_SECS (short — nothing needs to reset)
#                         and re-run, which retries exactly those replies. Most
#                         are transient: a killed/timed-out CLI call, a tool_use
#                         error. Capped at $MAX_FAIL_RETRIES so replies that fail
#                         for a permanent reason (a reply the model simply cannot
#                         parse) don't burn the whole cycle budget.
#   *   real failure    → stop, propagating the code. A crash (bad env, dead
#                         store, unparseable CLI output) recurs identically every
#                         cycle, so retrying would burn the next window on the
#                         same broken input. Set RETRY_ANY=1 to retry these too.
#
#   ./scripts/reextract-loop.sh [extra flags, e.g. --concurrency 5]
#
# Env:
#   SLEEP_SECS=3600      how long to wait after a usage limit (default 1 hour).
#   FAIL_SLEEP_SECS=60   how long to wait before retrying failed replies.
#   MAX_FAIL_RETRIES=3   how many times to retry failed replies (default 3).
#   MAX_CYCLES=24        stop after this many runs, whatever happens (default 24).
#   RETRY_ANY=1          also retry non-zero exits other than 2 and 3 (default: off).
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
FAIL_SLEEP_SECS="${FAIL_SLEEP_SECS:-60}"
MAX_FAIL_RETRIES="${MAX_FAIL_RETRIES:-3}"
MAX_CYCLES="${MAX_CYCLES:-24}"
RETRY_ANY="${RETRY_ANY:-0}"

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
fail_retries=0
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
    log "usage limit hit. Sleeping ${SLEEP_SECS}s, resuming ~$(resume_at "$SLEEP_SECS"). (DB unlocked meanwhile.)"
    sleep "$SLEEP_SECS"
    ;;
  3)
    # The pass reached the end; some replies are parked 'failed'. Re-running
    # --extract-only picks up exactly those, so this retries the failures alone —
    # it does not redo the work that succeeded.
    fail_retries=$((fail_retries + 1))
    if [ "$fail_retries" -gt "$MAX_FAIL_RETRIES" ]; then
      log "replies still failing after ${MAX_FAIL_RETRIES} retry(ies) — treating them as permanent. Check logs/adscout-*.log."
      exit 3
    fi
    if [ "$cycle" -eq "$MAX_CYCLES" ]; then
      log "replies still failed, and MAX_CYCLES reached — stopping. Re-run to continue."
      exit 3
    fi
    log "pass finished with failed replies. Retry ${fail_retries}/${MAX_FAIL_RETRIES} in ${FAIL_SLEEP_SECS}s (~$(resume_at "$FAIL_SLEEP_SECS"))."
    sleep "$FAIL_SLEEP_SECS"
    ;;
  *)
    if [ "$RETRY_ANY" = "1" ]; then
      if [ "$cycle" -eq "$MAX_CYCLES" ]; then
        log "exit ${code} — RETRY_ANY set, but MAX_CYCLES reached. Stopping."
        exit "$code"
      fi
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
