#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
release="$(cd -- "$(dirname -- "$0")/.." && pwd)"
previous=/home/vcan/releases/canvas-ef575ee-20261024-prompt
optimizer="${PROMPT_OPTIMIZER_MODEL_ID:-652b3d3c-93bf-419e-851f-31c5e101daf6}"
action="${1:-deploy}"
test "$release" = /home/vcan/releases/__RELEASE__
cd "$release"
test -f PREPARED
backup="$(cat BACKUP_DIRECTORY)"
case "$backup" in /home/vcan/backups/__RELEASE__.*) ;; *) exit 1;; esac
test -d "$backup"
dc() { docker compose -p vincent-s-canvas -f "$release/compose.runtime.yml" -f "$release/compose.release.yml" "$@"; }
old_dc() { docker compose -p vincent-s-canvas -f "$previous/compose.runtime.yml" -f "$previous/compose.release.yml" "$@"; }
active_tasks() { docker exec vincent-s-canvas-postgres-1 psql -U wireless_canvas -d wireless_canvas -Atqc "SELECT count(*) FROM tasks WHERE status IN ('waiting','processing')"; }
set_current() {
  local target="$1" link="/home/vcan/current.next-__RELEASE__-$BASHPID"
  test ! -e "$link" && test ! -L "$link" || return 1
  ln -s "$target" "$link" || return 1
  mv -Tf "$link" /home/vcan/current || return 1
}
verify_old() {
  local attempt
  docker inspect --format '{{.Name}} {{.Image}}' wireless-canvas-web vincent-s-canvas-api-1 vincent-s-canvas-worker-1 > "$backup/application-images-rollback.txt" || return 1
  cmp "$backup/application-images-before.txt" "$backup/application-images-rollback.txt" || return 1
  for attempt in $(seq 1 30); do
    if curl --max-time 3 -fsS http://127.0.0.1:3000/api/health > "$backup/health-rollback.json" \
      && test "$(docker inspect --format '{{.State.Health.Status}}' vincent-s-canvas-worker-1)" = healthy; then return 0; fi
    sleep 2
  done
  return 1
}
restore_application() {
  local current attempt drained=0 running
  current="$(readlink -f /home/vcan/current)"
  test "$current" = "$release" || test "$current" = "$previous" || return 1
  running="$(docker inspect --format '{{.State.Running}}' wireless-canvas-web)" || return 1
  if test "$running" = true; then docker stop --signal SIGQUIT --time 240 wireless-canvas-web || return 1; fi
  # If a post-start probe failed, allow any accepted task to finish before restoring the old worker.
  for attempt in $(seq 1 60); do
    if test "$(active_tasks)" = 0; then drained=1; break; fi
    sleep 5
  done
  test "$drained" = 1 || { echo ROLLBACK_ACTIVE_TASKS_REQUIRE_MANUAL_RECOVERY >&2; return 1; }
  docker stop --time 60 vincent-s-canvas-worker-1 vincent-s-canvas-api-1 || return 1
  old_dc up -d --no-deps --no-build --pull never api worker web || return 1
  set_current "$previous" || return 1
  verify_old || return 1
  if test -f DEPLOYED; then mv DEPLOYED "$backup/DEPLOYED-rolled-back-$(date +%s)" || return 1; fi
  echo ROLLBACK_VERIFIED_DATABASE_AND_RECIPE_HISTORY_RETAINED
}
if test "$action" = rollback; then
  if test "$(readlink -f /home/vcan/current)" = "$previous"; then verify_old; echo ALREADY_ROLLED_BACK; exit 0; fi
  test "$(active_tasks)" = 0 || { echo ACTIVE_TASKS_EXIST_NO_ROLLBACK; exit 1; }
  docker stop --signal SIGQUIT --time 240 wireless-canvas-web
  test "$(active_tasks)" = 0 || { dc up -d --no-deps --no-build --pull never web; echo ACTIVE_TASKS_EXIST_NO_ROLLBACK; exit 1; }
  docker stop --time 60 vincent-s-canvas-worker-1 vincent-s-canvas-api-1
  restore_application
  exit 0
elif test "$action" = disable; then
  # This changes only recipe enabled flags, never versions, histories, employees or billing configuration.
  dc run --rm --no-deps -v "$release/deploy:/release-deploy:ro" api bun /release-deploy/recipe-state.ts disable
  exit 0
