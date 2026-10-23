#!/usr/bin/env bash
set -euo pipefail
# This test overwrites only its disposable Compose database/object keys.
[[ "${CI:-}" == true && "${COMPOSE_PROJECT_NAME:-}" == canvas-phase1-ci ]] || { echo 'Disposable CI project required' >&2; exit 2; }
docker compose stop backup

docker compose exec -T postgres psql -U wireless_canvas -d wireless_canvas -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO departments(name,code) VALUES('Recovery Marker','recovery-marker');
INSERT INTO users(id,username,display_name,role) VALUES('64000000-0000-4000-8000-000000000001','backup-fixture','Backup fixture','designer');
INSERT INTO assets(owner_user_id,object_key,filename,mime_type,byte_size,kind,status,thumbnail_256_key,thumbnail_1024_key)
VALUES('64000000-0000-4000-8000-000000000001','backup-fixture/original','original.bin','application/octet-stream',16,'other','ready','backup-fixture/thumb256','backup-fixture/thumb1024');
-- Published design-library snapshots are independent objects, not assets or generation tasks.
INSERT INTO design_library_publications(id,author_id,author_name,title,request_id,payload_hash,created_at,updated_at)
VALUES('64000000-0000-4000-8000-000000000002','64000000-0000-4000-8000-000000000001','Backup fixture','Recovery library fixture','backup-library-fixture','ci-backup-library-fixture',now(),now());
INSERT INTO design_library_images(id,entry_id,position,object_key,filename,mime_type,byte_size,width,height)
VALUES('64000000-0000-4000-8000-000000000003','64000000-0000-4000-8000-000000000002',0,'backup-fixture/library.png','library.png','image/png',68,1,1);
SQL
docker compose run --rm --no-deps --entrypoint /bin/sh minio-init -c '
  set -eu
  mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
  for name in original thumb256 thumb1024; do printf "backup-fixture-1" | mc pipe "local/$S3_BUCKET/backup-fixture/$name" >/dev/null; done
  printf "%s" "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=" | base64 -d | mc pipe "local/$S3_BUCKET/backup-fixture/library.png" >/dev/null
'

# Capture the unique, successfully completed snapshot, never pick an implicit latest.
snapshot_log=$(docker compose run --rm --no-deps -e BACKUP_RUN_ONCE=true backup)
snapshot=$(printf '%s\n' "$snapshot_log" | jq -r 'select(.event=="backup.completed") | .snapshot' | tail -n 1)
[[ "$snapshot" =~ ^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$ ]] || { echo 'No completed backup snapshot' >&2; exit 1; }

docker compose stop web api worker backup
docker compose exec -T postgres psql -U wireless_canvas -d wireless_canvas -v ON_ERROR_STOP=1 -c "DELETE FROM departments WHERE code='recovery-marker'; DELETE FROM design_library_images WHERE id='64000000-0000-4000-8000-000000000003'"
docker compose run --rm --no-deps --entrypoint /bin/sh minio-init -c '
  set -eu
  mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
  mc rm "local/$S3_BUCKET/backup-fixture/original" "local/$S3_BUCKET/backup-fixture/thumb256" "local/$S3_BUCKET/backup-fixture/thumb1024" "local/$S3_BUCKET/backup-fixture/library.png"
'
docker compose run --rm --no-deps -e RESTORE_ALLOW_DESTRUCTIVE=true -e RESTORE_WRITES_STOPPED=true \
  -e BACKUP_AGE_IDENTITY_FILE=/run/backup-keys/identity backup restore.sh "$snapshot"
restored=$(docker compose exec -T postgres psql -U wireless_canvas -d wireless_canvas -Atc "SELECT COUNT(*) FROM departments WHERE code='recovery-marker'")
[[ "$restored" == 1 ]]
restored_library=$(docker compose exec -T postgres psql -U wireless_canvas -d wireless_canvas -Atc "SELECT COUNT(*) FROM design_library_images WHERE id='64000000-0000-4000-8000-000000000003' AND object_key='backup-fixture/library.png' AND byte_size=68 AND mime_type='image/png'")
[[ "$restored_library" == 1 ]]
docker compose run --rm --no-deps --entrypoint /bin/sh minio-init -c '
  set -eu
  mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null
  for name in original thumb256 thumb1024; do test "$(mc cat "local/$S3_BUCKET/backup-fixture/$name")" = "backup-fixture-1"; done
  test "$(mc cat "local/$S3_BUCKET/backup-fixture/library.png" | base64 | tr -d "\n")" = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
'
printf 'Encrypted database, three original/thumbnail objects and independent design-library PNG restored from %s\n' "$snapshot"
