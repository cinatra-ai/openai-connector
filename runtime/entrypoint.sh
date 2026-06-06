#!/usr/bin/env bash
set -euo pipefail

export HOME="${HOME:-/home/sandbox}"
export PATH="/usr/local/bin:/usr/bin:/bin"
export TMPDIR="${TMPDIR:-/tmp}"

cd /workspace

exec "$@"