elif test "$action" != deploy; then echo 'Usage: cutover.sh [deploy|rollback|disable]' >&2; exit 2; fi
if test -f DEPLOYED; then
  test "$(readlink -f /home/vcan/current)" = "$release"
  test "$(docker inspect --format '{{.Config.Image}}' vincent-s-canvas-api-1)" = canvas-api:__RELEASE__
  test "$(docker inspect --format '{{.Config.Image}}' vincent-s-canvas-worker-1)" = canvas-api:__RELEASE__
  test "$(docker inspect --format '{{.Config.Image}}' wireless-canvas-web)" = canvas-web:__RELEASE__
  echo ALREADY_DEPLOYED_NO_REIMPORT
  exit 0
fi
test "$(readlink -f /home/vcan/current)" = "$previous"
test "$(cat "$backup/current-before.txt")" = "$previous"
cmp .env "$previous/.env"
cmp compose.runtime.yml "$previous/compose.runtime.yml"
cmp previous-compose.release.yml "$previous/compose.release.yml"
sha256sum -c SHA256SUMS > /dev/null
target_api_image="$(cat "$backup/target-api-image-id.txt")"
target_web_image="$(cat "$backup/target-web-image-id.txt")"
test "$(docker image inspect --format '{{.Id}}' canvas-api:__RELEASE__)" = "$target_api_image"
test "$(docker image inspect --format '{{.Id}}' canvas-web:__RELEASE__)" = "$target_web_image"
test "$(active_tasks)" = 0 || { echo ACTIVE_TASKS_EXIST_NO_CUTOVER; exit 1; }
attempt_dir="$(mktemp -d "$backup/cutover.XXXXXX")"
printf '%s\n' "$optimizer" > "$attempt_dir/optimizer-model-id.txt"
control_pid=$BASHPID
rollback_running=0
rollback_on_failure() {
  local status="${1:-1}"
  if test "$BASHPID" != "$control_pid"; then return "$status"; fi
  if test "$rollback_running" = 1; then return; fi
  rollback_running=1
  trap - ERR
  trap '' INT TERM HUP
  set +e
  echo CUTOVER_FAILED_RESTORING_APPLICATION_ONLY >&2
  if ! restore_application; then echo ROLLBACK_FAILED_MANUAL_RECOVERY_REQUIRED >&2; fi
  echo 'No database restore, table drop or media rollback was attempted.' >&2
  test "$status" -ne 0 || status=1
  exit "$status"
}
trap 'rollback_on_failure "$?"' ERR
trap 'rollback_on_failure 130' INT
trap 'rollback_on_failure 143' TERM
trap 'rollback_on_failure 129' HUP
docker stop --signal SIGQUIT --time 240 wireless-canvas-web
ready=0
for attempt in $(seq 1 60); do
  if test "$(active_tasks)" = 0; then ready=1; break; fi
  sleep 5
done
test "$ready" = 1
docker stop --time 60 vincent-s-canvas-worker-1 vincent-s-canvas-api-1
# Exact stopped-write backup; preserve every attempt rather than overwriting an earlier backup.
docker exec vincent-s-canvas-postgres-1 pg_dump -U wireless_canvas -d wireless_canvas --format=custom --compress=6 > "$attempt_dir/database-cutover.dump"
test -s "$attempt_dir/database-cutover.dump"
docker exec -i vincent-s-canvas-postgres-1 pg_restore --list < "$attempt_dir/database-cutover.dump" > "$attempt_dir/database-restore-list.txt"
test -s "$attempt_dir/database-restore-list.txt"
sha256sum "$attempt_dir/database-cutover.dump" > "$attempt_dir/database-cutover.sha256"
dc run --rm --no-deps -v "$release/deploy:/release-deploy:ro" -v "$attempt_dir:/release-state" api bun /release-deploy/recipe-state.ts capture /release-state/database-state.json "$optimizer"
dc run --rm --no-deps api bun src/migrate.ts
# Explicit import from the released original, after migration 043; --activate affects only an empty current version.
dc run --rm --no-deps api bun scripts/import-prompt-recipes.ts \
  --file '/opt/release/prompt-sources/无线画布-板块系统提示词（机密）.md' \
  --model "$optimizer" --actor 'release-__RELEASE__' --activate > "$attempt_dir/recipe-import.json"
dc run --rm --no-deps -v "$release/deploy:/release-deploy:ro" -v "$attempt_dir:/release-state:ro" api bun /release-deploy/recipe-state.ts verify /release-state/database-state.json "$optimizer" > "$attempt_dir/recipe-import-verified.json"
dc up -d --no-deps --no-build --pull never api worker web
ready=0
for attempt in $(seq 1 60); do
  if curl --max-time 3 -fsS http://127.0.0.1:3000/api/health > "$attempt_dir/health-after.json" \
    && test "$(docker inspect --format '{{.State.Health.Status}}' vincent-s-canvas-worker-1)" = healthy; then ready=1; break; fi
  sleep 2
