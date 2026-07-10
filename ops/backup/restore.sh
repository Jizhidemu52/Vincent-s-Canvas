#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: restore.sh backups/postgres/YYYYMMDDTHHMMSSZ.dump" >&2
    exit 2
fi
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ACCESS_KEY_ID:?S3_ACCESS_KEY_ID is required}"
: "${S3_SECRET_ACCESS_KEY:?S3_SECRET_ACCESS_KEY is required}"
mc alias set storage "$S3_ENDPOINT" "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"
file="/tmp/restore.dump"
trap 'rm -f "$file"' EXIT
mc cp "storage/${S3_BUCKET}/$1" "$file"
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" "$file"
echo "Restore completed from $1"
