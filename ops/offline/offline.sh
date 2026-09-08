#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
dc() {
  local args=(-p wireless-canvas -f compose.json)
  if test -f compose.local.yml; then args+=(-f compose.local.yml); fi
  docker compose "${args[@]}" "$@"
}
verify() { sha256sum --check SHA256SUMS; }
case "${1:-help}" in
  verify) verify ;;
  init)
    verify
    if test -e .env; then echo '.env already exists; preserved'; else
      (umask 077; cp .env.example .env)
      echo 'Created .env. Edit passwords, encryption key and deployment settings before starting.'
    fi
    ;;
  load)
    verify
    test "$(uname -m)" = x86_64 || { echo 'Requires x86_64'; exit 1; }
    docker image load -i images.tar.gz
    while IFS= read -r ref; do
      test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$ref")" = linux/amd64
    done < images.txt
    ;;
  up)
    verify
    test -f .env || { echo 'Run init and edit .env first'; exit 1; }
    # First-install helper cannot silently recreate an existing project.
    test -z "$(dc ps -aq)" || { echo 'Existing containers found. Follow the manual upgrade procedure; nothing restarted.'; exit 1; }
    dc config --quiet
    dc run --rm --no-deps --pull never -v "$PWD:/workspace:ro" -w /workspace \
      api bun ops/preflight/production-preflight.ts
    dc up -d --no-build --pull never
    dc ps -a
    echo 'Started. Check service health, HTTPS login and business flow per INSTALL.md.'
    ;;
  status) dc ps -a ;;
  *) echo 'Usage: bash offline.sh {verify|init|load|up|status}'; exit 2 ;;
esac
