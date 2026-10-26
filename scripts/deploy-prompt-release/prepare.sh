#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release="$(cd -- "$(dirname -- "$0")/.." && pwd)"
previous=/home/vcan/releases/canvas-073c9b2-20261024-prompt
test "$release" = /home/vcan/releases/__RELEASE__
cd "$release"
sha256sum -c SHA256SUMS > /dev/null
sha256sum -c ORIGINALS-SHA256SUMS > /dev/null
if test -f DEPLOYED; then
  test "$(readlink -f /home/vcan/current)" = "$release"
  echo ALREADY_DEPLOYED_NO_PREPARATION_CHANGES
  exit 0
fi
test "$(readlink -f /home/vcan/current)" = "$previous"
for container in vincent-s-canvas-api-1 vincent-s-canvas-worker-1; do
  test "$(docker inspect --format '{{.Config.Image}}' "$container")" = canvas-api:canvas-073c9b2-20261024-prompt
done
test "$(docker inspect --format '{{.Config.Image}}' wireless-canvas-web)" = canvas-web:canvas-073c9b2-20261024-prompt
if test -f BACKUP_DIRECTORY; then
  backup="$(cat BACKUP_DIRECTORY)"
  case "$backup" in /home/vcan/backups/__RELEASE__.*) ;; *) exit 1;; esac
  test -d "$backup"
else
  backup="$(mktemp -d /home/vcan/backups/__RELEASE__.XXXXXX)"
  printf '%s\n' "$backup" > BACKUP_DIRECTORY
fi
if test -f PREPARED; then
  cmp .env "$previous/.env"
  test "$(docker image inspect --format '{{.Id}}' canvas-api:__RELEASE__)" = "$(cat "$backup/target-api-image-id.txt")"
  test "$(docker image inspect --format '{{.Id}}' canvas-web:__RELEASE__)" = "$(cat "$backup/target-web-image-id.txt")"
  echo ALREADY_PREPARED_NO_BUILD_OR_DATABASE_CHANGES
  exit 0
fi
if test -e .env; then cmp .env "$previous/.env"; else cp -p "$previous/.env" .env; fi
chmod 600 .env
# Runtime configuration comes from the actual previous release, not repository defaults.
cp -p "$previous/compose.runtime.yml" compose.runtime.yml
cp -p "$previous/compose.release.yml" previous-compose.release.yml
if test ! -f "$backup/configuration-saved"; then
  cp -p "$previous/.env" "$previous/compose.runtime.yml" "$previous/compose.release.yml" "$backup/"
  docker inspect wireless-canvas-web vincent-s-canvas-api-1 vincent-s-canvas-worker-1 > "$backup/application-containers.private.json"
  readlink -f /home/vcan/current > "$backup/current-before.txt"
  docker inspect --format '{{.Name}} {{.Id}} {{.Image}} {{.State.StartedAt}}' wireless-canvas-web vincent-s-canvas-api-1 vincent-s-canvas-worker-1 > "$backup/application-identity-before.txt"
  docker inspect --format '{{.Name}} {{.Image}}' wireless-canvas-web vincent-s-canvas-api-1 vincent-s-canvas-worker-1 > "$backup/application-images-before.txt"
  docker inspect --format '{{.Name}} {{.Id}} {{.Image}} {{.State.StartedAt}}' \
    vincent-s-canvas-postgres-1 vincent-s-canvas-redis-1 vincent-s-canvas-minio-1 vincent-s-canvas-backup-1 \
    newvcan-api-1 newvcan-worker-1 newvcan-web newvcan-postgres-1 newvcan-redis-1 newvcan-minio-1 newvcan-backup-1 > "$backup/untouched-containers.txt"
  curl --max-time 5 -fsS http://127.0.0.1:3000/api/deployment > "$backup/deployment-before.json"
  curl --max-time 5 -fsS http://127.0.0.1:3000/api/auth/methods > "$backup/auth-methods-before.json"
  touch "$backup/configuration-saved"
