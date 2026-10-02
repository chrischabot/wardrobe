#!/usr/bin/env bash
# Runs every check of the iOS client that can run without a Mac, in order, and stops at the first
# failure. Run from anywhere:  bash ios/Tools/check.sh
#
# Needs: a Swift toolchain (swift.org, 6.0 or later) on PATH or in SWIFT_BIN, Node 22+, Python 3,
# and the repository's node_modules (npm install, or tools/sandbox-install.sh).
#
# What this does NOT do: it does not compile the SwiftUI app, run it in a simulator or on a device,
# or run the UI tests. Those need Xcode; see ios/README.md, "Remaining checks on a Mac".
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
if [ -n "${SWIFT_BIN:-}" ]; then export PATH="$SWIFT_BIN:$PATH"; fi
scratch="${GARDEROBE_SWIFT_SCRATCH:-$root/ios/GarderobeKit/.build}"
node_ts="node --experimental-strip-types --disable-warning=ExperimentalWarning"
fixtures="ios/GarderobeKit/Sources/GarderobeKit/Resources/Fixtures"

step() { printf '\n== %s\n' "$1"; }

step "1/9 toolchain"
swift --version | head -1
node --version

step "2/9 Swift contracts are the generator's output for the live schemas"
$node_ts ios/Tools/sync-contracts.mjs --check

step "3/9 fixtures: recorded from the current owner profile and inventory; every recorded answer parses with its response schema"
$node_ts ios/Tools/contract-check/validate.mjs fixtures "$fixtures"

step "4/9 swift build (GarderobeKit, contract dump)"
(cd ios/GarderobeKit && swift build --scratch-path "$scratch")

step "5/9 swift test (unit tests and journeys replaying the real Worker's recordings)"
(cd ios/GarderobeKit && swift test --scratch-path "$scratch")

step "6/9 requests the Swift client sends validate against the shared zod schemas"
requests="$(mktemp "${TMPDIR:-/tmp}/garderobe-requests.XXXXXX")"
(cd ios/GarderobeKit && swift run --scratch-path "$scratch" garderobe-contract-dump) > "$requests"
$node_ts ios/Tools/contract-check/validate.mjs requests "$requests"
rm -f "$requests"

step "7/9 Xcode project: generated file is current and structurally sound (not opened or built in Xcode)"
python3 ios/Tools/generate-xcodeproj.py --check
python3 ios/Tools/check-xcodeproj.py | tail -1

step "8/9 SwiftUI, share extension and UI-test sources: syntax parse only (no type check is possible without the iOS SDK)"
count=0
while IFS= read -r file; do
  swiftc -frontend -parse "$file"
  count=$((count + 1))
done < <(find ios/App -name '*.swift' | sort)
echo "parsed $count files"

step "9/9 static rules for the app sources"
python3 ios/Tools/check-app-sources.py

printf '\nAll checks that can run without a Mac passed. This script does not build or run the app: .github/workflows/ios.yml does that on macOS, and ios/README.md states its latest result, including any failing UI test.\n'
