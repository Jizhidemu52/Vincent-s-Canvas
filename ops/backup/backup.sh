#!/usr/bin/env bash
set -euo pipefail

exec "${PYTHON_BIN:-python3}" "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/archive.py" backup "$@"
