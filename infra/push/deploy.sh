#!/bin/sh
# Deploy the push gateway to the relay box (pilot: nrt1). Confirm with the owner first.
#
#   infra/push/deploy.sh
#
# Builds the gateway bundle, installs a pinned Node runtime (sha256-checked) and
# the bundle with its one native dependency (npm ci against a lockfile), copies
# the push credentials named in .env into /etc/dshr-push (root, 0600; never
# printed), installs the hardened unit, restarts it and prints the gateway ticket.
# The gateway's iroh key stays on the box (/var/lib/private/dshr-push); hosts pin
# its id, so keep it (Vultr snapshots) when replacing the instance.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
host=${DSHR_PUSH_HOST:-nrt1.relay.dshremote.pentacoxian.dev}
node_version=24.17.0
node_sha256=ab343a1b747c7cbf3630dfd7dbf818c5423fab2eb4f5ad1afc896f6bd121a917
apns_team_id=KFQ3CFVZ3D
apns_topic=dev.dshremote.dshRemote
remote() { ssh -o BatchMode=yes -o UserKnownHostsFile="$here/known_hosts" -o StrictHostKeyChecking=yes "root@$host" "$@"; }

# Only the push settings are read from .env, never the whole file.
setting() { grep -E "^$1=" "$root/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed -e 's/^["'\'']//' -e 's/["'\'']$//'; }
resolve() { case "$1" in "") ;; /*) echo "$1" ;; *) echo "$root/$1" ;; esac; }
apns_key=$(resolve "$(setting APNS_KEY_FILE)")
apns_key_id=$(setting APNS_KEY_ID)
fcm_account=$(resolve "$(setting FCM_SERVICE_ACCOUNT_FILE)")
[ -z "$apns_key" ] || [ -f "$apns_key" ] || { echo "APNS_KEY_FILE in .env names a missing file" >&2; exit 1; }
[ -z "$fcm_account" ] || [ -f "$fcm_account" ] || { echo "FCM_SERVICE_ACCOUNT_FILE in .env names a missing file" >&2; exit 1; }
[ -z "$apns_key" ] || [ -n "$apns_key_id" ] || { echo "APNS_KEY_ID is not set in .env" >&2; exit 1; }

echo "building the gateway bundle"
(cd "$root" && pnpm --silent --filter @dsh-remote/push-gateway build)
release=$(git -C "$root" rev-parse --short HEAD)$(git -C "$root" diff --quiet HEAD -- packages || echo "-dirty")
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
cp "$root/packages/push-gateway/dist/gateway.mjs" "$stage/"
printf '{\n  "name": "dshr-push",\n  "private": true,\n  "type": "module",\n  "dependencies": { "@number0/iroh": "1.2.0" }\n}\n' > "$stage/package.json"
(cd "$stage" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund --silent)

echo "uploading release $release to $host"
remote "mkdir -p /opt/dshr-push/releases/$release"
tar -C "$stage" -cf - gateway.mjs package.json package-lock.json | remote "tar -C /opt/dshr-push/releases/$release -xf -"

echo "copying credentials (not printed)"
remote "install -d -m 0700 /etc/dshr-push /etc/systemd/system/dshr-push.service.d"
credentials="[Service]"
if [ -n "$apns_key" ]; then
  remote "umask 077 && cat > /etc/dshr-push/apns.p8" < "$apns_key"
  credentials="$credentials
LoadCredential=apns.p8:/etc/dshr-push/apns.p8"
fi
if [ -n "$fcm_account" ]; then
  remote "umask 077 && cat > /etc/dshr-push/fcm.json" < "$fcm_account"
  credentials="$credentials
LoadCredential=fcm.json:/etc/dshr-push/fcm.json"
fi
printf 'APNS_KEY_ID=%s\nAPNS_TEAM_ID=%s\nAPNS_TOPIC=%s\n' "$apns_key_id" "$apns_team_id" "$apns_topic" | remote "umask 077 && cat > /etc/dshr-push/env"
printf '%s\n' "$credentials" | remote "cat > /etc/systemd/system/dshr-push.service.d/credentials.conf"
remote "cat > /etc/systemd/system/dshr-push.service" < "$here/dshr-push.service"

echo "installing Node $node_version and the release"
remote sh -s "$node_version" "$node_sha256" "$release" <<'REMOTE'
set -eu
version=$1 sha=$2 release=$3
if [ "$(/opt/node/bin/node --version 2>/dev/null)" != "v$version" ]; then
  curl -fsSL --retry 3 -o /tmp/node.tar.xz "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.xz"
  echo "$sha  /tmp/node.tar.xz" | sha256sum -c - >/dev/null
  mkdir -p "/opt/node-$version"
  tar -C "/opt/node-$version" --strip-components=1 -xJf /tmp/node.tar.xz
  rm /tmp/node.tar.xz
  ln -sfn "/opt/node-$version" /opt/node
fi
cd "/opt/dshr-push/releases/$release"
PATH=/opt/node/bin:$PATH npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent
ln -sfn "/opt/dshr-push/releases/$release" /opt/dshr-push/current
systemctl daemon-reload
systemctl enable --quiet dshr-push
systemctl restart dshr-push
for _ in $(seq 1 30); do
  journalctl -u dshr-push --since "-2min" -o cat | grep -q "push-gateway: ticket" && break
  sleep 1
done
journalctl -u dshr-push --since "-2min" -o cat | grep "push-gateway:" | tail -2
REMOTE
