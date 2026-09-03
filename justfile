# AdScout task runner.  `just` on its own lists everything.
#
# The one you want is `just release`: it gates locally, pushes, watches the
# GitHub Actions run through the deploy, and verifies the live site answers.
# One command, one answer.
#
# Setup (one time, both ends): docs/RELEASE-SETUP.md

set shell := ["bash", "-euo", "pipefail", "-c"]

HOST := env_var_or_default("ADSCOUT_HOST", "adscout.dva-lymona.biz.ua")
USER := env_var_or_default("ADSCOUT_USER", "adscout")
APP  := env_var_or_default("ADSCOUT_DIR",  "/opt/adscout")

# List the recipes
default:
    @just --list --unsorted

# ---------------------------------------------------------------- local dev --

# Install the whole workspace (server + web)
install:
    pnpm install

# Everything CI checks — run it before you push
check:
    pnpm typecheck
    pnpm web:typecheck
    pnpm test

# Build the front end into web/dist
build:
    pnpm web:build

# API on :8787 and Vite on :5173, together
dev:
    pnpm dev:all

# Dump the local store to ./data-dump (stop the server first — single writer)
dump out="./data-dump":
    pnpm data:dump --out {{out}}

# ------------------------------------------------------------------ release --

# Gate, push, watch the deploy, verify the live site
release:
    #!/usr/bin/env bash
    set -euo pipefail
    say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
    die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    [ "$BRANCH" = "main" ] || die "release runs from main; you are on '$BRANCH'."

    git diff --quiet && git diff --cached --quiet \
      || die "working tree is dirty. Commit or stash first."

    say "fetching"
    git fetch --quiet origin main

    BEHIND="$(git rev-list --count HEAD..origin/main)"
    [ "$BEHIND" = "0" ] || die "behind origin/main by $BEHIND commit(s). Pull or rebase first."

    AHEAD="$(git rev-list --count origin/main..HEAD)"
    if [ "$AHEAD" = "0" ]; then
      say "nothing to push"
      echo "  To redeploy the revision already on main:  just redeploy"
      exit 0
    fi

    say "releasing $AHEAD commit(s)"
    git --no-pager log --oneline origin/main..HEAD

    # Locally first, so a bad revision costs 10 seconds instead of a failed run
    # in the history and a rollback on the box.
    say "checking"
    pnpm typecheck
    pnpm web:typecheck
    pnpm test
    pnpm web:build

    say "pushing"
    git push origin main
    SHA="$(git rev-parse HEAD)"

    say "waiting for the workflow to appear"
    RUN=""
    for _ in $(seq 1 40); do
      RUN="$(gh run list -c "$SHA" -L 1 --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null || true)"
      [ -n "$RUN" ] && break
      sleep 3
    done
    [ -n "$RUN" ] || die "no workflow run appeared for ${SHA:0:8}. Check GitHub Actions; the push succeeded."

    say "watching run $RUN"
    gh run watch "$RUN" --exit-status --compact

    # The workflow's own deploy step health-checks over loopback. This proves it
    # from outside, through nginx and TLS — which is how anyone actually reaches it.
    say "verifying https://{{HOST}}"
    curl -fsS --max-time 10 "https://{{HOST}}/api/auth"
    echo
    say "released ${SHA:0:8}"

# Redeploy the revision already on main, without pushing anything
redeploy:
    #!/usr/bin/env bash
    set -euo pipefail
    gh workflow run deploy.yml --ref main
    echo "==> dispatched; waiting for the run"
    sleep 6
    RUN="$(gh run list -w deploy.yml -L 1 --json databaseId --jq '.[0].databaseId')"
    gh run watch "$RUN" --exit-status --compact

# Deploy straight over SSH, bypassing CI (for when Actions is down)
deploy-ssh:
    ssh -t {{USER}}@{{HOST}} 'APP_DIR={{APP}} {{APP}}/deploy/deploy.sh'

# Restart only — the right tool after editing .env on the box (read at boot)
restart:
    #!/usr/bin/env bash
    set -euo pipefail
    ssh {{USER}}@{{HOST}} 'sudo systemctl restart adscout'
    echo "==> restarted; waiting for it to answer"
    for _ in $(seq 1 30); do
      if curl -fsS --max-time 3 "https://{{HOST}}/api/auth" >/dev/null; then
        echo "healthy"; exit 0
      fi
      sleep 1
    done
    echo "did NOT come back within 30s — just logs" >&2; exit 1

# Watch the most recent workflow run
ci:
    gh run watch "$(gh run list -L 1 --json databaseId --jq '.[0].databaseId')" --exit-status --compact

# ------------------------------------------------------------------- the box --

# Service state, timezone, and whether the API is gated as it should be
status:
    #!/usr/bin/env bash
    set -uo pipefail
    ssh {{USER}}@{{HOST}} 'systemctl is-active adscout; systemctl show adscout -p ActiveEnterTimestamp --value'
    echo "--- what the ports are bound to (want 127.0.0.1, not 0.0.0.0) ---"
    ssh {{USER}}@{{HOST}} "ss -ltn | grep -E '8787|8788' || echo '  (ss unavailable)'"
    echo "--- public endpoints ---"
    printf '  /api/auth   -> %s\n' "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://{{HOST}}/api/auth)"
    printf '  /api/status -> %s  (401 is CORRECT — it means auth is on)\n' \
      "$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 https://{{HOST}}/api/status)"

# Follow the live log
logs:
    ssh -t {{USER}}@{{HOST}} 'journalctl -u adscout -f -n 100'

# The boot lines that tell you the box is configured correctly
boot-log:
    ssh {{USER}}@{{HOST}} "journalctl -u adscout -n 400 --no-pager | grep -E 'clock |authentication|backup|hub|reconcile' | tail -15"

# What backups exist on the box, newest last
backups:
    ssh {{USER}}@{{HOST}} 'ls -lh {{APP}}/backups/ | tail -20'

# Copy the newest backup here, for a local restore drill
fetch-backup dest="./":
    #!/usr/bin/env bash
    set -euo pipefail
    NEWEST="$(ssh {{USER}}@{{HOST}} 'ls -1 {{APP}}/backups/*.tar.gz | tail -1')"
    echo "==> $NEWEST"
    scp {{USER}}@{{HOST}}:"$NEWEST" {{dest}}
