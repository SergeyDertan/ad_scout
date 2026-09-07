#!/usr/bin/env bash
#
# Bring the production database down to this machine, as an archive, for
# read-only diagnosis. Nothing here writes to the VPS except one temporary
# archive in its own backups/ directory, which is deleted again before the
# script exits.
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
# Env:
#   ADSCOUT_HOST=95.216.149.252   the VPS (IP, so it does not depend on DNS)
#   ADSCOUT_SSH_USER=adscout      the service user that owns /opt/adscout
#   ADSCOUT_REMOTE=/opt/adscout   deployment root on the VPS

set -euo pipefail

HOST="${ADSCOUT_HOST:-95.216.149.252}"
SSH_USER="${ADSCOUT_SSH_USER:-adscout}"
REMOTE="${ADSCOUT_REMOTE:-/opt/adscout}"
TARGET="${SSH_USER}@${HOST}"

MODE=live
IMPORT=yes
for arg in "$@"; do
  case "$arg" in
    --live)      MODE=live ;;
    --backup)    MODE=backup ;;
    --no-import) IMPORT=no ;;
    -h|--help)   sed -n '2,48p' "$0" | sed 's/^#\{1,2\} \{0,1\}//'; exit 0 ;;
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
if ! ssh -o ConnectTimeout=10 "$TARGET" "test -d ${REMOTE}/data/pouch"; then
  echo "cannot reach ${REMOTE}/data/pouch on ${TARGET}" >&2
  echo "check the ssh user (ADSCOUT_SSH_USER=root ./scripts/fetch-prod-db.sh) or your key" >&2
  exit 1
fi

# For orientation, whichever mode is running: how stale the safe copy would be.
echo -n "→ newest hourly backup: "
ssh "$TARGET" "ls -t ${REMOTE}/backups/*.tar.gz 2>/dev/null | head -1 | xargs -r basename" || true

if [ "$MODE" = live ]; then
  ARCHIVE="backups/adscout-live-${STAMP}.tar.gz"
  REMOTE_TMP="${REMOTE}/backups/.fetch-${STAMP}.tar.gz"

  echo "→ archiving the live store on the VPS"
  # -C so the archive holds `pouch/...` and not the whole absolute path.
  ssh "$TARGET" "tar -czf '${REMOTE_TMP}' -C '${REMOTE}/data' pouch"
  echo "→ scp"
  scp "${TARGET}:${REMOTE_TMP}" "$ARCHIVE"
  # Always clean up after ourselves, including on a failed scp.
  ssh "$TARGET" "rm -f '${REMOTE_TMP}'"
else
  REMOTE_ARCHIVE="$(ssh "$TARGET" "ls -t ${REMOTE}/backups/*.tar.gz | head -1")"
  if [ -z "$REMOTE_ARCHIVE" ]; then
    echo "no backups in ${REMOTE}/backups — is BACKUP=off?" >&2
    exit 1
  fi
  ARCHIVE="backups/$(basename "$REMOTE_ARCHIVE")"
  echo "→ scp $(basename "$REMOTE_ARCHIVE")"
  scp "${TARGET}:${REMOTE_ARCHIVE}" "$ARCHIVE"
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
