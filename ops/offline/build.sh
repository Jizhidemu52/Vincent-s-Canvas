#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
test "$(uname -m)" = x86_64 || { echo 'Build on Linux x86_64'; exit 1; }
revision=$(git rev-parse HEAD)
out=${1:?Usage: bash ops/offline/build.sh NEW_ABSOLUTE_OUTPUT_DIRECTORY}
[[ "$out" = /* ]] || { echo 'Output must be an absolute new directory'; exit 1; }
bun test ops/offline/compose.test.ts
bun ops/offline/prepare.ts "$revision" "$out"
docker build --platform linux/amd64 -t "wireless-canvas-web:$revision" -f Dockerfile .
docker build --platform linux/amd64 -t "wireless-canvas-server:$revision" -f server/Dockerfile .
docker build --platform linux/amd64 -t "wireless-canvas-backup:$revision" -f ops/backup/Dockerfile .
mapfile -t images < "$out/images.txt"
for ref in "${images[@]}"; do
  case "$ref" in wireless-canvas-*) ;; *) docker pull --platform linux/amd64 "$ref" ;; esac
  test "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$ref")" = linux/amd64
done
docker image inspect "${images[@]}" > "$out/image-manifest.json"
docker image save "${images[@]}" | gzip -1 > "$out/images.tar.gz"
(
  cd "$out"
  # Fixed allowlist: never include .env, local data, logs or arbitrary workspace files.
  sha256sum compose.json images.txt REVISION .env.example offline.sh INSTALL.md \
    ops/preflight/production-preflight.ts server/src/production-readiness.ts \
    image-manifest.json images.tar.gz > SHA256SUMS
)
archive="${out}.tar"
test ! -e "$archive" || { echo 'Archive already exists'; exit 1; }
tar -C "$(dirname "$out")" -cf "$archive" "$(basename "$out")"
(cd "$(dirname "$archive")"; sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256")
echo "Offline package: $archive"
