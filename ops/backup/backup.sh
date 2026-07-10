#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"

interval="${BACKUP_INTERVAL_SECONDS:-900}"
retention_days="${BACKUP_RETENTION_DAYS:-30}"
mc alias set storage "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"

while true; do
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    file="/tmp/wireless-canvas-${stamp}.dump"
    pg_dump "$DATABASE_URL" --format=custom --compress=9 --file="$file"
    mc cp "$file" "storage/${S3_BUCKET}/backups/postgres/${stamp}.dump"
    rm -f "$file"
    cutoff="$(date -u -d "-${retention_days} days" +%Y-%m-%dT%H:%M:%SZ)"
    mc rm --recursive --force --older-than "${retention_days}d" "storage/${S3_BUCKET}/backups/postgres/" || true
    echo "Backup completed at ${stamp}; cutoff ${cutoff}"
    if [[ "${BACKUP_RUN_ONCE:-false}" == "true" ]]; then
        break
    fi
    sleep "$interval"
done
