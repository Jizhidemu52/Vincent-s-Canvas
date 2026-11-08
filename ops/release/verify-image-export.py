#!/usr/bin/env python3
"""CI-only check that a Docker save archive carries the exact classic image IDs.

Read-only, standard library only: no extraction, Docker calls or networking.
The Docker manifest.json is authoritative for the exported image set. An OCI
index may coexist with classic save data and need not list every exported image.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
import zlib


MANIFEST_MAX_BYTES = 4 * 1024 * 1024
CONFIG_MAX_BYTES = 16 * 1024 * 1024
MAX_MEMBERS = 100000
READ_BYTES = 1024 * 1024
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}\Z")
CONFIG_PATH = re.compile(r"(?:([a-f0-9]{64})\.json|blobs/sha256/([a-f0-9]{64}))\Z")
LAYER_PATH = re.compile(r"(?:[a-f0-9]{64}/layer\.tar|blobs/sha256/([a-f0-9]{64}))\Z")
ROLES = {
    "canvas-image-release": {"api", "web"},
    "canvas-stage-smoke-tools": {"postgres", "redis", "minio", "minio-init", "browser"},
}


class Rejected(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "JSON_DUPLICATE_KEY")
        result[key] = value
    return result


def parse_json(body):
    try:
        return json.loads(body.decode("utf-8"), object_pairs_hook=unique_object)
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise Rejected("JSON_INVALID") from None


def regular_file(path):
    require(path.is_file() and not path.is_symlink(), "REGULAR_INPUT_REQUIRED")


def expected_images(path):
    path = Path(path)
    regular_file(path)
    with path.open("rb") as source:
        body = source.read(MANIFEST_MAX_BYTES + 1)
    require(0 < len(body) <= MANIFEST_MAX_BYTES, "EXPECTED_MANIFEST_SIZE")
    value = parse_json(body)
    require(isinstance(value, dict) and type(value.get("schema")) is int
            and value["schema"] == 1 and isinstance(value.get("kind"), str) and value["kind"] in ROLES,
            "EXPECTED_MANIFEST_KIND")
    rows = value.get("images")
    require(isinstance(rows, dict) and set(rows) == ROLES[value["kind"]], "EXPECTED_IMAGE_ROLES")
    result = {}
    for role, row in rows.items():
        if value["kind"] == "canvas-image-release":
            require(isinstance(row, dict), "EXPECTED_APP_IMAGE_ROW")
            identity = row.get("id")
        else:
            identity = row
        require(isinstance(identity, str) and IMAGE_ID.fullmatch(identity), "EXPECTED_IMAGE_ID")
        result[role] = identity
    require(len(set(result.values())) == len(result), "EXPECTED_IMAGE_IDS_DUPLICATE")
    return result


def safe_path(value, directory=False):
    require(isinstance(value, str) and value and len(value) <= 4096
            and not re.search(r"[\\:\x00-\x1f\x7f]", value), "UNSAFE_ARCHIVE_PATH")
    normalized = value[:-1] if directory and value.endswith("/") else value
    require(normalized and not normalized.startswith("/")
            and all(part not in ("", ".", "..") for part in normalized.split("/")), "UNSAFE_ARCHIVE_PATH")
    return normalized


def compressed_layer(prefix):
    return (prefix.startswith(b"\x1f\x8b") or prefix == b"\x28\xb5\x2f\xfd"
            or len(prefix) == 4 and 0x184D2A50 <= int.from_bytes(prefix, "little") <= 0x184D2A5F)


def scan_archive(source, identities):
    """One sequential pass; source may be a non-seekable nested archive stream."""
    config_names = {name for identity in identities for name in
                    (identity[7:] + ".json", "blobs/sha256/" + identity[7:])}
    members, bodies, names = {}, {}, {}
    with tarfile.open(fileobj=source, mode="r|*") as archive:
        for member in archive:
            name = safe_path(member.name, member.isdir())
            require(name not in names, "DUPLICATE_ARCHIVE_PATH")
            require(len(names) < MAX_MEMBERS, "ARCHIVE_MEMBER_LIMIT")
            require(member.isdir() or member.isreg() and not member.issparse(), "NON_REGULAR_ARCHIVE_MEMBER")
            require(not member.linkname and member.size >= 0, "NON_REGULAR_ARCHIVE_MEMBER")
            names[name] = "directory" if member.isdir() else "file"
            if member.isdir():
                require(member.size == 0, "DIRECTORY_HAS_BODY")
                continue
            limit = MANIFEST_MAX_BYTES if name == "manifest.json" else CONFIG_MAX_BYTES if name in config_names else None
            if limit is not None:
                require(0 < member.size <= limit, "DOCKER_MANIFEST_SIZE" if name == "manifest.json" else "CONFIG_SIZE")
            digest, total, prefix, retained = hashlib.sha256(), 0, b"", []
            stream = archive.extractfile(member)
            require(stream is not None, "REGULAR_MEMBER_UNREADABLE")
            with stream:
                for block in iter(lambda: stream.read(READ_BYTES), b""):
                    if len(prefix) < 4:
                        prefix = (prefix + block)[:4]
                    total += len(block)
                    require(total <= member.size, "MEMBER_SIZE_MISMATCH")
                    digest.update(block)
                    if limit is not None:
                        retained.append(block)
            require(total == member.size, "MEMBER_SIZE_MISMATCH")
            members[name] = {"sha256": digest.hexdigest(), "bytes": total, "prefix": prefix}
            if limit is not None:
                bodies[name] = b"".join(retained)
    for name in names:
        parts = name.split("/")
        require(all(names.get("/".join(parts[:end])) != "file" for end in range(1, len(parts))),
                "ARCHIVE_PATH_COLLISION")
    return members, bodies


def verify_archive_stream(source, expected):
    """Verify a read-only stream with the role/ID mapping from expected_images().

    Does not seek or close source, so callers can pass a nested tar/ZIP member
    directly without materializing another multi-gigabyte copy on disk.
    """
    require(isinstance(expected, dict) and set(expected) in ROLES.values()
            and all(isinstance(value, str) and IMAGE_ID.fullmatch(value) for value in expected.values())
            and len(set(expected.values())) == len(expected), "EXPECTED_IMAGE_IDS")
    try:
        members, bodies = scan_archive(source, set(expected.values()))
    except (OSError, tarfile.TarError, EOFError, zlib.error):
        raise Rejected("ARCHIVE_UNREADABLE") from None
    require("manifest.json" in bodies, "DOCKER_MANIFEST_REQUIRED")
    rows = parse_json(bodies["manifest.json"])
    require(isinstance(rows, list) and len(rows) == len(expected), "CONFIG_ID_SET_MISMATCH")
    configurations, seen_ids, seen_paths = [], set(), set()
    for row in rows:
        require(isinstance(row, dict), "DOCKER_MANIFEST_ROW")
        path = safe_path(row.get("Config"))
        match = CONFIG_PATH.fullmatch(path)
        require(match is not None, "CONFIG_PATH_FORMAT")
        require(path in members, "CONFIG_MEMBER_MISSING")
        require(0 < members[path]["bytes"] <= CONFIG_MAX_BYTES, "CONFIG_SIZE")
        digest = members[path]["sha256"]
        require(digest == next(part for part in match.groups() if part is not None), "CONFIG_NAME_DIGEST_MISMATCH")
        identity = "sha256:" + digest
        require(path not in seen_paths and identity not in seen_ids, "DUPLICATE_CONFIG")
        seen_paths.add(path)
        seen_ids.add(identity)
        configurations.append((row, path))
    require(seen_ids == set(expected.values()), "CONFIG_ID_SET_MISMATCH")
    verified_layers, references = set(), 0
    for row, config_path in configurations:
        config = parse_json(bodies[config_path])
        require(isinstance(config, dict) and not any(key in config for key in
                ("manifests", "mediaType", "schemaVersion", "layers")), "IMAGE_CONFIG_REQUIRED_NOT_INDEX")
        rootfs = config.get("rootfs")
        require(isinstance(rootfs, dict) and rootfs.get("type") == "layers"
                and isinstance(rootfs.get("diff_ids"), list), "CONFIG_ROOTFS_REQUIRED")
        diff_ids = rootfs["diff_ids"]
        require(all(isinstance(value, str) and IMAGE_ID.fullmatch(value) for value in diff_ids), "ROOTFS_DIFF_ID_INVALID")
        layers = row.get("Layers")
        require(isinstance(layers, list) and len(layers) == len(diff_ids), "LAYER_COUNT_MISMATCH")
        for layer_path, diff_id in zip(layers, diff_ids):
            layer_path = safe_path(layer_path)
            match = LAYER_PATH.fullmatch(layer_path)
            require(match is not None, "LAYER_PATH_FORMAT")
            require(layer_path in members, "LAYER_MEMBER_MISSING")
            layer = members[layer_path]
            require(not compressed_layer(layer["prefix"]), "COMPRESSED_LAYER_NOT_CLASSIC")
            require("sha256:" + layer["sha256"] == diff_id, "LAYER_DIFF_ID_MISMATCH")
            if match.group(1) is not None:
                require(match.group(1) == layer["sha256"], "LAYER_NAME_DIGEST_MISMATCH")
            verified_layers.add(layer_path)
            references += 1
    return {"status": "passed", "images": expected,
            "imageCount": len(seen_ids), "layerReferences": references,
            "uniqueLayers": len(verified_layers), "classicConfigIdsVerified": True,
            "uncompressedDiffIdsVerified": True}


def verify_image_export(archive_path, manifest_path):
    expected = expected_images(manifest_path)
    archive_path = Path(archive_path)
    regular_file(archive_path)
    with archive_path.open("rb") as source:
        return verify_archive_stream(source, expected)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, help="Docker save tar or gzip-compressed save tar")
    parser.add_argument("--manifest", required=True, help="APP release-manifest.json or TOOLS stage-tools-manifest.json")
    args = parser.parse_args(argv)
    try:
        result = verify_image_export(args.archive, args.manifest)
    except Rejected as error:
        print(json.dumps({"status": "rejected", "code": str(error)}, separators=(",", ":")), file=sys.stderr)
        return 1
    except OSError:
        print('{"status":"rejected","code":"INPUT_UNREADABLE"}', file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
