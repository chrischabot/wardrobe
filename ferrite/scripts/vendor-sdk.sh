#!/bin/sh
# Restores vendor/ (the local ferrite-app twin, Forge and the test harness),
# which is not committed. It is the copy `ferrite new` writes, taken from the
# installed CLI, and it must be the twin ferrite-twin.json records.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
command -v ferrite >/dev/null || { echo "ferrite CLI not found on PATH (see README.md)" >&2; exit 1; }
want=$(sed -n 's/.*"digest": "\(sha256:[0-9a-f]*\)".*/\1/p' "$here/ferrite-twin.json")
have=$(ferrite --version | sed -n 's/^sdk-twin: \(sha256:[0-9a-f]*\).*/\1/p')
if [ "$want" != "$have" ]; then
  echo "this CLI carries SDK twin $have, but ferrite-twin.json records $want; install CLI 0.1.20 or update the record deliberately" >&2
  exit 1
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$tmp" && ferrite new hello wardrobe --with-tests >/dev/null)
rm -rf "$here/vendor"
cp -R "$tmp/wardrobe/vendor" "$here/vendor"
echo "vendor/ restored from SDK twin $have"
