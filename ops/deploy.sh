#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=$(cd -- "$(dirname -- "$0")" && pwd -P)
exec python3 -B "$root/release/deploy.py" "$@"
