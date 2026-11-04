#!/usr/bin/env bash
# Only stack-smoke.sh's fresh, isolated candidate stack is accepted. Browser
# traffic reaches the shipped Nginx/API; only the upstream provider is local.
set -Eeuo pipefail
umask 077
export PYTHONDONTWRITEBYTECODE=1
[[ $# == 0 ]] || { echo 'browser-smoke.sh only accepts the stack-smoke environment' >&2; exit 2; }
repo=$(cd -- "$(dirname -- "$0")/../.." && pwd -P)
required=(BASE_URL PROJECT COMPOSE_FILE ENV_FILE OUTPUT_DIR COMMIT API_IMAGE_ID WEB_IMAGE_ID REPOSITORY_ROOT NETWORK)
for key in "${required[@]}"; do
  name="CANVAS_SMOKE_$key"
  [[ -n ${!name:-} ]] || { echo "REQUIRED_SMOKE_VARIABLE_MISSING:$name" >&2; exit 1; }
done
work=$CANVAS_SMOKE_OUTPUT_DIR
project=$CANVAS_SMOKE_PROJECT
[[ "$project" =~ ^ci-release-[0-9]+-[0-9]+-(amd64|arm64)$ && "$CANVAS_SMOKE_NETWORK" == "${project}_default" ]]
[[ "$CANVAS_SMOKE_COMMIT" =~ ^[a-f0-9]{40}$ && "$CANVAS_SMOKE_API_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ && "$CANVAS_SMOKE_WEB_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$CANVAS_SMOKE_REPOSITORY_ROOT" == "$repo" && "$work" == /* && "$work" != / && -d "$work" && ! -L "$work" ]]
[[ "$CANVAS_SMOKE_COMPOSE_FILE" == "$work/compose.json" && "$CANVAS_SMOKE_ENV_FILE" == "$work/test.env" ]]
for file in "$CANVAS_SMOKE_COMPOSE_FILE" "$CANVAS_SMOKE_ENV_FILE"; do [[ -f "$file" && ! -L "$file" ]]; done
for file in seed.private.json upload.png provider-before.private.json provider-after.private.json browser-checks.private.json browser-smoke.json; do
  [[ ! -e "$work/$file" && ! -L "$work/$file" ]] || { echo SMOKE_EVIDENCE_ALREADY_EXISTS >&2; exit 1; }
done
python3 - <<'PY'
import os,stat,urllib.parse
address=urllib.parse.urlsplit(os.environ['CANVAS_SMOKE_BASE_URL'])
assert address.scheme=='http' and address.hostname=='127.0.0.1' and address.port and 1024<=address.port<=65535
assert not address.username and not address.password and address.path in ('','/') and not address.query and not address.fragment
assert stat.S_IMODE(os.stat(os.environ['CANVAS_SMOKE_OUTPUT_DIR']).st_mode)==0o700
PY

dc() { docker compose -p "$project" --project-directory "$repo" --env-file "$CANVAS_SMOKE_ENV_FILE" -f "$CANVAS_SMOKE_COMPOSE_FILE" "$@"; }
docker network inspect "$CANVAS_SMOKE_NETWORK" "${project}_ingress" > "$work/network.private.json"
python3 - "$work/network.private.json" <<'PY'
import json,os,sys
networks=json.load(open(sys.argv[1])); project=os.environ['CANVAS_SMOKE_PROJECT']
assert len(networks)==2 and {n['Name'] for n in networks}=={project+'_default',project+'_ingress'}
for network in networks:
 assert network['Internal'] is (network['Name']==project+'_default')
 assert network['Labels']['com.docker.compose.project']==project
PY
for service in api worker web mock-provider postgres redis minio; do
  id=$(dc ps -q "$service")
  [[ -n "$id" && "$id" != *$'\n'* ]]
  docker inspect "$id" > "$work/$service-container.private.json"
  python3 - "$work/$service-container.private.json" "$service" <<'PY'
import json,os,sys,urllib.parse
container,=json.load(open(sys.argv[1])); service=sys.argv[2]
labels=container['Config']['Labels']; project=os.environ['CANVAS_SMOKE_PROJECT']
assert labels['com.docker.compose.project']==project and labels['com.docker.compose.service']==service
expected_networks={os.environ['CANVAS_SMOKE_NETWORK']}
if service=='web':expected_networks.add(project+'_ingress')
assert container['State']['Running'] is True and set(container['NetworkSettings']['Networks'])==expected_networks
ports={key:value for key,value in container['NetworkSettings']['Ports'].items() if value}
if service=='web':
 assert ports=={'3000/tcp':[{'HostIp':'127.0.0.1','HostPort':str(urllib.parse.urlsplit(os.environ['CANVAS_SMOKE_BASE_URL']).port)}]}
else:assert not ports
if service in ('api','worker','mock-provider','web'):
 expected=os.environ['CANVAS_SMOKE_WEB_IMAGE_ID' if service=='web' else 'CANVAS_SMOKE_API_IMAGE_ID']
 assert container['Image']==expected
if service in ('api','worker'):
 assert container['Config']['Cmd']==['bun','src/index.ts' if service=='api' else 'src/worker.ts']
 env=dict(value.split('=',1) for value in container['Config']['Env'])
 assert env['NODE_ENV']=='production' and env['TASK_MOCK_MODE']=='false' and env['AUTH_ENABLED']=='true' and env['OA_LOGIN_ENABLED']=='false'
PY
done
python3 - "$work/network.private.json" "$work/web-container.private.json" <<'PY'
import json,sys
networks=json.load(open(sys.argv[1])); web,=json.load(open(sys.argv[2]))
ingress=next(n for n in networks if n['Name'].endswith('_ingress'))
assert set(ingress['Containers'])=={web['Id']}
PY
# Verify backend isolation without contacting any real external provider.
for service in api worker mock-provider; do
  dc exec -T "$service" bun --no-env-file -e \
    'const raw=require("node:fs").readFileSync("/proc/net/route","utf8");if(!raw.startsWith("Iface"))throw Error("Cannot verify backend routes");if(raw.trim().split("\n").slice(1).some(row=>row.trim().split(/\s+/)[1]==="00000000"))throw Error("Isolated backend has an external default route");'
done

# No credentials are sent through command arguments or browser trace files.
dc run --rm --no-deps --pull never \
  -v "$repo/server/tests/production-smoke:/smoke:ro" \
  -e CANVAS_SMOKE_PROJECT="$project" -e CANVAS_SMOKE_ALLOW_SEED=isolated-compose-only \
  -e CANVAS_SMOKE_SOURCE_ROOT=/app/src api bun --no-env-file /smoke/seed.ts > "$work/seed.private.json"
provider_get() {
  dc exec -T mock-provider bun --no-env-file -e \
    'const r=await fetch("http://127.0.0.1:4180"+process.argv[1]); if(!r.ok)throw Error("Local provider evidence read failed"); await Bun.write(Bun.stdout,await r.arrayBuffer());' "$1"
}
provider_get /__smoke/receipt > "$work/provider-before.private.json"
python3 - "$work/provider-before.private.json" <<'PY'
import json,os,sys
value=json.load(open(sys.argv[1]))
assert value['schema']==1 and value['project']==os.environ['CANVAS_SMOKE_PROJECT'] and value['paid'] is False and value['calls']==[]
PY
provider_get /fixtures/upload.png > "$work/upload.png"
[[ -f "$repo/web/node_modules/@playwright/test/cli.js" ]] || { echo PREINSTALLED_PLAYWRIGHT_REQUIRED >&2; exit 1; }
env -u NODE_OPTIONS -u BUN_OPTIONS -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy \
  node "$repo/web/node_modules/@playwright/test/cli.js" test --config "$repo/web/e2e/production-smoke.config.ts"
provider_get /__smoke/receipt > "$work/provider-after.private.json"
bun --no-env-file "$repo/server/tests/production-smoke/receipt.ts"
echo FORMAL_BROWSER_SMOKE_VERIFIED_NO_PAID_PROVIDER
