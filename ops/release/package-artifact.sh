#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
[[ $# == 3 ]] || { echo 'Usage: package-artifact.sh <candidate.json> <verification.json> <new-absolute-package-directory>' >&2; exit 2; }
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
candidate=$(realpath -- "$1"); verification=$(realpath -- "$2"); output=$3
[[ "$output" == /* && ! -e "$output" && ! -e "${output}.tar" && ! -e "${output}.images.tar.gz" ]]
field() { python3 "$repo/ops/release/artifact.py" field "$candidate" "$1"; }
api=$(field images.api.reference); web=$(field images.web.reference)
[[ "$(docker image inspect -f '{{.Id}}' "$api")" == "$(field images.api.id)" ]]
[[ "$(docker image inspect -f '{{.Id}}' "$web")" == "$(field images.web.id)" ]]
# Export these exact local IDs after smoke. No source build, pull or new tag.
docker image save "$api" "$web" | gzip -1 > "${output}.images.tar.gz"
python3 "$repo/ops/release/artifact.py" package --repository "$repo" --candidate "$candidate" --verification "$verification" --images "${output}.images.tar.gz" --output "$output"
[[ "$(docker image inspect -f '{{.Id}}' "$api")" == "$(field images.api.id)" && "$(docker image inspect -f '{{.Id}}' "$web")" == "$(field images.web.id)" ]]
