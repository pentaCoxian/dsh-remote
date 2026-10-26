#!/bin/sh
# Build the extension's crypto with this test on the Mac and run it against the shared vectors.
set -e
here=$(cd "$(dirname "$0")" && pwd)
out=$(mktemp -d)
swiftc -O "$here/../NotificationService/PushCrypto.swift" "$here/main.swift" -o "$out/push-vectors"
"$out/push-vectors" "$here/../../../../protocol/vectors/push.json"
