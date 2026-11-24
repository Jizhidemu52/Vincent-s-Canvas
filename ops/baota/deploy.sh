#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
root=$(cd -- "$(dirname -- "$0")" && pwd -P)
case "${1:-}" in
  doctor) shift; exec python3 -B "$root/doctor.py" "$@" ;;
  plan|apply|render-proxy) exec python3 -B "$root/release.py" "$@" ;;
  *) printf '用法：bash ops/baota/deploy.sh {doctor|plan|apply|render-proxy} --help\n' >&2; exit 2 ;;
esac
