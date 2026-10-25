#!/bin/sh
# Run OpenTofu here with the credentials from the repo's .env, without echoing
# them. State files are created owner-only.
#   infra/tofu.sh init | plan | apply | output
set -eu
here=$(cd "$(dirname "$0")" && pwd)
umask 077
set -a
. "$here/../.env"
set +a
export VULTR_API_KEY="$VULTR_API_TOKEN"
export CLOUDFLARE_API_TOKEN
exec tofu -chdir="$here" "$@"
