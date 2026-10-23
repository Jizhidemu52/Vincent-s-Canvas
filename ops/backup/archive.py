#!/usr/bin/env python3
"""Reference-verified backups using PostgreSQL snapshots, official mc and age.

PostgreSQL and object storage do not share a transaction. See README.md before
calling an online archive a point-in-time joint backup or restoring production.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from urllib.parse import parse_qsl, quote, unquote, urlsplit
from uuid import uuid4


FORMAT = "canvas-reference-backup-v1"
CONSISTENCY = "postgres-snapshot-with-online-reference-verification"
SNAPSHOT_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,100}\Z")
HASH_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
MIME_PATTERN = re.compile(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+\Z")
ASSET_QUERY = """
SELECT COALESCE(json_agg(row_to_json(required) ORDER BY required.key), '[]'::json)
FROM (
  SELECT object_key AS key, byte_size AS expected_bytes, mime_type
    FROM assets WHERE status='ready'
  UNION ALL
  SELECT thumbnail_256_key AS key, NULL::bigint AS expected_bytes, 'image/webp' AS mime_type
    FROM assets WHERE status='ready' AND thumbnail_256_key IS NOT NULL
  UNION ALL
  SELECT thumbnail_1024_key AS key, NULL::bigint AS expected_bytes, 'image/webp' AS mime_type
    FROM assets WHERE status='ready' AND thumbnail_1024_key IS NOT NULL
  UNION ALL
  SELECT object_key AS key, byte_size::bigint AS expected_bytes, mime_type
    FROM design_library_images
) required;
"""


class ArchiveError(Exception):
    def __init__(self, stage: str, status: int | None = None):
        super().__init__(stage)
        self.stage = stage
        self.status = status


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ArchiveError(f"configuration.{name}")
    return value


def endpoint(value: str):
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password \
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
        raise ArchiveError("configuration.storage_endpoint")
    return parsed


def object_key(value: object) -> str:
    if not isinstance(value, str) or not value or value.startswith("/") or "\\" in value \
            or any(ord(char) < 32 or ord(char) == 127 for char in value) \
            or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ArchiveError("manifest.object_key")
    return value


def mime_type(value: object, stage: str = "manifest.mime_type") -> str:
    if not isinstance(value, str) or not MIME_PATTERN.fullmatch(value):
        raise ArchiveError(stage)
    return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def log(event: str, **fields):
    print(json.dumps({"event": event, **fields}, separators=(",", ":")), flush=True)


def command(args: list[str]) -> list[str]:
    executable = shutil.which(args[0])
    if not executable:
        raise ArchiveError("tool.missing_" + args[0])
    return [executable, *args[1:]]


class Archive:
    def __init__(self, work: Path):
        self.work = work
        self.env = dict(os.environ)
        # libpq environment variables keep passwords out of command arguments.
        database = urlsplit(required("DATABASE_URL"))
        if database.scheme not in {"postgres", "postgresql"} or not database.hostname or not database.path.strip("/") or database.fragment:
            raise ArchiveError("configuration.database_url")
        self.env.update(PGHOST=database.hostname, PGPORT=str(database.port or 5432), PGDATABASE=unquote(database.path[1:]),
                        PGUSER=unquote(database.username or ""), PGPASSWORD=unquote(database.password or ""),
                        PGCONNECT_TIMEOUT="15", PGCLIENTENCODING="UTF8")
        ssl_options = {"sslmode": "PGSSLMODE", "sslrootcert": "PGSSLROOTCERT", "sslcert": "PGSSLCERT", "sslkey": "PGSSLKEY"}
        for key, value in parse_qsl(database.query):
            if key not in ssl_options:
                raise ArchiveError("configuration.database_url_option")
            self.env[ssl_options[key]] = value
        self.env.pop("DATABASE_URL", None)
        self.env["MC_CONFIG_DIR"] = str(work / "mc-config")
        source = endpoint(required("S3_ENDPOINT"))
        destination = endpoint(required("BACKUP_S3_ENDPOINT"))
        # Different ports on the same host are still not a separate failure domain.
        if source.hostname.casefold().rstrip(".") == destination.hostname.casefold().rstrip("."):
            raise ArchiveError("configuration.backup_must_use_external_host")
        for alias, parsed, prefix in [("source", source, "S3_"), ("backup", destination, "BACKUP_S3_")]:
            access = quote(required(prefix + "ACCESS_KEY_ID"), safe="")
            secret = quote(required(prefix + "SECRET_ACCESS_KEY"), safe="")
            self.env["MC_HOST_" + alias] = f"{parsed.scheme}://{access}:{secret}@{parsed.netloc}"
        self.source_bucket = required("S3_BUCKET")
        self.backup_bucket = required("BACKUP_S3_BUCKET")
        if any(not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket) for bucket in [self.source_bucket, self.backup_bucket]):
            raise ArchiveError("configuration.bucket_name")
        self.prefix = object_key(os.environ.get("BACKUP_PREFIX", "canvas"))

    def run(self, stage: str, args: list[str], *, data: bytes | None = None, timeout: int = 3600) -> bytes:
        try:
            result = subprocess.run(command(args), input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    env=self.env, timeout=timeout, check=False)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ArchiveError(stage) from error
        if result.returncode:
            # Native diagnostics can contain connection strings, SQL or credentials.
            # They are deliberately not forwarded to container logs/webhooks.
            raise ArchiveError(stage, result.returncode)
        return result.stdout

    def copy(self, source: str | Path, destination: str | Path, stage: str, mime: str | None = None):
        args = ["mc", "cp"]
        if mime:
            args.extend(["--attr", "Content-Type=" + mime_type(mime)])
        self.run(stage, args + [str(source), str(destination)])

    def remote_hash(self, remote: str, stage: str) -> str:
        digest = hashlib.sha256()
        with tempfile.TemporaryFile() as errors:
            try:
                process = subprocess.Popen(command(["mc", "cat", remote]), stdout=subprocess.PIPE, stderr=errors, env=self.env)
            except OSError as error:
                raise ArchiveError(stage) from error
            timeout = threading.Timer(3600, process.kill)
            timeout.start()
            try:
                assert process.stdout is not None
                for chunk in iter(lambda: process.stdout.read(1024 * 1024), b""):
                    digest.update(chunk)
                if process.wait(timeout=30):
                    raise ArchiveError(stage)
            finally:
                timeout.cancel()
                if process.poll() is None:
                    process.kill()
                if process.stdout:
                    process.stdout.close()
                process.wait()
        return digest.hexdigest()

    def verify_remote(self, remote: str, expected: str, stage: str):
        if self.remote_hash(remote, stage) != expected:
            raise ArchiveError(stage + ".checksum")

    def root(self, snapshot: str) -> str:
        if not SNAPSHOT_PATTERN.fullmatch(snapshot):
            raise ArchiveError("configuration.snapshot_id")
        return f"backup/{self.backup_bucket}/{self.prefix}/snapshots/{snapshot}"

    def encrypted_database(self, recipient: str):
        """Keep the exporting transaction alive until BOTH readers have finished."""
        args = ["psql", "-X", "-qAt", "--no-password", "-v", "ON_ERROR_STOP=1"]
        with tempfile.TemporaryFile() as errors:
            try:
                exporter = subprocess.Popen(command(args), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, env=self.env)
            except OSError as error:
                raise ArchiveError("postgres.snapshot_start") from error
            try:
                assert exporter.stdin and exporter.stdout
                exporter.stdin.write(b"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();\n")
                exporter.stdin.flush()
                lines: queue.Queue[bytes] = queue.Queue()
                threading.Thread(target=lambda: lines.put(exporter.stdout.readline()), daemon=True).start()
                try:
                    snapshot = lines.get(timeout=60).decode("ascii").strip()
                except (queue.Empty, UnicodeError) as error:
                    raise ArchiveError("postgres.snapshot_export") from error
                if not re.fullmatch(r"[0-9A-Fa-f-]{8,100}", snapshot):
                    raise ArchiveError("postgres.snapshot_export")
                query = ("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '" + snapshot + "';\n" + ASSET_QUERY + "\nCOMMIT;\n").encode()
                raw = self.run("postgres.asset_manifest", args, data=query)
                try:
                    references = json.loads(raw)
                except (UnicodeError, json.JSONDecodeError) as error:
                    raise ArchiveError("postgres.asset_manifest_json") from error
                # Plaintext database bytes exist only in this anonymous pipe.
                self.pipe_dump_to_age(snapshot, recipient)
                exporter.stdin.write(b"ROLLBACK;\n\\q\n")
                exporter.stdin.flush()
                exporter.stdin.close()
                if exporter.wait(timeout=30):
                    raise ArchiveError("postgres.snapshot_close")
                return snapshot, references
            finally:
                if exporter.poll() is None:
                    exporter.kill()
                exporter.wait()
                if exporter.stdin and not exporter.stdin.closed:
                    exporter.stdin.close()
                if exporter.stdout:
                    exporter.stdout.close()

    def pipe_dump_to_age(self, snapshot: str, recipient: str):
        with tempfile.TemporaryFile() as dump_errors, tempfile.TemporaryFile() as age_errors:
            dump = None
            encrypt = None
            try:
                dump = subprocess.Popen(command(["pg_dump", "--no-password", "--format=custom", "--compress=9", "--snapshot=" + snapshot]),
                                        stdout=subprocess.PIPE, stderr=dump_errors, env=self.env)
                encrypt = subprocess.Popen(command(["age", "--encrypt", "--recipient", recipient, "--output", str(self.work / "db.dump.age")]),
                                           stdin=dump.stdout, stdout=subprocess.DEVNULL, stderr=age_errors, env=self.env)
                assert dump.stdout
                dump.stdout.close()
                age_status = encrypt.wait(timeout=3600)
                if age_status:
                    raise ArchiveError("encryption.database", age_status)
                dump_status = dump.wait(timeout=30)
                if dump_status:
                    raise ArchiveError("postgres.dump", dump_status)
                if not (self.work / "db.dump.age").stat().st_size:
                    raise ArchiveError("encryption.database_empty")
            except (OSError, subprocess.TimeoutExpired) as error:
                raise ArchiveError("postgres.encrypted_dump") from error
            finally:
                for process in [encrypt, dump]:
                    if process is not None:
                        if process.poll() is None:
                            process.kill()
                        process.wait()

    def backup(self) -> str:
        recipient = required("BACKUP_AGE_RECIPIENT")
        if not recipient.startswith("age1") or any(char.isspace() for char in recipient):
            raise ArchiveError("configuration.age_public_recipient")
        snapshot = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:12]
        root = self.root(snapshot)
        # Buckets must be provisioned independently with their intended policy.
        self.run("storage.source_bucket", ["mc", "stat", f"source/{self.source_bucket}"])
        self.run("storage.backup_bucket", ["mc", "stat", f"backup/{self.backup_bucket}"])
        postgres_snapshot, references = self.encrypted_database(recipient)
        if not isinstance(references, list):
            raise ArchiveError("manifest.references")
        objects: dict[str, dict] = {}
        for reference in references:
            if not isinstance(reference, dict):
                raise ArchiveError("manifest.reference")
            key = object_key(reference.get("key"))
            mime = mime_type(reference.get("mime_type"))
            expected_size = reference.get("expected_bytes")
            if expected_size is not None and (not isinstance(expected_size, int) or expected_size < 0):
                raise ArchiveError("manifest.reference_size")
            if key in objects:
                if expected_size is not None and objects[key]["bytes"] != expected_size:
                    raise ArchiveError("manifest.reference_size_conflict")
                if objects[key]["mimeType"] != mime:
                    raise ArchiveError("manifest.reference_mime_conflict")
                continue
            local = self.work / "current-media"
            source = f"source/{self.source_bucket}/{key}"
            self.copy(source, local, "media.source_read")
            size = local.stat().st_size
            if expected_size is not None and size != expected_size:
                raise ArchiveError("media.source_size_changed")
            digest = sha256_file(local)
            stored = "media/" + digest
            # Remote-to-remote cp retains the original Content-Type/metadata.
            self.copy(source, root + "/" + stored, "media.external_copy")
            self.verify_remote(root + "/" + stored, digest, "media.external_verify")
            objects[key] = {"key": key, "bytes": size, "sha256": digest, "stored": stored, "mimeType": mime}
            local.unlink()
        manifest = {"format": FORMAT, "snapshot": snapshot, "consistency": CONSISTENCY, "postgresSnapshot": postgres_snapshot,
                    "objects": list(objects.values())}
        manifest_path = self.work / "manifest.json"
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        self.run("encryption.manifest", ["age", "--encrypt", "--recipient", recipient, "--output", str(self.work / "manifest.json.age"), str(manifest_path)])
        hashes = {}
        for name in ["db.dump.age", "manifest.json.age"]:
            local = self.work / name
            hashes[name] = sha256_file(local)
            self.copy(local, root + "/" + name, "payload.external_copy")
            self.verify_remote(root + "/" + name, hashes[name], "payload.external_verify")
        complete = {"format": FORMAT, "snapshot": snapshot, "consistency": CONSISTENCY,
                    "completedAt": datetime.now(timezone.utc).isoformat(), "objectCount": len(objects), "payloadSha256": hashes}
        marker = self.work / "COMPLETE.json"
        marker.write_text(json.dumps(complete, separators=(",", ":")), encoding="utf-8")
        # Publish only after every object and encrypted payload is read back.
        self.copy(marker, root + "/COMPLETE.json", "snapshot.publish")
        log("backup.completed", snapshot=snapshot, objectCount=len(objects), consistency=CONSISTENCY)
        return snapshot

    def restore(self, snapshot: str):
        if os.environ.get("RESTORE_ALLOW_DESTRUCTIVE") != "true" or os.environ.get("RESTORE_WRITES_STOPPED") != "true":
            raise ArchiveError("restore.explicit_confirmation_required")
        identity = Path(required("BACKUP_AGE_IDENTITY_FILE"))
        if not identity.is_file():
            raise ArchiveError("restore.age_identity_missing")
        root = self.root(snapshot)
        self.copy(root + "/COMPLETE.json", self.work / "COMPLETE.json", "restore.completion_marker")
        try:
            marker = json.loads((self.work / "COMPLETE.json").read_text(encoding="utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ArchiveError("restore.completion_marker_json") from error
        if marker.get("format") != FORMAT or marker.get("snapshot") != snapshot or marker.get("consistency") != CONSISTENCY:
            raise ArchiveError("restore.completion_marker_mismatch")
        for name in ["db.dump.age", "manifest.json.age"]:
            expected = marker.get("payloadSha256", {}).get(name)
            if not isinstance(expected, str) or not HASH_PATTERN.fullmatch(expected):
                raise ArchiveError("restore.payload_digest")
            local = self.work / name
            self.copy(root + "/" + name, local, "restore.payload_read")
            if sha256_file(local) != expected:
                raise ArchiveError("restore.payload_checksum")
            self.run("restore.decrypt", ["age", "--decrypt", "--identity", str(identity), "--output", str(local.with_suffix("")), str(local)])
        try:
            manifest = json.loads((self.work / "manifest.json").read_text(encoding="utf-8"))
        except (UnicodeError, json.JSONDecodeError) as error:
            raise ArchiveError("restore.manifest_json") from error
        objects = manifest.get("objects")
        if manifest.get("format") != FORMAT or manifest.get("snapshot") != snapshot or manifest.get("consistency") != CONSISTENCY \
                or not isinstance(objects, list) or len(objects) != marker.get("objectCount"):
            raise ArchiveError("restore.manifest_mismatch")
        seen = set()
        for index, item in enumerate(objects):
            key = object_key(item.get("key"))
            digest = item.get("sha256")
            size = item.get("bytes")
            mime = item.get("mimeType")
            if key in seen or not isinstance(digest, str) or not HASH_PATTERN.fullmatch(digest) \
                    or item.get("stored") != "media/" + digest or not isinstance(size, int) or size < 0:
                raise ArchiveError("restore.manifest_object")
            mime_type(mime, "restore.manifest_mime_type")
            seen.add(key)
            local = self.work / f"restore-media-{index}"
            self.copy(root + "/" + item["stored"], local, "restore.media_read")
            if local.stat().st_size != size or sha256_file(local) != digest:
                raise ArchiveError("restore.media_checksum")
        self.run("restore.dump_preflight", ["pg_restore", "--list", str(self.work / "db.dump")])
        self.run("restore.target_bucket", ["mc", "stat", f"source/{self.source_bucket}"])
        # Verify every input BEFORE the first write. Fresh targets remain safest.
        for index, item in enumerate(objects):
            target = f"source/{self.source_bucket}/{item['key']}"
            self.copy(self.work / f"restore-media-{index}", target, "restore.media_write", item.get("mimeType"))
            self.verify_remote(target, item["sha256"], "restore.media_verify")
        self.run("restore.database", ["pg_restore", "--clean", "--if-exists", "--no-owner", "--no-privileges", "--exit-on-error",
                                      "--single-transaction", "--dbname", self.env["PGDATABASE"], str(self.work / "db.dump")])
        log("restore.completed", snapshot=snapshot, objectCount=len(objects), warning="Keep writers stopped until application and media checks pass")


def notify_failure(stage: str):
    url = os.environ.get("BACKUP_FAILURE_WEBHOOK_URL", "")
    if not url:
        return
    parsed = urlsplit(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        log("backup.failure_webhook_invalid")
        return
    payload = json.dumps({"event": "canvas.backup.failed", "stage": stage}, separators=(",", ":"))
    # URL tokens stay out of process arguments as well as application logs.
    config = "url = " + json.dumps(url) + "\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\ndata = " + json.dumps(payload) + "\n"
    try:
        result = subprocess.run(command(["curl", "--fail", "--silent", "--max-time", "15", "--config", "-"]), input=config.encode(),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20, check=False)
        if result.returncode:
            log("backup.failure_webhook_failed", exitCode=result.returncode)
    except (OSError, subprocess.TimeoutExpired, ArchiveError) as error:
        log("backup.failure_webhook_failed", errorType=type(error).__name__)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=["backup", "restore"])
    parser.add_argument("snapshot", nargs="?")
    args = parser.parse_args()
    if (args.operation == "restore") != bool(args.snapshot):
        parser.error("restore requires one explicit snapshot ID; backup takes no snapshot argument")
    os.umask(0o077)
    try:
        interval = int(os.environ.get("BACKUP_INTERVAL_SECONDS", "900"))
        if interval < 60:
            raise ArchiveError("configuration.backup_interval")
        while True:
            with tempfile.TemporaryDirectory(prefix="canvas-backup-") as directory:
                archive = Archive(Path(directory))
                if args.operation == "restore":
                    archive.restore(args.snapshot)
                    return 0
                archive.backup()
            if os.environ.get("BACKUP_RUN_ONCE", "false") == "true":
                return 0
            time.sleep(interval)
    except ArchiveError as error:
        log(args.operation + ".failed", stage=error.stage, exitCode=error.status)
        if args.operation == "backup":
            notify_failure(error.stage)
        return 1
    except (ValueError, OSError, subprocess.SubprocessError, TypeError, KeyError, AttributeError):
        log(args.operation + ".failed", stage="local.runtime")
        if args.operation == "backup":
            notify_failure("local.runtime")
        return 1


if __name__ == "__main__":
    sys.exit(main())
