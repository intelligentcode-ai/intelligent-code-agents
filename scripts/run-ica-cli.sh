#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_JS="${REPO_ROOT}/dist/src/installer-cli/index.js"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required to run ICA installer CLI." >&2
  exit 1
fi

if [[ ! -f "${CLI_JS}" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: npm is required to build ICA installer CLI." >&2
    exit 1
  fi
  echo "Building ICA installer CLI..."
  (cd "${REPO_ROOT}" && npm install && npm run build:quick)
fi

exec node "${CLI_JS}" "$@"
