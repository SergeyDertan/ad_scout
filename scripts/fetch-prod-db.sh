#!/usr/bin/env bash
#
# Bring the production database down to this machine, as an archive, for
# read-only diagnosis. It writes NOTHING to the VPS and needs only read access:
# the live store is tarred to stdout and streamed over the ssh channel, and the
# hourly dumps are copied as they are.
#
#   ./scripts/fetch-prod-db.sh              # the LIVE store, as it is right now
#   ./scripts/fetch-prod-db.sh --backup     # the newest hourly dump instead
#   ./scripts/fetch-prod-db.sh --no-import  # download only, don't open it locally
#
# TWO MODES, AND WHY BOTH EXIST.
#
#   --live (default) tars /opt/adscout/data/pouch while the server is running.
#   That is the CURRENT state, including anything that happened in the last few
#   minutes — which is the point when you are chasing something you just saw in
#   the UI. The cost is that LevelDB is being written underneath the tar: the
#   copy can catch a write-ahead log mid-write. In practice it opens fine, and
#   nothing is at risk either way because the copy is read-only and the original
#   is untouched. If it does not open, that is what --backup is for.
#
#   --backup takes the newest hourly archive from /opt/adscout/backups. Those are
#   written in-process under the same passLock the pipeline passes take
#   (services/backup.ts), so they are consistent by construction and verified on
#   load — but they are up to an hour old, and a message sent since the last one
#   simply will not be in there.
#
# WHY NOT `pnpm data:dump` ON THE SERVER: PouchDB is single-writer, so the CLI
# cannot open the store while the service holds it. Dumping would mean stopping
# the service — and `stop` is not in the adscout user's NOPASSWD sudoers list
# (docs/VPS-DEPLOY.md §2), so it is not something a script should be doing on its
# own anyway. The hourly backup exists precisely so nobody has to.
#
# WHAT YOU END UP WITH:
#   backups/adscout-live-<ts>.tar.gz   the archive (gitignored)
#   data/pouch-prod                    a local store you can point tools at:
#                                        STORE=pouchdb POUCH_DIR=./data/pouch-prod
#
# An existing data/pouch-prod is MOVED ASIDE, never deleted — you get told where.
#
# CREDENTIALS. Both archives contain Account.oauthTokens.refreshToken for every
# mailbox, in the clear. backups/, data-dump/ and data/ are all gitignored, but
# treat what this script leaves behind as mailbox credentials and delete it when
# the investigation is done.
#
# SSH TARGET, AND WHY IT IS NOT JUST AN IP. adscout.dva-lymona.biz.ua is behind
# Cloudflare, whose proxy carries 80/443 only — an ssh to the public name hangs.
# So the address here is the origin IP. But a RAW IP matches no `Host` block in
# ~/.ssh/config, which is where the IdentityFile and User usually live: point
# this at an IP and ssh offers its default key names, the server rejects them,
# and you get a password prompt on a box you have perfectly good key access to.
#
# Hence ADSCOUT_SSH: give it whatever target already works from your shell — an
# alias from your ssh config is best, since the config then supplies the user and
# the key. It is passed through verbatim.
#
#   ADSCOUT_SSH=adscout ./scripts/fetch-prod-db.sh          # a Host alias
#   ADSCOUT_SSH=adscout@95.216.149.252 ./scripts/...        # explicit
#   ADSCOUT_SSH_USER= ./scripts/...                         # let the config decide
#
# Env:
#   ADSCOUT_SSH                   complete ssh target, verbatim. Overrides the two below.
#   ADSCOUT_HOST=95.216.149.252   the VPS origin IP (Cloudflare hides the name)
#   ADSCOUT_SSH_USER=adscout      service user that owns /opt/adscout. Set it EMPTY
#                                 to send no user at all and let ssh_config choose.
#   ADSCOUT_SSH_OPTS             extra ssh/scp flags, e.g. '-i ~/.ssh/adscout'
#   ADSCOUT_REMOTE=/opt/adscout   deployment root on the VPS

set -euo pipefail

HOST="${ADSCOUT_HOST:-95.216.149.252}"
REMOTE="${ADSCOUT_REMOTE:-/opt/adscout}"
# Unset ⇒ adscout. Set-but-empty ⇒ deliberately no user, so ssh_config decides.
SSH_USER="${ADSCOUT_SSH_USER-adscout}"
if [ -n "${ADSCOUT_SSH:-}" ]; then
  TARGET="$ADSCOUT_SSH"
elif [ -n "$SSH_USER" ]; then
  TARGET="${SSH_USER}@${HOST}"
else
  TARGET="$HOST"
fi
# Word-split deliberately: these are flags, not one argument.
# shellcheck disable=SC2206
SSH_OPTS=( ${ADSCOUT_SSH_OPTS:-} )

# The `${a[@]+...}` guard is for bash 3.2, which macOS still ships as /bin/bash:
# expanding an EMPTY array under `set -u` is an error there.
ssh_() { ssh ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$@"; }
scp_() { scp ${SSH_OPTS[@]+"${SSH_OPTS[@]}"} "$@"; }

MODE=live
IMPORT=yes
for arg in "$@"; do
  case "$arg" in
    --live)      MODE=live ;;
    --backup)    MODE=backup ;;
    --no-import) IMPORT=no ;;
    # The whole leading comment block, however long it grows — a line range here
    # silently starts truncating the help the first time the header is edited.
    -h|--help)   awk 'NR>1 && /^#/ {sub(/^# ?/, ""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *)           echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Run from the repo root whatever directory you invoked this from, so the
