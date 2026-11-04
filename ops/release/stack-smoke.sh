#!/usr/bin/env bash
# The candidate API/Web image IDs are already built. Only disposable test
# infrastructure may be built here; no production environment is read.
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
[[ $# == 2 ]] || { echo 'Usage: stack-smoke.sh <candidate.json> <new-absolute-evidence-directory>' >&2; exit 2; }
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
candidate=$(realpath -- "$1")
work=$2
[[ "$work" == /* && ! -e "$work" && "$work" != / && -n ${GITHUB_RUN_ID:-} && ${GITHUB_RUN_ID} =~ ^[0-9]+$ ]] || { echo CI_ONLY_NEW_EVIDENCE_REQUIRED >&2; exit 1; }
mkdir -m 700 -- "$work"
field() { python3 "$repo/ops/release/artifact.py" field "$candidate" "$1"; }
commit=$(field commit); platform=$(field platform); architecture=${platform#linux/}
project="ci-release-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}-$architecture"
api_image=$(field images.api.reference); web_image=$(field images.web.reference)
api_id=$(field images.api.id); web_id=$(field images.web.id)
[[ -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]]
[[ -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")" ]]
docker image inspect "$api_image" > "$work/api-image.json"
docker image inspect "$web_image" > "$work/web-image.json"
[[ "$(docker image inspect -f '{{.Id}}' "$api_image")" == "$api_id" && "$(docker image inspect -f '{{.Id}}' "$web_image")" == "$web_id" ]]
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
python3 - "$work/test.env" <<'PY'
import base64,os,secrets,sys
values={
 'POSTGRES_PASSWORD':secrets.token_hex(24),'NODE_ENV':'production','PORT':'3100','HOST':'0.0.0.0',
 'SESSION_COOKIE_NAME':'canvas_ci_session','SESSION_TTL_SECONDS':'28800','TRUST_PROXY':'true',
 'PROVIDER_ENCRYPTION_KEY':base64.b64encode(secrets.token_bytes(32)).decode(),
 'WORKER_CONCURRENCY':'4','WORKER_SHUTDOWN_GRACE_SECONDS':'120','TASK_MOCK_MODE':'false',
 'AUTH_ENABLED':'true','OA_LOGIN_ENABLED':'false','CREDITS_ENABLED':'true','ROLE_PORTALS_ENABLED':'true',
 'S3_ENDPOINT':'http://minio:9000','S3_PUBLIC_ENDPOINT':'','S3_REGION':'us-east-1','S3_BUCKET':'canvas-ci',
 'S3_ACCESS_KEY_ID':'canvas-ci','S3_SECRET_ACCESS_KEY':secrets.token_hex(24),'S3_FORCE_PATH_STYLE':'true',
}
fd=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as out:
 for key,value in values.items():out.write(f'{key}={value}\n')
PY
bun --no-env-file "$repo/ops/release/ci-compose.mjs" "$repo" "$project" "$commit" "$api_image" "$web_image" "$work/test.env" "$port" "$work/compose.json"
dc() { docker compose -p "$project" --project-directory "$repo" --env-file "$work/test.env" -f "$work/compose.json" "$@"; }
cleanup() {
  local result=$? ids volume
  trap - EXIT
  # Record only these disposable services. Never use a global prune/stop list.
  dc ps -a > "$work/compose-final.txt" 2>&1 || true
  dc logs --no-color --tail=100 > "$work/compose.private.log" 2>&1 || true
  while IFS= read -r volume; do
    [[ -z "$volume" ]] && continue
    [[ "$(docker volume inspect -f '{{index .Labels "com.docker.compose.project"}}' "$volume")" == "$project" ]] || { echo CI_VOLUME_IDENTITY_MISMATCH >&2; exit 1; }
  done < <(docker volume ls -q --filter "label=com.docker.compose.project=$project")
  dc down --volumes --remove-orphans > "$work/cleanup.private.log" 2>&1 || result=1
  exit "$result"
}
trap cleanup EXIT
dc config --quiet
# API/Web are immutable supplied images. Build infrastructure only for this
# disposable stack; application deployment never calls docker build or pull.
dc build minio minio-init backup > "$work/infra-build.private.log" 2>&1
dc pull postgres redis > "$work/infra-pull.private.log" 2>&1
dc up -d --no-build --pull never --wait --wait-timeout 120 postgres redis minio
mc_image=$(dc config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["services"]["minio-init"]["image"])')
docker image inspect "$mc_image" > "$work/minio-init-image.json"
dc run --rm --no-deps --pull never minio-init > "$work/minio-init.private.log" 2>&1
dc run --rm --no-deps --pull never api bun src/migrate.ts > "$work/migration.private.log" 2>&1
# The bounded E2E seed creates only its fixture identities; no ordinary bootstrap.
dc up -d --no-deps --no-build --pull never --wait --wait-timeout 180 api worker web mock-provider
docker inspect "$(dc ps -q postgres)" "$(dc ps -q redis)" "$(dc ps -q minio)" > "$work/infra-containers.private.json"
python3 - "$work" "$commit" "$project" "$platform" <<'PY'
import json,re,sys
from pathlib import Path
work,commit,project,platform=Path(sys.argv[1]),*sys.argv[2:]
image_ids={}
for row in json.loads((work/'infra-containers.private.json').read_text()):
 labels=row['Config']['Labels']; service=labels['com.docker.compose.service']
 assert labels['com.docker.compose.project']==project and service in ('postgres','redis','minio')
 assert row['State']['Running'] is True and service not in image_ids
 image_ids[service]=row['Image']
mc,=json.loads((work/'minio-init-image.json').read_text())
image_ids['minio-init']=mc['Id']
assert set(image_ids)=={'postgres','redis','minio','minio-init'}
assert all(re.fullmatch(r'sha256:[a-f0-9]{64}',value) for value in image_ids.values())
with (work/'infra-images.json').open('x') as output:
 json.dump({'schema':1,'commit':commit,'project':project,'platform':platform,'imageIds':image_ids},output,sort_keys=True)
 output.write('\n')
PY
[[ "$(docker image inspect -f '{{.Id}}' "$mc_image")" == "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageIds"]["minio-init"])' "$work/infra-images.json")" ]]
dc exec -T api sh -ec 'bun --version; node -e '\''const [a,b]=process.versions.node.split(".").map(Number); if(process.versions.bun||!((a===22&&b>=21)||(a===24&&b>=5)||a>=25))process.exit(1)'\''; ffmpeg -version; ffprobe -version' > "$work/runtime.private.log" 2>&1
dc exec -T worker bun src/worker-healthcheck.ts > "$work/worker-health.private.log" 2>&1
curl --disable --noproxy '*' --retry 0 --fail --silent --show-error --max-time 10 "http://127.0.0.1:$port/api/health" > "$work/health.json"
curl --disable --noproxy '*' --retry 0 --fail --silent --show-error --max-time 10 "http://127.0.0.1:$port/deployment-release.json" > "$work/marker.json"
dc exec -T postgres psql -X -qAt -v ON_ERROR_STOP=1 -U wireless_canvas -d wireless_canvas < "$repo/ops/release/database-state.sql" > "$work/database-state.private.json"
python3 - "$work/database-state.private.json" <<'PY'
import json,sys
state=json.load(open(sys.argv[1]))
assert state['identity']['database']=='wireless_canvas' and state['tables'] and state['migrations']
assert all(isinstance(row['count'],int) and len(row['sha256'])==64 for row in state['tables'])
PY
python3 - "$work/marker.json" "$candidate" <<'PY'
import json,sys
marker=json.load(open(sys.argv[1])); candidate=json.load(open(sys.argv[2]))
assert marker=={'schema':1,'version':candidate['version'],'commit':candidate['commit']}
PY
[[ -f "$repo/ops/release/browser-smoke.sh" && ! -L "$repo/ops/release/browser-smoke.sh" ]] || { echo REQUIRED_PRODUCTION_BROWSER_SMOKE_MISSING >&2; exit 1; }
export CANVAS_SMOKE_BASE_URL="http://127.0.0.1:$port" CANVAS_SMOKE_PROJECT="$project"
export CANVAS_SMOKE_COMPOSE_FILE="$work/compose.json" CANVAS_SMOKE_ENV_FILE="$work/test.env" CANVAS_SMOKE_OUTPUT_DIR="$work"
export CANVAS_SMOKE_COMMIT="$commit" CANVAS_SMOKE_API_IMAGE_ID="$api_id" CANVAS_SMOKE_WEB_IMAGE_ID="$web_id"
export CANVAS_SMOKE_REPOSITORY_ROOT="$repo" CANVAS_SMOKE_NETWORK="${project}_default"
bash "$repo/ops/release/browser-smoke.sh"
[[ "$(dc images -q api | head -n 1)" != '' ]]
[[ "$(docker inspect -f '{{.Image}}' "$(dc ps -q api)")" == "$api_id" && "$(docker inspect -f '{{.Image}}' "$(dc ps -q web)")" == "$web_id" ]]
python3 "$repo/ops/release/artifact.py" seal-verification --candidate "$candidate" --browser-receipt "$work/browser-smoke.json" --workflow-run "$GITHUB_RUN_ID" --output "$work/verification.json"
echo EXACT_APPLICATION_IMAGES_VERIFIED_NO_REBUILD
