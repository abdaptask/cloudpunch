#!/usr/bin/env bash
# Deploy the committed HEAD to the pilot VM (ADR-0019) and restart the API.
#
#   scripts/deploy-pilot.sh            # deploy HEAD
#   PILOT_HOST=aptask@host scripts/deploy-pilot.sh
#
# Ships `git archive HEAD` over SSH (no Git credentials on the VM),
# installs the backend's dependencies from the lockfile, swaps the app
# directory (keeping the previous one for rollback), restarts
# cloudpunch-api and checks it answers. Run migrations separately.
set -euo pipefail

HOST="${PILOT_HOST:-aptask@172.16.46.54}"

if [ -n "$(git status --porcelain)" ]; then
  echo "deploy-pilot: commit or stash your changes first (deploys HEAD only)" >&2
  exit 1
fi

REV="$(git rev-parse --short HEAD)"
echo "deploy-pilot: deploying $REV to $HOST"

# The archive goes on stdin, so the remote script travels as an argument.
read -r -d '' REMOTE <<'REMOTE' || true
set -euo pipefail
sudo rm -rf /opt/cloudpunch/app.new && sudo mkdir -p /opt/cloudpunch/app.new
sudo tar -x -C /opt/cloudpunch/app.new
cd /opt/cloudpunch/app.new
sudo COREPACK_HOME=/opt/corepack pnpm install --frozen-lockfile \
  --store-dir /opt/cloudpunch/.pnpm-store --filter @cloudpunch/backend...   --filter @cloudpunch/web... >/dev/null
# The web dashboard (ADR-0033), served by the API from apps/web/dist.
sudo COREPACK_HOME=/opt/corepack pnpm --filter @cloudpunch/web build >/dev/null
echo "$REV" | sudo tee /opt/cloudpunch/app.new/REVISION >/dev/null
sudo rm -rf /opt/cloudpunch/app.prev
if [ -d /opt/cloudpunch/app ]; then sudo mv /opt/cloudpunch/app /opt/cloudpunch/app.prev; fi
sudo mv /opt/cloudpunch/app.new /opt/cloudpunch/app
sudo chown -R root:root /opt/cloudpunch/app && sudo chmod -R a+rX,go-w /opt/cloudpunch/app
sudo systemctl restart cloudpunch-api
for _ in $(seq 1 20); do
  if curl -fs -o /dev/null http://127.0.0.1:8080/livez; then
    echo "deploy-pilot: $REV is live"
    exit 0
  fi
  sleep 1
done
echo "deploy-pilot: API did not come up; rolling back" >&2
sudo rm -rf /opt/cloudpunch/app && sudo mv /opt/cloudpunch/app.prev /opt/cloudpunch/app
sudo systemctl restart cloudpunch-api
exit 1
REMOTE

git archive --format=tar HEAD |
  ssh -o BatchMode=yes "$HOST" "REV=$REV bash -c $(printf '%q' "$REMOTE")"
