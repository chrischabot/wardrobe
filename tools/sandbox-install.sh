#!/usr/bin/env bash
# Fabric sandbox helper (not needed on a normal checkout, where `npm install` is enough).
#
# In the Fabric sandbox every `node_modules` directory inside the project tree is
# redirected by the platform to a build cache outside the tree
# (wardrobe/node_modules -> /var/tmp/czw-build/wardrobe/node_modules). npm cannot
# install workspaces through a symlinked root `node_modules`, and the relative
# workspace links npm creates (node_modules/@garderobe/x -> ../../packages/x) would
# resolve inside the cache instead of the source tree.
#
# This script builds a shadow root in the cache made of symlinks back to the real
# sources, runs `npm install` (or `npm ci`) there, and copies the lockfile back.
# Re-run it whenever a workspace is added or a package.json changes.
#
# Usage: tools/sandbox-install.sh [ci]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
link="$(readlink "$ROOT/node_modules" 2>/dev/null || true)"
if [ -z "$link" ]; then
  echo "node_modules is not redirected here; running plain npm ${1:-install}" >&2
  cd "$ROOT" && exec npm "${1:-install}" --no-audit --no-fund
fi
SHADOW="$(dirname "$link")"
mkdir -p "$SHADOW/node_modules"
for f in package.json package-lock.json tsconfig.base.json .npmrc; do
  [ -e "$ROOT/$f" ] && ln -sfn "$ROOT/$f" "$SHADOW/$f"
done
# package-lock.json must be a real file for npm to rewrite it.
if [ -e "$ROOT/package-lock.json" ]; then rm -f "$SHADOW/package-lock.json"; cp "$ROOT/package-lock.json" "$SHADOW/package-lock.json"; fi
for group in packages apps tests; do
  [ -d "$ROOT/$group" ] || continue
  for ws in "$ROOT/$group"/*/; do
    [ -f "$ws/package.json" ] || continue
    name="$(basename "$ws")"
    mkdir -p "$SHADOW/$group/$name"
    for entry in "$ws"* "$ws".[!.]*; do
      [ -e "$entry" ] || continue
      base="$(basename "$entry")"
      [ "$base" = "node_modules" ] && continue
      ln -sfn "$entry" "$SHADOW/$group/$name/$base"
    done
  done
done
cd "$SHADOW"
npm "${1:-install}" --no-audit --no-fund
cp "$SHADOW/package-lock.json" "$ROOT/package-lock.json"
echo "sandbox install complete: $SHADOW/node_modules"
