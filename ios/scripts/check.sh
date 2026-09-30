#!/usr/bin/env bash
# Everything that can be built and tested for the iOS app without Xcode (Linux or macOS).
# Run from anywhere:  garderobe/ios/scripts/check.sh
# Requires: Swift 6.2+ on PATH, Node 22 and `npm install` done in garderobe/.
set -euo pipefail
IOS="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$IOS/.." && pwd)"
SCRATCH="${GARDEROBE_IOS_SCRATCH:-${TMPDIR:-/tmp}/garderobe-ios}"
OUT="$SCRATCH/contract-out"
rm -rf "$OUT"; mkdir -p "$OUT"

echo "== 1. TypeScript: fixture generator typecheck"
(cd "$ROOT" && npx tsc -p ios/tsconfig.json)

echo "== 2. Fixtures are fresh (owner CSV + profile -> contract-validated JSON)"
(cd "$ROOT" && npx tsx ios/scripts/fixtures.ts verify)

echo "== 3. swift build (GarderobeKit; GarderobeUI compiles empty off iOS)"
(cd "$IOS" && swift build --scratch-path "$SCRATCH/build")

echo "== 4. swift test (unit, journey and adversarial tests on the fixture backend)"
(cd "$IOS" && GARDEROBE_CONTRACT_OUT="$OUT" swift test --scratch-path "$SCRATCH/build")

echo "== 5. Swift-encoded requests and receipts validate against the zod contracts"
(cd "$ROOT" && npx tsx ios/scripts/fixtures.ts check "$OUT")

echo "== 6. Syntax check of the SwiftUI, app and UI-test sources (type-checking needs the iOS 27 SDK)"
(cd "$IOS" && swiftc -parse Sources/GarderobeUI/*.swift App/*.swift UITests/*.swift)

echo "All iOS checks available without Xcode passed."
