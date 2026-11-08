import copy
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("verify-image-export.py")
spec = importlib.util.spec_from_file_location("verify_image_export", SCRIPT)
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)


def encoded(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest(body):
    return hashlib.sha256(body).hexdigest()


def layer(body):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        info = tarfile.TarInfo("synthetic-file.txt")
        info.size = len(body)
        archive.addfile(info, io.BytesIO(body))
    return output.getvalue()


class Fixture:
    def __init__(self, kind="app", style="legacy", outer_gzip=False):
        self.style, self.outer_gzip = style, outer_gzip
        self.roles = ["api", "web"] if kind == "app" else ["postgres", "redis", "minio", "minio-init", "browser"]
        self.manifest = {"schema": 1, "kind": "canvas-image-release" if kind == "app" else "canvas-stage-smoke-tools", "images": {}}
        self.rows, self.members, self.configs = [], [], []
        self.manifest_raw = self.docker_raw = None
        self.omit_docker = False
        shared = layer(b"shared base layer")
        shared_path = self.add_layer(shared)
        for role in self.roles:
            own = layer(role.encode())
            own_path = self.add_layer(own)
            config = {"architecture": "amd64", "os": "linux", "config": {"Labels": {"synthetic-role": role}},
                      "rootfs": {"type": "layers", "diff_ids": ["sha256:" + digest(shared), "sha256:" + digest(own)]}}
            self.configs.append(config)
            body = encoded(config)
            path = self.config_path(digest(body))
            self.members.append({"name": path, "body": body})
            self.rows.append({"Config": path, "RepoTags": ["synthetic/" + role + ":test"], "Layers": [shared_path, own_path]})
            self.set_expected(role, "sha256:" + digest(body))

    def set_expected(self, role, identity):
        self.manifest["images"][role] = {"id": identity} if self.manifest["kind"] == "canvas-image-release" else identity

    def config_path(self, value):
        return value + ".json" if self.style == "legacy" else "blobs/sha256/" + value

    def add_layer(self, body):
        path = digest(body) + "/layer.tar" if self.style == "legacy" else "blobs/sha256/" + digest(body)
        if not any(row["name"] == path for row in self.members):
            self.members.append({"name": path, "body": body})
        return path

    def member(self, name):
        return next(row for row in self.members if row["name"] == name)

    def replace_config(self, index, value=None, raw=None):
        body = raw if raw is not None else encoded(value)
        old_path = self.rows[index]["Config"]
        new_path = self.config_path(digest(body))
        self.member(old_path).update(name=new_path, body=body)
        self.rows[index]["Config"] = new_path
        self.set_expected(self.roles[index], "sha256:" + digest(body))
        if value is not None:
            self.configs[index] = value

    def add_partial_oci_index(self):
        # One supplemental OCI descriptor is legitimate even for five classic images.
        config = self.rows[0]["Config"]
        body = encoded({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "config": {"digest": "sha256:" + digest(self.member(config)["body"])},
                        "layers": [{"digest": "sha256:" + digest(self.member(path)["body"])} for path in self.rows[0]["Layers"]]})
        self.members.extend([
            {"name": "blobs/sha256/" + digest(body), "body": body},
            {"name": "index.json", "body": encoded({"schemaVersion": 2, "manifests": [{"digest": "sha256:" + digest(body)}]})},
            {"name": "oci-layout", "body": encoded({"imageLayoutVersion": "1.0.0"})},
        ])

    def archive_bytes(self):
        output = io.BytesIO()
        rows = list(self.members)
        if not self.omit_docker:
            rows.append({"name": "manifest.json", "body": self.docker_raw if self.docker_raw is not None else encoded(self.rows)})
        with tarfile.open(fileobj=output, mode="w:gz" if self.outer_gzip else "w", format=tarfile.PAX_FORMAT) as archive:
            for row in rows:
                info = tarfile.TarInfo(row["name"])
                info.type = row.get("type", tarfile.REGTYPE)
                info.linkname = row.get("linkname", "")
                info.size = len(row.get("body", b""))
                archive.addfile(info, io.BytesIO(row.get("body", b"")))
        return output.getvalue()

    def write(self, root):
        archive, manifest = Path(root) / "save.tar", Path(root) / "expected.json"
        archive.write_bytes(self.archive_bytes())
        manifest.write_bytes(self.manifest_raw if self.manifest_raw is not None else encoded(self.manifest))
        return archive, manifest


class VerifyImageExport(unittest.TestCase):
    def verify(self, fixture):
        with tempfile.TemporaryDirectory() as root:
            archive, manifest = fixture.write(root)
            return guard.verify_image_export(archive, manifest)

    def reject(self, fixture, code):
        with self.assertRaisesRegex(guard.Rejected, code):
            self.verify(fixture)

    def test_valid_legacy_and_blob_layouts_for_app_and_tools(self):
        for kind in ["app", "tools"]:
            for style in ["legacy", "blob"]:
                with self.subTest(kind=kind, style=style):
                    fixture = Fixture(kind, style, outer_gzip=style == "blob")
                    result = self.verify(fixture)
                    self.assertEqual(result["status"], "passed")
                    self.assertEqual(result["imageCount"], len(fixture.roles))
                    self.assertEqual(result["layerReferences"], len(fixture.roles) * 2)
                    self.assertEqual(result["uniqueLayers"], len(fixture.roles) + 1)
                    self.assertTrue(result["classicConfigIdsVerified"])
                    self.assertTrue(result["uncompressedDiffIdsVerified"])

    def test_partial_supplemental_oci_index_does_not_override_five_docker_configs(self):
        fixture = Fixture("tools", "blob", True)
        fixture.add_partial_oci_index()
        result = self.verify(fixture)
        self.assertEqual(result["imageCount"], 5)
        self.assertEqual(result["uniqueLayers"], 6)

    def test_index_or_manifest_bytes_cannot_impersonate_image_config(self):
        for value in [{"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": []},
                      {"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json", "config": {}, "layers": []}]:
            fixture = Fixture(style="blob")
            fixture.replace_config(0, value)
            self.reject(fixture, "IMAGE_CONFIG_REQUIRED_NOT_INDEX")

    def test_containerd_target_digest_is_not_the_classic_config_id(self):
        fixture = Fixture("tools", "blob")
        fixture.add_partial_oci_index()
        target_digest = "sha256:" + digest(fixture.member("index.json")["body"])
        fixture.set_expected("postgres", target_digest)
        self.reject(fixture, "CONFIG_ID_SET_MISMATCH")

    def test_compressed_layer_is_rejected_even_when_its_hash_is_in_diff_ids(self):
        for encode in [gzip.compress, lambda value: b"\x28\xb5\x2f\xfd" + value,
                       lambda value: b"\x50\x2a\x4d\x18" + value]:
            fixture = Fixture()
            path = fixture.rows[0]["Layers"][1]
            body = encode(fixture.member(path)["body"])
            fixture.member(path)["body"] = body
            config = copy.deepcopy(fixture.configs[0])
            config["rootfs"]["diff_ids"][1] = "sha256:" + digest(body)
            fixture.replace_config(0, config)
            self.reject(fixture, "COMPRESSED_LAYER_NOT_CLASSIC")

    def test_missing_extra_wrong_and_duplicate_config_sets_are_rejected(self):
        fixture = Fixture(); fixture.rows.pop(); self.reject(fixture, "CONFIG_ID_SET_MISMATCH")
        fixture = Fixture(); fixture.rows.append(copy.deepcopy(fixture.rows[0])); self.reject(fixture, "CONFIG_ID_SET_MISMATCH")
        fixture = Fixture(); fixture.rows[1] = copy.deepcopy(fixture.rows[0]); self.reject(fixture, "DUPLICATE_CONFIG")
        fixture = Fixture(); fixture.set_expected("api", "sha256:" + "f" * 64); self.reject(fixture, "CONFIG_ID_SET_MISMATCH")

    def test_duplicate_expected_ids_missing_roles_and_wrong_role_value_shapes_are_rejected(self):
        fixture = Fixture(); fixture.manifest["images"]["web"] = copy.deepcopy(fixture.manifest["images"]["api"])
        self.reject(fixture, "EXPECTED_IMAGE_IDS_DUPLICATE")
        fixture = Fixture("tools"); del fixture.manifest["images"]["browser"]; self.reject(fixture, "EXPECTED_IMAGE_ROLES")
        fixture = Fixture(); fixture.manifest["images"]["api"] = fixture.manifest["images"]["api"]["id"]
        self.reject(fixture, "EXPECTED_APP_IMAGE_ROW")
        fixture = Fixture("tools"); fixture.manifest["images"]["browser"] = {"id": "sha256:" + "a" * 64}
        self.reject(fixture, "EXPECTED_IMAGE_ID")
        fixture = Fixture(); fixture.manifest["kind"] = []; self.reject(fixture, "EXPECTED_MANIFEST_KIND")

    def test_config_bytes_not_filename_are_hashed_and_bound(self):
        fixture = Fixture(); fixture.member(fixture.rows[0]["Config"])["body"] += b"\n"
        self.reject(fixture, "CONFIG_NAME_DIGEST_MISMATCH")
        fixture = Fixture(); fixture.members.remove(fixture.member(fixture.rows[0]["Config"]))
        self.reject(fixture, "CONFIG_MEMBER_MISSING")

    def test_layer_count_order_and_bytes_must_match_config_diff_ids(self):
        fixture = Fixture(); fixture.rows[0]["Layers"].pop(); self.reject(fixture, "LAYER_COUNT_MISMATCH")
        fixture = Fixture(); fixture.rows[0]["Layers"].reverse(); self.reject(fixture, "LAYER_DIFF_ID_MISMATCH")
        fixture = Fixture(); fixture.member(fixture.rows[0]["Layers"][1])["body"] += b"changed"
        self.reject(fixture, "LAYER_DIFF_ID_MISMATCH")
        fixture = Fixture(); fixture.members.remove(fixture.member(fixture.rows[0]["Layers"][1]))
        self.reject(fixture, "LAYER_MEMBER_MISSING")

    def test_blob_layer_name_must_match_its_actual_digest(self):
        fixture = Fixture(style="blob")
        old = fixture.rows[0]["Layers"][1]
        new = "blobs/sha256/" + "a" * 64
        fixture.member(old)["name"] = new
        fixture.rows[0]["Layers"][1] = new
        self.reject(fixture, "LAYER_NAME_DIGEST_MISMATCH")

    def test_rootfs_shape_and_diff_id_format_are_required(self):
        for rootfs in [None, {}, {"type": "not-layers", "diff_ids": []}, {"type": "layers", "diff_ids": "wrong"}]:
            fixture = Fixture(); config = copy.deepcopy(fixture.configs[0]); config["rootfs"] = rootfs
            fixture.replace_config(0, config); self.reject(fixture, "CONFIG_ROOTFS_REQUIRED")
        fixture = Fixture(); config = copy.deepcopy(fixture.configs[0]); config["rootfs"]["diff_ids"][0] = "sha256:bad"
        fixture.replace_config(0, config); self.reject(fixture, "ROOTFS_DIFF_ID_INVALID")

    def test_shared_and_repeated_identical_layers_are_valid_when_order_matches(self):
        fixture = Fixture()
        fixture.rows[0]["Layers"] = [fixture.rows[0]["Layers"][0]] * 2
        config = copy.deepcopy(fixture.configs[0]); config["rootfs"]["diff_ids"] = [config["rootfs"]["diff_ids"][0]] * 2
        fixture.replace_config(0, config)
        self.assertEqual(self.verify(fixture)["layerReferences"], 4)

    def test_duplicate_tar_members_and_regular_parent_collisions_are_rejected(self):
        fixture = Fixture(); fixture.members.append(copy.deepcopy(fixture.members[0])); self.reject(fixture, "DUPLICATE_ARCHIVE_PATH")
        fixture = Fixture(); fixture.members.append({"name": "manifest.json", "body": b"[]"}); self.reject(fixture, "DUPLICATE_ARCHIVE_PATH")
        fixture = Fixture(style="blob"); fixture.members.append({"name": "blobs", "body": b"wrong"}); self.reject(fixture, "ARCHIVE_PATH_COLLISION")
        fixture = Fixture(); fixture.members.extend([{"name": "safe/", "type": tarfile.DIRTYPE}, {"name": "safe", "body": b"wrong"}])
        self.reject(fixture, "DUPLICATE_ARCHIVE_PATH")

    def test_safe_directories_are_allowed_but_outer_links_and_special_members_are_not(self):
        fixture = Fixture(style="blob")
        fixture.members.extend([{"name": "blobs/", "type": tarfile.DIRTYPE}, {"name": "blobs/sha256/", "type": tarfile.DIRTYPE}])
        self.assertEqual(self.verify(fixture)["status"], "passed")
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE]:
            fixture = Fixture(); fixture.members.append({"name": "unsafe", "type": kind, "linkname": "target" if kind in (tarfile.SYMTYPE, tarfile.LNKTYPE) else ""})
            self.reject(fixture, "NON_REGULAR_ARCHIVE_MEMBER")

    def test_unsafe_member_and_reference_paths_are_rejected(self):
        for name in ["../escape", "/absolute", "x//y", "x/./y", "C:/drive", "x\\y", "x\ny"]:
            fixture = Fixture(); fixture.members.append({"name": name, "body": b"unused"})
            self.reject(fixture, "UNSAFE_ARCHIVE_PATH")
        for name in ["../escape", "x\x00y", "/absolute"]:
            fixture = Fixture(); fixture.rows[0]["Config"] = name; self.reject(fixture, "UNSAFE_ARCHIVE_PATH")
            fixture = Fixture(); fixture.rows[0]["Layers"][0] = name; self.reject(fixture, "UNSAFE_ARCHIVE_PATH")

    def test_manifest_config_and_member_inventory_have_explicit_bounds(self):
        fixture = Fixture()
        with patch.object(guard, "MANIFEST_MAX_BYTES", 8): self.reject(fixture, "EXPECTED_MANIFEST_SIZE")
        with patch.object(guard, "CONFIG_MAX_BYTES", 8): self.reject(fixture, "CONFIG_SIZE")
        with patch.object(guard, "MAX_MEMBERS", 1): self.reject(fixture, "ARCHIVE_MEMBER_LIMIT")
        fixture.docker_raw = b" " * 1024
        with patch.object(guard, "MANIFEST_MAX_BYTES", 512): self.reject(fixture, "DOCKER_MANIFEST_SIZE")

    def test_duplicate_json_keys_are_rejected_in_every_manifest_and_config(self):
        fixture = Fixture(); fixture.manifest_raw = b'{"schema":1,"schema":1}'
        self.reject(fixture, "JSON_DUPLICATE_KEY")
        fixture = Fixture(); fixture.docker_raw = b'[{"Config":"a","Config":"b"}]'
        self.reject(fixture, "JSON_DUPLICATE_KEY")
        fixture = Fixture(); fixture.replace_config(0, raw=b'{"rootfs":{},"rootfs":{}}')
        self.reject(fixture, "JSON_DUPLICATE_KEY")

    def test_missing_malformed_and_truncated_archives_fail_closed(self):
        fixture = Fixture(); fixture.omit_docker = True; self.reject(fixture, "DOCKER_MANIFEST_REQUIRED")
        fixture = Fixture(); fixture.docker_raw = b"{"; self.reject(fixture, "JSON_INVALID")
        with tempfile.TemporaryDirectory() as root:
            archive, manifest = Fixture().write(root)
            for body in [b"not a tar", archive.read_bytes()[:1024]]:
                archive.write_bytes(body)
                with self.assertRaisesRegex(guard.Rejected, "ARCHIVE_UNREADABLE"):
                    guard.verify_image_export(archive, manifest)

    def test_non_seekable_nested_stream_is_supported_and_caller_stream_stays_open(self):
        class NonSeekable(io.BytesIO):
            def seek(self, *args):
                raise AssertionError("stream must not seek")
        for outer_gzip in [False, True]:
            fixture = Fixture("tools", "blob", outer_gzip)
            with tempfile.TemporaryDirectory() as root:
                _, manifest = fixture.write(root)
                source = NonSeekable(fixture.archive_bytes())
                result = guard.verify_archive_stream(source, guard.expected_images(manifest))
                self.assertEqual(result["imageCount"], 5)
                self.assertFalse(source.closed)
                source.close()

    def test_layers_are_read_in_bounded_chunks_without_extracting(self):
        fixture = Fixture()
        path = fixture.rows[0]["Layers"][1]
        body = layer(b"large synthetic layer\n" * 120000)
        fixture.member(path)["body"] = body
        config = copy.deepcopy(fixture.configs[0]); config["rootfs"]["diff_ids"][1] = "sha256:" + digest(body)
        fixture.replace_config(0, config)
        sizes = []
        original = tarfile.ExFileObject.read
        def bounded(stream, size=-1):
            self.assertGreater(size, 0); self.assertLessEqual(size, guard.READ_BYTES)
            result = original(stream, size); sizes.append(len(result)); return result
        with patch.object(tarfile.ExFileObject, "read", bounded), \
                patch.object(tarfile.TarFile, "extract", side_effect=AssertionError("no extraction")), \
                patch.object(tarfile.TarFile, "extractall", side_effect=AssertionError("no extraction")):
            self.assertEqual(self.verify(fixture)["status"], "passed")
        self.assertGreaterEqual(sizes.count(guard.READ_BYTES), 2)

    def test_cli_is_read_only_and_returns_small_success_or_rejection_json(self):
        with tempfile.TemporaryDirectory() as root:
            fixture = Fixture("tools", "blob", True)
            archive, manifest = fixture.write(root)
            before = {path.name: digest(path.read_bytes()) for path in Path(root).iterdir()}
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--archive", str(archive), "--manifest", str(manifest)],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["imageCount"], 5)
            self.assertEqual(before, {path.name: digest(path.read_bytes()) for path in Path(root).iterdir()})
            fixture.rows.reverse(); fixture.rows.pop(); fixture.write(root)
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--archive", str(archive), "--manifest", str(manifest)],
                                    capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stderr), {"status": "rejected", "code": "CONFIG_ID_SET_MISMATCH"})
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