done
test "$ready" = 1
for container in vincent-s-canvas-api-1 vincent-s-canvas-worker-1; do
  test "$(docker inspect --format '{{.Image}}' "$container")" = "$target_api_image"
  test "$(docker inspect --format '{{.RestartCount}}' "$container")" = 0
  docker exec "$container" cat /app/REVISION > "$attempt_dir/$container-revision.txt"
  cmp REVISION "$attempt_dir/$container-revision.txt"
  docker exec "$container" sh -ec 'cd /app && sha256sum -c RELEASE-SHA256SUMS; cd /shared && sha256sum -c RELEASE-SHA256SUMS' > "$attempt_dir/$container-source-verified.txt"
done
docker exec vincent-s-canvas-worker-1 bun src/worker-healthcheck.ts
worker_identity="$(docker inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.RestartCount}}' vincent-s-canvas-worker-1)"
worker_started_at="$(docker inspect --format '{{.State.StartedAt}}' vincent-s-canvas-worker-1)"
for attempt in $(seq 1 5); do
  sleep 2
  test "$(docker inspect --format '{{.Id}} {{.Image}} {{.State.StartedAt}} {{.RestartCount}}' vincent-s-canvas-worker-1)" = "$worker_identity"
done
docker logs --since "$worker_started_at" vincent-s-canvas-worker-1 > "$attempt_dir/worker-startup.log" 2>&1
grep -Eq '"event"[[:space:]]*:[[:space:]]*"worker\.started"' "$attempt_dir/worker-startup.log"
if grep -Eq '"event"[[:space:]]*:[[:space:]]*"worker\.(queue_claim_failed|queue_reconciliation_failed)"' "$attempt_dir/worker-startup.log"; then false; fi
test "$(docker inspect --format '{{.Image}}' wireless-canvas-web)" = "$target_web_image"
docker exec wireless-canvas-web sh -ec 'cd /usr/share/nginx/html && sha256sum -c /opt/release/WEB-SHA256SUMS' > "$attempt_dir/web-source-verified.txt"
docker exec wireless-canvas-web nginx -t
curl --max-time 5 -fsS http://127.0.0.1:3000/revision.txt > "$attempt_dir/revision-after.txt"
cmp REVISION "$attempt_dir/revision-after.txt"
curl --max-time 5 -fsS http://127.0.0.1:3000/ > "$attempt_dir/index-after.html"
cmp release-web/index.html "$attempt_dir/index-after.html"
curl --max-time 5 -fsS http://127.0.0.1:3000/api/deployment > "$attempt_dir/deployment-after.json"
curl --max-time 5 -fsS http://127.0.0.1:3000/api/auth/methods > "$attempt_dir/auth-methods-after.json"
docker run --rm --network none -v "$backup:/backup:ro" -v "$attempt_dir:/after:ro" canvas-api:__RELEASE__ bun -e '
import {isDeepStrictEqual} from "node:util";
for(const kind of ["deployment","auth-methods"])if(!isDeepStrictEqual(await Bun.file(`/backup/${kind}-before.json`).json(),await Bun.file(`/after/${kind}-after.json`).json()))throw Error(kind+" changed");
console.log("LOGIN_AND_BILLING_MODES_PRESERVED");'
for route in /api/admin/accounts /api/canvas-documents /api/tasks /api/admin/prompt-recipes; do
  test "$(curl --max-time 5 -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:3000$route")" = 401
done
docker inspect --format '{{.Name}} {{.Id}} {{.Image}} {{.State.StartedAt}}' \
  vincent-s-canvas-postgres-1 vincent-s-canvas-redis-1 vincent-s-canvas-minio-1 vincent-s-canvas-backup-1 \
  newvcan-api-1 newvcan-worker-1 newvcan-web newvcan-postgres-1 newvcan-redis-1 newvcan-minio-1 newvcan-backup-1 > "$attempt_dir/untouched-containers-after.txt"
cmp "$backup/untouched-containers.txt" "$attempt_dir/untouched-containers-after.txt"
set_current "$release"
printf '%s\n' "$attempt_dir" > DEPLOYED
trap - ERR INT TERM HUP
printf 'RELEASE_DEPLOYED_OK %s\nBACKUP %s\n' "$(cat REVISION)" "$attempt_dir"
