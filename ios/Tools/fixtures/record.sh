#!/usr/bin/env bash
# Re-records the fixture cassettes from the real Worker (workerd, local D1, real owner import).
# Run from anywhere; needs the repository's node_modules (npm install, or tools/sandbox-install.sh).
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$root"
npx vitest run --config ios/Tools/fixtures/vitest.config.ts record -u
node --experimental-strip-types ios/Tools/contract-check/validate.mjs fixtures ios/GarderobeKit/Sources/GarderobeKit/Resources/Fixtures
