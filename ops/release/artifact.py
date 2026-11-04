#!/usr/bin/env python3
"""Create/export the already-tested application images; never rebuild them."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile

from contract import Rejected, assert_image, digest, digest_file, read_json, require, validate_manifest, verify_package, write_new_json


PACKAGE_FILES = [
    "ops/deploy.sh", "ops/release/deploy.py", "ops/release/contract.py", "ops/release/README.md",
    "ops/release/activity.sql", "ops/release/database-state.sql", "ops/release/maintenance.sql",
    "ops/baota/gate.py", "ops/baota/site-proxy.conf",
    "ops/release/usage-048.py", "ops/release/usage-048-state.sql", "ops/release/usage-048-catalog.json",
    "server/src/migrations/048_usage_daily_facts.sql",
]


def verify_048_payload(root, manifest):
    """Ship one reviewed schema preparation, never a general SQL directory."""
    relative = "server/src/migrations/048_usage_daily_facts.sql"
    rows = [row for row in manifest["migrations"] if row["name"] == Path(relative).name]
    require(len(rows) == 1 and manifest["migrations"][-1]["name"] == Path(relative).name, "FIXED_048_MIGRATION_REQUIRED")
    sql = root / relative
    require(sql.is_file() and not sql.is_symlink() and digest_file(sql) == rows[0]["sha256"], "PACKAGED_048_SQL_MIGRATION_HASH_MISMATCH")


def repository_commit(root):
    status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=root, capture_output=True, text=True, check=True)
    require(not status.stdout.strip(), "CLEAN_FROZEN_SOURCE_REQUIRED")
    result = subprocess.run(["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def migrations(root):
    result = []
    for path in sorted((root / "server/src/migrations").glob("*.sql")):
        require(path.is_file() and not path.is_symlink(), "REGULAR_MIGRATION_FILE_REQUIRED")
        result.append({"name": path.name, "sha256": digest(path.read_bytes())})
    return result


def create_candidate(root, version, commit, platform, api_inspect, web_inspect, api_digest, web_digest, run_id):
    require(repository_commit(root) == commit, "BUILD_SOURCE_COMMIT_MISMATCH")
    require((root / "VERSION").read_text(encoding="utf-8").strip() == version, "BUILD_SOURCE_VERSION_MISMATCH")
    architecture = platform.split("/")[-1]
    inspections = {"api": api_inspect, "web": web_inspect}
    require(all(isinstance(rows, list) and len(rows) == 1 for rows in inspections.values()), "ONE_IMAGE_PER_ROLE_REQUIRED")
    images = {role: {"reference": f"canvas-release-{role}:{commit}-{architecture}", "id": rows[0].get("Id"),
                     "digest": api_digest if role == "api" else web_digest} for role, rows in inspections.items()}
    result = {"schema": 1, "kind": "canvas-image-release", "version": version, "commit": commit, "platform": platform,
              "images": images, "migrations": migrations(root),
              "verification": {"status": "pending", "commit": commit, "platform": platform,
                               "imageIds": {role: row["id"] for role, row in images.items()}, "checks": [], "workflowRunId": run_id}}
    validate_manifest(result, require_verification=False)
    for role, rows in inspections.items(): assert_image(rows[0], result, role)
    return result


def seal_verification(candidate, browser, run_id):
    validate_manifest(candidate, require_verification=False)
    require(browser.get("schema") == 1 and browser.get("status") == "passed" and browser.get("commit") == candidate["commit"], "BROWSER_SMOKE_NOT_PASSED")
    require(browser.get("imageIds") == candidate["verification"]["imageIds"], "BROWSER_TESTED_DIFFERENT_IMAGES")
    require(isinstance(browser.get("checks"), list) and set(browser["checks"]) == {"login", "upload", "canvas-image", "refresh-recovery", "original-download", "video-task", "chat"}, "BROWSER_REQUIRED_PATH_MISSING")
    return {"status": "passed", "commit": candidate["commit"], "platform": candidate["platform"],
            "imageIds": copy.deepcopy(candidate["verification"]["imageIds"]),
            "checks": ["runtime", "production-stack", "browser-smoke"], "workflowRunId": run_id}


def package(root, candidate, verification, image_archive, destination):
    validate_manifest(candidate, require_verification=False)
    require(repository_commit(root) == candidate["commit"], "PACKAGE_SOURCE_CHANGED")
    require(migrations(root) == candidate["migrations"], "PACKAGE_MIGRATIONS_CHANGED")
    verify_048_payload(root, candidate)
    manifest = copy.deepcopy(candidate); manifest["verification"] = verification
    validate_manifest(manifest)
    require(image_archive.is_file() and not image_archive.is_symlink() and image_archive.stat().st_size > 0, "IMAGE_ARCHIVE_REQUIRED")
    require(not destination.exists() and destination.is_absolute(), "NEW_ABSOLUTE_PACKAGE_DIRECTORY_REQUIRED")
    destination.mkdir()
    shutil.copyfile(image_archive, destination / "images.tar.gz")
    # Runtime files are a fixed public allowlist, not git archive or an output tree.
    for relative in PACKAGE_FILES:
        source = root / relative
        require(source.is_file() and not source.is_symlink(), "PUBLIC_RELEASE_TOOL_MISSING")
        target = destination / relative; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    manifest["files"] = [{"path": path.relative_to(destination).as_posix(), "sha256": digest_file(path), "bytes": path.stat().st_size}
                         for path in sorted(destination.rglob("*")) if path.is_file()]
    write_new_json(destination / "release-manifest.json", manifest, 0o644)
    rows = [(path.relative_to(destination).as_posix(), digest_file(path)) for path in sorted(destination.rglob("*")) if path.is_file()]
    with (destination / "SHA256SUMS").open("x", encoding="utf-8", newline="\n") as output:
        output.write("".join(f"{sha}  {path}\n" for path, sha in rows))
    verify_package(destination)
    verify_048_payload(destination, manifest)
    archive = destination.with_suffix(destination.suffix + ".tar")
    require(not archive.exists(), "PACKAGE_ARCHIVE_ALREADY_EXISTS")
    with tarfile.open(archive, "x") as tar:
        for path in sorted(destination.rglob("*")):
            info = tar.gettarinfo(str(path), arcname=path.relative_to(destination).as_posix())
            info.uid = info.gid = 0; info.uname = info.gname = "root"; info.mtime = 0
            info.mode = 0o755 if path.is_dir() else 0o644
            if path.is_dir(): tar.addfile(info)
            else:
                with path.open("rb") as stream: tar.addfile(info, stream)
    with archive.open("rb") as stream: archive_hash = hashlib.file_digest(stream, "sha256").hexdigest()
    with Path(str(archive) + ".sha256").open("x", encoding="utf-8", newline="\n") as output:
        output.write(f"{archive_hash}  {archive.name}\n")
    return {"archive": str(archive), "sha256": archive_hash, "commit": candidate["commit"], "platform": candidate["platform"], "imagesRebuilt": False}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    create = sub.add_parser("candidate")
    for item in ["repository", "version", "commit", "platform", "api-inspect", "web-inspect", "api-digest", "web-digest", "workflow-run", "output"]: create.add_argument("--" + item, required=True)
    verify = sub.add_parser("seal-verification")
    for item in ["candidate", "browser-receipt", "workflow-run", "output"]: verify.add_argument("--" + item, required=True)
    pack = sub.add_parser("package")
    for item in ["repository", "candidate", "verification", "images", "output"]: pack.add_argument("--" + item, required=True)
    field = sub.add_parser("field"); field.add_argument("candidate"); field.add_argument("name")
    args = parser.parse_args()
    if args.command == "candidate":
        value = create_candidate(Path(args.repository).resolve(), args.version, args.commit, args.platform, read_json(args.api_inspect), read_json(args.web_inspect), args.api_digest, args.web_digest, args.workflow_run)
        write_new_json(args.output, value)
        print("CANDIDATE_IDENTITY_RECORDED")
    elif args.command == "seal-verification":
        result = seal_verification(read_json(args.candidate), read_json(args.browser_receipt), args.workflow_run)
        write_new_json(args.output, result)
        print("EXACT_IMAGES_VERIFICATION_RECORDED")
    elif args.command == "package":
        print(json.dumps(package(Path(args.repository).resolve(), read_json(args.candidate), read_json(args.verification), Path(args.images), Path(args.output)), separators=(",", ":")))
    elif args.command == "field":
        value = validate_manifest(read_json(args.candidate), require_verification=False)
        for field_name in args.name.split("."):
            require(isinstance(value, dict) and field_name in value, "UNKNOWN_CANDIDATE_FIELD")
            value = value[field_name]
        require(isinstance(value, str), "CANDIDATE_SCALAR_REQUIRED")
        print(value)


if __name__ == "__main__":
    try: main()
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        error = sys.exc_info()[1]
        print("RELEASE_ARTIFACT_REJECTED " + (str(error) if isinstance(error, Rejected) else "INVALID_ARTIFACT_INPUT"), file=sys.stderr)
        sys.exit(1)
