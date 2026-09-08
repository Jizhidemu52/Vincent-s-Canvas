#!/usr/bin/env bash
set -euo pipefail
cd "${1:?Expected newly generated package directory}"
test ! -e .env || { echo 'Smoke test refuses an existing .env'; exit 1; }
bun -e '
const text = await Bun.file(".env.example").text();
const values = {
 POSTGRES_PASSWORD: crypto.randomUUID().replaceAll("-", ""),
 BOOTSTRAP_ADMIN_PASSWORD: crypto.randomUUID(),
 S3_SECRET_ACCESS_KEY: crypto.randomUUID(),
 PROVIDER_ENCRYPTION_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
 TASK_MOCK_MODE: "true"
};
await Bun.write(".env", text.replace(/^(\w+)=(.*)$/gm, (line,key) => key in values ? `${key}=${values[key]}` : line));
'
dc() { docker compose -p offline-ci -f compose.json "$@"; }
# Ephemeral CI project only; never deletes volumes or user data.
trap 'dc down' EXIT
bash offline.sh verify
dc config --quiet
dc run --rm --no-deps --pull never -v "$PWD:/workspace:ro" -w /workspace \
  api bun ops/preflight/production-preflight.ts --allow-mock
dc up -d --no-build --pull never --wait --wait-timeout 180
curl --fail --silent --show-error http://127.0.0.1:3300/api/health
curl --fail --silent --show-error http://127.0.0.1:3300/ > /dev/null
echo 'Complete offline service startup: PASS (mock mode, no provider calls)'
