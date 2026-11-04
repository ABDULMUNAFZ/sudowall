#!/usr/bin/env bash
# Checks the packed sudowall tarball on a real Node.js below 24.11 (the `engines` floor):
# npm installs it with an EBADENGINE warning, and `sudowall` must print the upgrade message on
# stderr, print nothing on stdout, and exit 1, before it loads anything else.
#
# Usage: scripts/check-old-node.sh <sudowall-x.y.z.tgz>
# Run it with the old Node.js first on PATH (CI: actions/setup-node with node-version 24.10.0).
set -euo pipefail

tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
version="$(node --version)"
case "$version" in
  v24.[0-9].* | v24.10.*) ;;
  *)
    echo "check-old-node: needs a Node.js 24 below 24.11 on PATH, found $version" >&2
    exit 2
    ;;
esac

dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
cd "$dir"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$tarball" >/dev/null

set +e
./node_modules/.bin/sudowall --version >stdout.txt 2>stderr.txt
code=$?
set -e

expected="SudoWall needs Node.js 24.11 or newer (you have $version). Update Node and run it again."
ok=1
[ "$code" -eq 1 ] || { echo "exit code $code, expected 1" >&2; ok=0; }
[ ! -s stdout.txt ] || { echo "unexpected stdout: $(cat stdout.txt)" >&2; ok=0; }
[ "$(cat stderr.txt)" = "$expected" ] || { echo "stderr was: $(cat stderr.txt)" >&2; ok=0; }
if [ "$ok" -eq 1 ]; then
  echo "ok: Node.js $version: '$expected', exit 1"
else
  exit 1
fi
