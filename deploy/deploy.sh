#!/usr/bin/env bash
#
# Deploy AdScout on the VPS: fetch, build, gate on the test suite, restart, and
# roll back automatically if the new revision does not come up healthy.
#
#     ssh adscout@host '/opt/adscout/deploy/deploy.sh'
#     ./deploy/deploy.sh v1.2.3        # a tag or commit, instead of origin/main
#
# Run it as the service user. It needs exactly two privileged actions, so give
# that user a narrow sudoers rule rather than blanket sudo:
#
#     # /etc/sudoers.d/adscout
#     adscout ALL=(root) NOPASSWD: /bin/systemctl restart adscout, \
#                                  /bin/systemctl is-active adscout
#
# WHY A SCRIPT AND NOT `git pull && systemctl restart`: web/dist is gitignored
# and served from disk, so a restart without a build serves whatever the last
# build left behind — or nothing. And a failed deploy on this box does not just
# break a website, it stops outreach and reply polling. So: build BEFORE
# restarting, gate on the tests, verify it answers afterwards, and put the old
# revision back if it does not.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/adscout}"
SERVICE="${SERVICE:-adscout}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8787/api/auth}"
# Seconds to wait for the service to answer after a restart. Boot does a
# reconcile that talks to Gmail, so allow for a slow one.
HEALTH_RETRIES="${HEALTH_RETRIES:-30}"
TARGET="${1:-origin/main}"
# Rebuild and restart even when the revision has not changed. This is what
# "redeploy" means: you edited .env on the box, and .env is read at boot. Without
# it the run below would short-circuit and quietly change nothing.
FORCE="${FORCE:-}"

cd "$APP_DIR"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

# Never clobber uncommitted work — on a server that is usually a hotfix someone
# made in place and has not pushed.
if ! git diff --quiet || ! git diff --cached --quiet; then
  die "working tree is dirty. Commit, stash or discard before deploying."
fi

PREVIOUS="$(git rev-parse HEAD)"
say "current revision ${PREVIOUS:0:8}"

say "fetching"
git fetch --prune origin
git checkout --quiet --detach "$TARGET"
NEW="$(git rev-parse HEAD)"

if [ "$NEW" = "$PREVIOUS" ] && [ -z "$FORCE" ]; then
  say "already at ${NEW:0:8} — nothing to deploy (FORCE=1 to rebuild and restart anyway)"
  exit 0
fi
if [ "$NEW" = "$PREVIOUS" ]; then
  say "forced redeploy of ${NEW:0:8}  ($(git log -1 --pretty=%s))"
else
  say "deploying ${NEW:0:8}  ($(git log -1 --pretty=%s))"
fi

# --- everything below can fail without touching the running service ----------
build() {
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm test
  pnpm web:build
}

rollback() {
  say "ROLLING BACK to ${PREVIOUS:0:8}"
  git checkout --quiet --detach "$PREVIOUS"
  build || die "rollback build failed — the service is DOWN and needs hands"
  sudo systemctl restart "$SERVICE"
  healthy || die "rolled back but still unhealthy — the service needs hands"
  die "deploy failed; ${PREVIOUS:0:8} is running again"
}

healthy() {
  # /api/auth is the one endpoint that answers without a token, which is exactly
  # what makes it usable as a health check.
  for _ in $(seq 1 "$HEALTH_RETRIES"); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

say "installing, checking, building"
if ! build; then
  say "build or tests failed — the running service was NOT touched"
  git checkout --quiet --detach "$PREVIOUS"
  die "nothing was deployed"
fi

say "restarting ${SERVICE}"
sudo systemctl restart "$SERVICE"

say "waiting for it to answer"
if ! healthy; then rollback; fi

say "deployed ${NEW:0:8} — healthy"
# Leave HEAD attached to a branch so a later `git pull` by hand still works.
git checkout --quiet -B main "$NEW"
