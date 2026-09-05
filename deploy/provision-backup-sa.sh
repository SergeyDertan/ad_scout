#!/usr/bin/env bash
#
# Provision the Google service account the hourly backup mirror uses, scoped to
# one bucket and nothing else.
#
#     ./deploy/provision-backup-sa.sh
#     BUCKET=postwormhole.firebasestorage.app ./deploy/provision-backup-sa.sh
#
# WHY NOT THE FIREBASE KEY: Firebase Console → Service accounts → "Generate new
# private key" hands you the Admin SDK account, which normally carries Editor on
# the whole project — Auth, every bucket, everything. The mirror calls exactly
# three verbs (upload, list, delete objects), so it gets exactly those, on one
# bucket. See src/services/backup.ts:297-312.
#
# WHAT THE KEY IS WORTH: the archives hold every mailbox's OAuth refresh token in
# clear text. Bucket permissions are the only thing between a leak and five Gmail
# accounts. Treat the JSON this prints as mailbox credentials.
#
# Idempotent: existing account, bucket and binding are left alone. It will NOT
# overwrite an existing key file — a second key is a second thing to leak, so
# deleting the old one is a decision you make, not one this script makes for you.

set -euo pipefail

PROJECT="${PROJECT:-postwormhole}"
SA="${SA:-adscout-backup}"
BUCKET="${BUCKET:-adscout-backups}"
LOCATION="${LOCATION:-EU}"
KEY_FILE="${KEY_FILE:-./adscout-backup.json}"

EMAIL="${SA}@${PROJECT}.iam.gserviceaccount.com"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33m    %s\033[0m\n' "$*"; }
die()  { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud is not installed."
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || die "no active gcloud account — run: gcloud auth login"

say "project ${PROJECT}"
gcloud config set project "$PROJECT" >/dev/null

# --- 1. the service account, with no project roles ---------------------------
if gcloud iam service-accounts describe "$EMAIL" >/dev/null 2>&1; then
  say "service account ${SA} already exists — leaving it alone"
else
  say "creating service account ${SA}"
  gcloud iam service-accounts create "$SA" \
    --display-name="AdScout backup mirror" \
    --description="Uploads and prunes hourly database archives. Storage only."
fi

# --- 2. the bucket -----------------------------------------------------------
# Public access prevention and uniform access are set at creation so there is no
# window where the bucket exists and is not locked down.
if gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  say "bucket gs://${BUCKET} already exists — leaving its settings alone"
else
  say "creating bucket gs://${BUCKET} (${LOCATION})"
  if ! gcloud storage buckets create "gs://${BUCKET}" \
        --location="$LOCATION" \
        --uniform-bucket-level-access \
        --public-access-prevention; then
    warn "could not create the bucket."
    warn "The usual cause is a project on the Firebase Spark (free) plan, which"
    warn "cannot create new buckets. Re-run against the existing default bucket:"
    warn ""
    warn "    BUCKET=${PROJECT}.firebasestorage.app $0"
    warn ""
    warn "That works — storage.rules denies browser reads across the whole"
    warn "bucket — but the archives then sit beside whatever else uses it."
    die "bucket creation failed"
  fi

  # Versioning, so a compromised key that deletes an archive does not destroy
  # the history. NOT a locked retention policy: the mirror prunes on purpose
  # (today hourly, one per past day, nothing past BACKUP_KEEP_DAYS), and a lock
  # would make every prune fail while the local copy silently diverged.
  say "enabling object versioning"
  gcloud storage buckets update "gs://${BUCKET}" --versioning
fi

# --- 3. the only grant -------------------------------------------------------
say "granting roles/storage.objectAdmin on gs://${BUCKET} only"
gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${EMAIL}" \
  --role="roles/storage.objectAdmin" >/dev/null

# --- 4. prove it is actually narrow ------------------------------------------
say "checking for project-level roles (want: none)"
ROLES="$(gcloud projects get-iam-policy "$PROJECT" \
  --flatten='bindings[].members' \
  --filter="bindings.members:${EMAIL}" \
  --format='value(bindings.role)' || true)"
if [ -n "$ROLES" ]; then
  warn "this account ALSO holds project-level roles:"
  printf '      %s\n' $ROLES
  warn "That is broader than the mirror needs. Remove them with:"
  warn "  gcloud projects remove-iam-policy-binding ${PROJECT} \\"
  warn "    --member=serviceAccount:${EMAIL} --role=<role>"
else
  echo "    none — it can touch objects in gs://${BUCKET} and nothing else"
fi

# --- 5. the key --------------------------------------------------------------
if [ -e "$KEY_FILE" ]; then
  say "${KEY_FILE} already exists — not creating a second key"
  warn "Every key is another thing that can leak. To rotate deliberately:"
  warn "  gcloud iam service-accounts keys list --iam-account=${EMAIL}"
  warn "  gcloud iam service-accounts keys delete <KEY_ID> --iam-account=${EMAIL}"
else
  say "creating key ${KEY_FILE}"
  gcloud iam service-accounts keys create "$KEY_FILE" --iam-account="$EMAIL"
  chmod 600 "$KEY_FILE"
fi

cat <<EOF

$(printf '\033[1m==> done\033[0m')

Install it on the VPS:

    scp -i ~/.ssh/adscout-deploy -o IdentitiesOnly=yes \\
      ${KEY_FILE} adscout@<vps>:/opt/adscout/firebase-service-account.json

then on the box:

    sudo chown adscout:adscout /opt/adscout/firebase-service-account.json
    sudo chmod 600 /opt/adscout/firebase-service-account.json

add to /opt/adscout/.env:

    BACKUP_BUCKET=${BUCKET}
    BACKUP_CREDENTIALS=./firebase-service-account.json

and restart:

    sudo systemctl restart adscout
    journalctl -u adscout -n 40 --no-pager | grep -i backup

The boot line should stop saying  mirror: 'none (local only)'.

EOF
