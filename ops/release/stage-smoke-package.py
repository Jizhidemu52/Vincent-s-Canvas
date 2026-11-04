#!/usr/bin/env python3
"""CI-only packaging of already-used infrastructure plus a browser tool image."""
import argparse
import importlib.util
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

spec = importlib.util.spec_from_file_location("stage_smoke", str(Path(__file__).with_name("stage-smoke.py")))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)


def validate_infra(receipt, release):
    stage.require(receipt.get("schema") == 1 and receipt.get("commit") == release["commit"] and receipt.get("platform") == release["platform"]
                  and re.fullmatch(r"ci-release-\d+-\d+-amd64", receipt.get("project", "")), "SAME_CI_STACK_INFRASTRUCTURE_REQUIRED")
    stage.require(set(receipt.get("imageIds", {})) == {"postgres", "redis", "minio", "minio-init"}
                  and all(re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in receipt["imageIds"].values()), "EXACT_CI_INFRASTRUCTURE_IMAGE_IDS_REQUIRED")
    stage.require(receipt["project"].split("-")[2] == str(release["verification"]["workflowRunId"]), "INFRASTRUCTURE_WORKFLOW_MISMATCH")


def package(repository, release_root, receipt_path, runner, destination):
    release = stage.validate_release(stage.read_json(release_root / "release-manifest.json"))
    stage.verify_files(release_root, release)
    infra = stage.read_json(receipt_path)
    validate_infra(infra, release)
    # Source must still be the frozen release; only public files are copied.
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=str(repository)).decode().strip()
    dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=all"], cwd=str(repository)).decode().strip()
    stage.require(commit == release["commit"] and not dirty, "CLEAN_MATCHING_TOOL_SOURCE_REQUIRED")
    images = dict(infra["imageIds"], browser=runner)
    state = {"commit": release["commit"], "images": images}
    for role, identity in images.items():
        stage.require(re.fullmatch(r"sha256:[a-f0-9]{64}", identity), "IMAGE_IDS_NOT_TAGS_REQUIRED")
        stage.assert_image(stage.docker_json("image", "inspect", identity)[0], state, role)
    destination.mkdir(mode=0o700)
    (destination / "scripts").mkdir()
    for filename in stage.SCRIPT_FILES:
        source = repository / "server/tests/production-smoke" / filename
        stage.require(source.is_file() and not source.is_symlink(), "PUBLIC_SMOKE_SOURCE_REQUIRED")
        shutil.copyfile(str(source), str(destination / "scripts" / filename))
    for filename in ("stage-smoke.py", "stage-smoke-README.md"):
        shutil.copyfile(str(repository / "ops/release" / filename), str(destination / filename))
    archive = destination / "stage-images.tar"
    stage.command(["docker", "image", "save", "-o", str(archive)] + sorted(set(images.values())))
    manifest = {"schema": 1, "kind": "canvas-stage-smoke-tools", "commit": release["commit"], "platform": release["platform"],
                "workflowRunId": release["verification"]["workflowRunId"], "images": images,
                "infraReceiptSha256": stage.digest(receipt_path), "files": []}
    manifest["files"] = [{"path": path.relative_to(destination).as_posix(), "sha256": stage.digest(path), "bytes": path.stat().st_size}
                         for path in sorted(destination.rglob("*")) if path.is_file()]
    stage.write_json(destination / "stage-tools-manifest.json", manifest)
    rows = [(path.relative_to(destination).as_posix(), stage.digest(path)) for path in sorted(destination.rglob("*")) if path.is_file()]
    stage.write_new(destination / "SHA256SUMS", "".join(value + "  " + name + "\n" for name, value in rows))
    package_file = destination.with_suffix(".tar")
    stage.require(not package_file.exists(), "NEW_STAGE_ARCHIVE_REQUIRED")
    with tarfile.open(str(package_file), "x") as output:
        for path in sorted(destination.rglob("*")):
            info = output.gettarinfo(str(path), arcname=path.relative_to(destination).as_posix())
            info.uid = info.gid = 0
            info.uname = info.gname = "root"
            info.mtime = 0
            info.mode = 0o755 if path.is_dir() else 0o644
            if path.is_file():
                with path.open("rb") as source:
                    output.addfile(info, source)
            else:
                output.addfile(info)
    stage.write_new(Path(str(package_file) + ".sha256"), stage.digest(package_file) + "  " + package_file.name + "\n")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("repository", "release", "infra-receipt", "runner-image-id", "output"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    package(stage.absolute_directory(args.repository), stage.absolute_directory(args.release), Path(args.infra_receipt), args.runner_image_id, stage.absolute_directory(args.output, False))


if __name__ == "__main__":
    main()
