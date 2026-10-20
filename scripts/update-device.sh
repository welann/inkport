#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
pnpm build:embedded
exec ./scripts/patch-device.sh --install --replace
