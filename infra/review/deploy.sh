#!/bin/sh
# Bring the App Review host (deployment/review) up on the review VM (infra/review.tf).
# Confirm with the owner first.
#
#   infra/review/deploy.sh
#
# Copies deployment/review to /opt/review, writes its .env (the domain and the
# page's secret path, which stays in .secrets/review-token) and runs docker
# compose up --build, then prints the page's URL for the review notes. Rerun it
# to update; the container's volume keeps the host key and the paired phones.
# The VM's SSH key is recorded on first contact in infra/review/known_hosts
# (gitignored): delete that file when the VM is replaced.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
host=${DSHR_REVIEW_HOST:-review.dshremote.pentacoxian.dev}
remote() { ssh -o BatchMode=yes -o UserKnownHostsFile="$here/known_hosts" -o StrictHostKeyChecking=accept-new "root@$host" "$@"; }

token_file="$root/.secrets/review-token"
if [ ! -s "$token_file" ]; then
  (umask 077 && openssl rand -base64 24 | tr '+/' '-_' | tr -d '=\n' > "$token_file")
fi
token=$(cat "$token_file")

echo "waiting for $host to finish its first boot"
for _ in $(seq 1 60); do remote true 2>/dev/null && break; sleep 5; done
# A first boot can end degraded (another apt holding the lock skips the upgrade):
# what matters here is Docker.
remote "cloud-init status --wait >/dev/null || true; command -v docker >/dev/null" || { echo "Docker is not installed on $host: see cloud-init status --long there" >&2; exit 1; }

echo "copying deployment/review"
COPYFILE_DISABLE=1 tar --no-xattrs -C "$root/deployment/review" -czf - . | remote "rm -rf /opt/review/src && install -d -m 0700 /opt/review/src && tar -C /opt/review/src -xzf -"
printf 'COMPOSE_PROJECT_NAME=dsh-review\nREVIEW_DOMAIN=%s\nREVIEW_TOKEN=%s\n' "$host" "$token" | remote "umask 077 && cat > /opt/review/src/.env"

echo "building and starting (the first build takes a few minutes)"
remote sh -s <<'REMOTE'
set -eu
cd /opt/review/src
if docker compose version >/dev/null 2>&1; then compose="docker compose"; else compose=docker-compose; fi
$compose up -d --build --quiet-pull >/tmp/review-up.log 2>&1 || { tail -30 /tmp/review-up.log; exit 1; }
$compose ps --format '{{.Service}}: {{.State}}'
REMOTE

url="https://$host/$token/"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "$url" 2>/dev/null && { echo "review page: $url"; exit 0; }
  sleep 5
done
echo "the review page does not answer yet: $url" >&2
exit 1