# relative paths below (backups/, data/) always mean the same thing.
cd "$(dirname "$0")/.."

STAMP="$(date +%Y-%m-%dT%H%M%S)"
mkdir -p backups

echo "→ ${TARGET}:${REMOTE}"
# Fail here, with a readable message, rather than three commands later. A first
# connection BY IP will not match a known_hosts entry made for the domain, so
# expect a host-key prompt the first time.
#
# BatchMode so a target ssh cannot authenticate FAILS instead of sitting on a
# password prompt. A password prompt here is not "you need the password" — it is
# ssh telling you it found no usable key, which for this box means the target
# matched no Host block in your ssh config. Say so, rather than inviting someone
# to type a service account's password into a script.
if ! ssh_ -o ConnectTimeout=10 -o BatchMode=yes "$TARGET" "test -d ${REMOTE}/data/pouch"; then
  echo >&2
  echo "cannot open ${REMOTE}/data/pouch as ${TARGET} with a key." >&2
  echo >&2
  echo "If you normally reach this box without a password, you reach it by an ALIAS," >&2
  echo "and a bare IP matches no Host block — so no IdentityFile is selected. Use the" >&2
  echo "alias that already works:" >&2
  echo >&2
  echo "    grep -B2 -A6 -i '95.216.149.252' ~/.ssh/config      # find its name" >&2
  echo "    ADSCOUT_SSH=<that alias> $0 $*" >&2
  echo >&2
  echo "Or point at the key directly:  ADSCOUT_SSH_OPTS='-i ~/.ssh/<key>' $0 $*" >&2
  exit 1
fi

# For orientation, whichever mode is running: how stale the safe copy would be.
echo -n "→ newest hourly backup: "
ssh_ "$TARGET" "ls -t ${REMOTE}/backups/*.tar.gz 2>/dev/null | head -1 | xargs -r basename" || true

if [ "$MODE" = live ]; then
  ARCHIVE="backups/adscout-live-${STAMP}.tar.gz"

  # STREAMED, not staged-then-scp'd. Writing the archive on the VPS first would
  # need write access to a directory owned by the service user, and — worse —
  # would drop a complete copy of the store, every mailbox's refresh token
  # included, into a world-readable directory for as long as the transfer took.
  # tar to stdout crosses the ssh channel and lands here. Nothing is written on
  # the far side, so nothing has to be cleaned up, and read access is enough.
  echo "→ streaming the live store down"
  ssh_ "$TARGET" "tar -czf - -C '${REMOTE}/data' pouch" > "$ARCHIVE"
  # A failed ssh still leaves the redirect's empty file behind; a truncated
  # stream leaves a short one. Either way it is not a store, so do not pretend.
  if [ ! -s "$ARCHIVE" ] || ! tar -tzf "$ARCHIVE" >/dev/null 2>&1; then
    rm -f "$ARCHIVE"
    echo "the stream did not produce a readable archive — nothing was written" >&2
    exit 1
  fi
else
  REMOTE_ARCHIVE="$(ssh_ "$TARGET" "ls -t ${REMOTE}/backups/*.tar.gz | head -1")"
  if [ -z "$REMOTE_ARCHIVE" ]; then
    echo "no backups in ${REMOTE}/backups — is BACKUP=off?" >&2
    exit 1
  fi
  ARCHIVE="backups/$(basename "$REMOTE_ARCHIVE")"
  echo "→ scp $(basename "$REMOTE_ARCHIVE")"
  scp_ "${TARGET}:${REMOTE_ARCHIVE}" "$ARCHIVE"
fi

echo "→ ${ARCHIVE}  ($(du -h "$ARCHIVE" | cut -f1))"

if [ "$IMPORT" = no ]; then
  echo "downloaded only (--no-import)."
  exit 0
fi

# An existing local copy is moved, not removed: it may be the one from the run
# where you found something, and re-fetching should not be able to lose it.
if [ -e data/pouch-prod ]; then
  ASIDE="data/pouch-prod.${STAMP}"
  mv data/pouch-prod "$ASIDE"
  echo "→ previous copy moved to ${ASIDE}"
fi
mkdir -p data

if [ "$MODE" = live ]; then
  STAGE="$(mktemp -d)"
  trap 'rm -rf "$STAGE"' EXIT
  tar -xzf "$ARCHIVE" -C "$STAGE"
  mv "${STAGE}/pouch" data/pouch-prod
else
  # A dump archive is NDJSON + manifest.json, replayed through the Store port —
  # which also verifies it: data:load exits non-zero if any type's count differs
  # from the manifest.
  rm -rf data-dump && mkdir -p data-dump
  tar -xzf "$ARCHIVE" -C data-dump
  STORE=pouchdb POUCH_DIR=./data/pouch-prod pnpm data:load --in ./data-dump
fi

cat <<EOF

data/pouch-prod is ready. Point read-only tools at it:

  STORE=pouchdb POUCH_DIR=./data/pouch-prod pnpm tsx src/scripts/audit-duplicate-outreach.ts

If that fails to open the store, the live copy was caught mid-write — re-run
with --backup for the consistent hourly dump.
EOF