fi
docker run --rm --network none -v "$release:/release" canvas-api:canvas-073c9b2-20261024-prompt bun -e '
let source=await Bun.file("/release/previous-compose.release.yml").text();
for(const [oldValue,newValue,count] of [["canvas-web:canvas-073c9b2-20261024-prompt","canvas-web:__RELEASE__",1],["canvas-api:canvas-073c9b2-20261024-prompt","canvas-api:__RELEASE__",2]]) {
  if(source.split(oldValue).length-1!==count)throw Error("Unexpected image mapping");
  source=source.replaceAll(oldValue,newValue);
}
await Bun.write("/release/compose.release.yml",source);'
docker compose -p vincent-s-canvas -f compose.runtime.yml -f compose.release.yml config --format json > "$backup/candidate-compose.private.json"
docker run --rm --network none -v "$backup:/backup:ro" canvas-api:canvas-073c9b2-20261024-prompt bun -e '
const old=await Bun.file("/backup/application-containers.private.json").json(),candidate=await Bun.file("/backup/candidate-compose.private.json").json();
for(const [service,name] of [["api","/vincent-s-canvas-api-1"],["worker","/vincent-s-canvas-worker-1"],["web","/wireless-canvas-web"]]) {
  const prior=old.find(item=>item.Name===name),environment=Object.fromEntries(prior.Config.Env.map(value=>{const index=value.indexOf("=");return[value.slice(0,index),value.slice(index+1)];}));
  const changed=Object.entries(candidate.services[service].environment||{}).filter(([key,value])=>String(value)!==environment[key]).map(([key])=>key);
  if(changed.length)throw Error("Unexpected environment changes: "+changed.join(","));
  if(candidate.services[service].logging?.driver!=="json-file"||candidate.services[service].logging?.options?.["max-size"]!=="20m"||candidate.services[service].logging?.options?.["max-file"]!=="5")throw Error("Log rotation missing");
}
if(JSON.stringify(candidate.services.worker.healthcheck?.test)!==JSON.stringify(["CMD","bun","src/worker-healthcheck.ts"]))throw Error("Worker healthcheck missing");
console.log("APPLICATION_CONFIGURATION_PRESERVED");'
if test ! -f "$backup/database-backup-verified"; then
  docker exec vincent-s-canvas-postgres-1 pg_dump -U wireless_canvas -d wireless_canvas --format=custom --compress=6 > "$backup/database-before.dump"
  test -s "$backup/database-before.dump"
  docker exec -i vincent-s-canvas-postgres-1 pg_restore --list < "$backup/database-before.dump" > "$backup/database-restore-list.txt"
  test -s "$backup/database-restore-list.txt"
  sha256sum "$backup/database-before.dump" > "$backup/database-before.sha256"
  touch "$backup/database-backup-verified"
fi
docker build --pull=false -t canvas-api:__RELEASE__ -f deploy/Dockerfile.api .
docker build --network none --pull=false -t canvas-web:__RELEASE__ -f deploy/Dockerfile.web .
docker image inspect --format '{{.Id}}' canvas-api:__RELEASE__ > "$backup/target-api-image-id.txt"
docker image inspect --format '{{.Id}}' canvas-web:__RELEASE__ > "$backup/target-web-image-id.txt"
docker run --rm --network none canvas-api:__RELEASE__ sh -ec 'cd /app && sha256sum -c RELEASE-SHA256SUMS >/dev/null; cd /shared && sha256sum -c RELEASE-SHA256SUMS >/dev/null; test -f /app/scripts/import-prompt-recipes.ts; bun -e '\''await import("/app/src/media-runtime.ts");await import("/app/src/object-storage.ts");console.log("RUNTIME_IMPORTS_VERIFIED")'\'''
docker run --rm --network none canvas-api:__RELEASE__ bun scripts/import-prompt-recipes.ts --file '/opt/release/prompt-sources/无线画布-板块系统提示词（机密）.md' --dry-run > "$backup/recipe-dry-run.json"
docker run --rm --network none -v "$backup:/backup:ro" canvas-api:__RELEASE__ bun -e 'const result=await Bun.file("/backup/recipe-dry-run.json").json();if(result.recipes.length!==18||new Set(result.recipes.map(item=>item.key)).size!==18)throw Error("Expected 18 unique source recipes");'
docker run --rm --network vincent-s-canvas_default canvas-web:__RELEASE__ nginx -t
docker run --rm --network none canvas-web:__RELEASE__ sh -ec 'cd /usr/share/nginx/html && sha256sum -c /opt/release/WEB-SHA256SUMS' > "$backup/web-image-verified.txt"
touch PREPARED
echo RELEASE_PREPARED_NO_CUTOVER
