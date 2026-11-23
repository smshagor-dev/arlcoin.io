#!/usr/bin/env bash
# One command: install pinned dependencies, compile local contracts, and run
# the local-only receipt-signing and metering-vote demonstration on Anvil.
# The metering readings in this chain test are SYNTHETIC, not Docker metrics.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for tool in npm node forge anvil; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$tool" >&2
    exit 1
  fi
done

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 18)) process.exit(1);' || {
  echo "Node.js 22.18+ is required" >&2
  exit 1
}

# A clean install ensures the viem and TypeScript versions match the lockfile.
npm ci
(
  cd contracts
  forge build --skip test --skip script
)
node --test packages/verifier/test-anvil/metering.anvil.test.ts
