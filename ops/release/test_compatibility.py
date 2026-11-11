"""Offline consecutive-release assets regression; no Docker or network calls."""
import copy
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import time
import unittest
from unittest.mock import patch

import deploy
from test_contract import compose, inspect, instance, manifest
from test_deploy import database_state


class CompatibilityRetentionTests(unittest.TestCase):
    def run_release(self, root, name, old_build, old_compatibility=None, mutate=None):
        runner = deploy.Deployment.__new__(deploy.Deployment)
        runner.instance = instance()
        runner.instance_path = root / (name + "-instance.json")
        runner.instance_path.write_text(json.dumps(runner.instance), encoding="utf-8")
        runner.audit = root / name
        runner.audit.mkdir()
        model = compose()
        planned = copy.deepcopy(runner.instance)
        if old_compatibility is not None:
            logical_source = "/srv/canvas/backups/previous/previous-public/assets"
            mount = {"type": "bind", "source": logical_source,
                     "target": "/opt/canvas/previous-public/assets", "read_only": True}
            model["services"]["web"]["volumes"] = [mount]
            planned["retiredCodeMounts"]["web"] = [
                {"source": mount["source"], "target": mount["target"]}]
        rows = [inspect(target, "old-image", role)
                for role, target in runner.instance["containers"].items()]
        web = rows[-1]
        if old_compatibility is not None:
            web["Mounts"] = [{"Type": "bind", "Source": logical_source,
                              "Destination": "/opt/canvas/previous-public/assets", "RW": False}]
        database = database_state()
        database["migrations"].append({"name": "000_historical.sql"})
        baseline = {"model": model, "containers": rows, "database": database, "configurationHashes": {}}
        if mutate is not None:
            mutate(model, rows, planned)
        package = root / (name + "-package")
        package.mkdir()
        release = manifest()
        (package / "release-manifest.json").write_text(json.dumps(release), encoding="utf-8")
        preflight = root / (name + "-preflight")
        preflight.mkdir()
        deploy.write_new_json(preflight / "preflight.json", {
            "createdAt": time.time(), "instanceSha256": deploy.sha_file(runner.instance_path),
            "manifestSha256": deploy.sha_file(package / "release-manifest.json"),
            "package": str(package), "baseline": baseline})
        commands = []

        def command(arguments, **kwargs):
            commands.append(arguments)
            if arguments[:3] == ["docker", "image", "load"]:
                return b""
            if arguments[:3] == ["docker", "image", "inspect"]:
                role = next(role for role, row in release["images"].items()
                            if row["reference"] == arguments[3])
                return json.dumps([{"Id": release["images"][role]["id"], "Os": "linux",
                    "Architecture": "amd64", "Config": {"Labels": {
                        "org.opencontainers.image.revision": release["commit"],
                        "org.opencontainers.image.version": release["version"]}}}]).encode()
            if arguments[:2] == ["docker", "cp"]:
                container, source = arguments[2].split(":", 1)
                self.assertIn(container, [runner.instance["containers"]["web"], web["Id"]])
                sources = {"/usr/share/nginx/html/assets": old_build,
                           "/opt/canvas/previous-public/assets": old_compatibility}
                self.assertIn(source, sources)
                self.assertIsNotNone(sources[source])
                shutil.copytree(sources[source], arguments[3], symlinks=True)
                return b""
            self.fail("unexpected external command: " + repr(arguments))

        def cutover(current, target, fallback, *args):
            deploy.write_new_json(runner.audit / "containers-started.private.json", rows)
            deploy.write_new_json(runner.audit / "baseline.private.json", baseline)

        runner.command = command
        runner.new_audit = lambda operation: runner.audit
        runner.capture = lambda label: copy.deepcopy(baseline)
        runner.assert_platform = lambda value: None
        runner.planning_instance = lambda current: planned
        runner.compose = lambda *args, **kwargs: b""
        runner.cutover = cutover
        runner.activate = lambda target: None
        original_candidate = deploy.candidate_compose

        def local_candidate(current, release, deployment, destination):
            # Keep the actual Compose contract; only map the Windows temporary
            # output path to the equivalent target-host audit path.
            self.assertEqual(Path(destination), runner.audit / "previous-public/assets")
            return original_candidate(current, release, deployment,
                "/srv/canvas/backups/" + name + "/previous-public/assets")

        with patch.object(deploy, "verify_package", return_value=release), \
                patch.object(deploy, "private_directory", side_effect=Path), \
                patch.object(deploy, "candidate_compose", side_effect=local_candidate):
            self.assertEqual(runner.apply(package, preflight)["status"], "applied")
        return runner.audit / "previous-public/assets", commands

    def test_a_to_b_to_c_retains_a_lazy_chunk_and_b_assets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            build_a = root / "build-a"; build_a.mkdir()
            build_b = root / "build-b"; build_b.mkdir()
            (build_a / "canvas-node-prompt-panel-Cb1XHdyz.js").write_bytes(b"A lazy module")
            (build_b / "index-BbBb1234.js").write_bytes(b"B entry module")
            compatibility_b, commands_b = self.run_release(root, "apply-b", build_a)
            compatibility_c, commands_c = self.run_release(root, "apply-c", build_b, compatibility_b)
            self.assertEqual(sorted(path.name for path in compatibility_c.iterdir()),
                ["canvas-node-prompt-panel-Cb1XHdyz.js", "index-BbBb1234.js"])
            self.assertEqual((compatibility_c / "canvas-node-prompt-panel-Cb1XHdyz.js").read_bytes(), b"A lazy module")
            self.assertEqual((compatibility_b / "canvas-node-prompt-panel-Cb1XHdyz.js").read_bytes(), b"A lazy module")
            self.assertEqual((build_a / "canvas-node-prompt-panel-Cb1XHdyz.js").read_bytes(), b"A lazy module")
            self.assertEqual([args[2] for args in commands_b if args[:2] == ["docker", "cp"]],
                ["1" * 64 + ":/usr/share/nginx/html/assets"])
            self.assertEqual([args[2] for args in commands_c if args[:2] == ["docker", "cp"]],
                ["1" * 64 + ":/usr/share/nginx/html/assets",
                 "1" * 64 + ":/opt/canvas/previous-public/assets"])

    def test_unreviewed_or_changed_compatibility_mounts_refuse_before_copy(self):
        def source_outside_audit(model, rows, planned):
            model["services"]["web"]["volumes"][0]["source"] = "/srv/canvas/private"
            rows[-1]["Mounts"][0]["Source"] = "/srv/canvas/private"
            planned["retiredCodeMounts"]["web"][0]["source"] = "/srv/canvas/private"

        cases = [
            lambda model, rows, planned: planned["retiredCodeMounts"].update(web=[]),
            lambda model, rows, planned: model["services"]["web"]["volumes"][0].update(read_only=False),
            lambda model, rows, planned: rows[-1]["Mounts"][0].update(Source="/srv/canvas/other"),
            lambda model, rows, planned: rows[-1]["Mounts"][0].update(RW=True),
            lambda model, rows, planned: rows[-1]["Config"]["Labels"].update({"com.docker.compose.service": "other"}),
            source_outside_audit,
        ]
        for number, mutate in enumerate(cases):
            with self.subTest(case=number), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                build = root / "build"; build.mkdir()
                retained = root / "retained"; retained.mkdir()
                (build / "index-BbBb1234.js").write_bytes(b"B")
                (retained / "panel-AaAa1234.js").write_bytes(b"A")
                with self.assertRaises(deploy.Rejected):
                    self.run_release(root, "apply-c", build, retained, mutate)
                self.assertFalse((root / "apply-c/previous-public-source").exists())
                self.assertFalse((root / "apply-c/previous-public").exists())


class CompatibilityAssetContracts(unittest.TestCase):
    def test_two_sources_deduplicate_exact_bytes_and_exclude_non_public_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = root / "current"; current.mkdir()
            retained = root / "retained"; retained.mkdir()
            for source in [current, retained]:
                (source / "shared-AbCd1234.js").write_bytes(b"shared")
                for name in ["index.html", "index-AbCd1234.html", "app-AbCd1234.js.map",
                             ".env", "settings-AbCd1234.json", "plain.js"]:
                    (source / name).write_bytes(b"must stay private")
                (source / "nested").mkdir()
                (source / "nested/private-AbCd1234.js").write_bytes(b"not a flat Vite asset")
            (current / "new-BbBb1234.css").write_bytes(b"new")
            (retained / "old-AaAa1234.js").write_bytes(b"old")
            destination = root / "output"
            rows = deploy.prepare_compatibility_assets(current, destination, retained)
            self.assertEqual([row["path"] for row in rows],
                ["new-BbBb1234.css", "old-AaAa1234.js", "shared-AbCd1234.js"])
            self.assertEqual(len(list(destination.iterdir())), 3)
            for row in rows:
                content = (destination / row["path"]).read_bytes()
                self.assertEqual((row["sha256"], row["bytes"]), (deploy.digest(content), len(content)))
            self.assertEqual((retained / ".env").read_bytes(), b"must stay private")
            self.assertEqual((current / "shared-AbCd1234.js").read_bytes(), b"shared")

    def test_conflicting_same_name_refuses_before_creating_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = root / "current"; current.mkdir()
            retained = root / "retained"; retained.mkdir()
            (current / "same-AbCd1234.js").write_bytes(b"new bytes")
            (retained / "same-AbCd1234.js").write_bytes(b"old bytes")
            with self.assertRaisesRegex(deploy.Rejected, "CONFLICTING_FINGERPRINTED_STATIC_ASSET"):
                deploy.prepare_compatibility_assets(current, root / "output", retained)
            self.assertFalse((root / "output").exists())
            self.assertEqual((current / "same-AbCd1234.js").read_bytes(), b"new bytes")
            self.assertEqual((retained / "same-AbCd1234.js").read_bytes(), b"old bytes")

    def test_missing_retained_source_is_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = root / "current"; current.mkdir()
            (current / "index-AbCd1234.js").write_bytes(b"current")
            with self.assertRaisesRegex(deploy.Rejected, "STATIC_COMPATIBILITY_PATH_INVALID"):
                deploy.prepare_compatibility_assets(current, root / "output", root / "missing")
            self.assertFalse((root / "output").exists())

    def test_retained_symlink_refuses_before_publishing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = root / "current"; current.mkdir()
            retained = root / "retained"; retained.mkdir()
            (current / "index-AbCd1234.js").write_bytes(b"current")
            (root / "private.txt").write_bytes(b"private")
            try:
                (retained / "leak-AbCd1234.js").symlink_to(root / "private.txt")
            except OSError as error:
                self.skipTest("local symlink creation unavailable: " + str(error))
            with self.assertRaisesRegex(deploy.Rejected, "LINKED_STATIC_ASSET_REFUSED"):
                deploy.prepare_compatibility_assets(current, root / "output", retained)
            self.assertFalse((root / "output").exists())

    def test_public_asset_modes_are_explicit_despite_private_deployment_umask(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            current = root / "current"; current.mkdir()
            (current / "index-AbCd1234.js").write_bytes(b"public")
            destination = root / "private-parent/assets"
            changes = []
            original_chmod = Path.chmod

            def record_chmod(path, mode, **kwargs):
                changes.append((path, mode))
                original_chmod(path, mode, **kwargs)

            previous_umask = os.umask(0o077)
            try:
                with patch.object(Path, "chmod", record_chmod):
                    deploy.prepare_compatibility_assets(current, destination)
            finally:
                os.umask(previous_umask)
            self.assertEqual(set(changes), {(destination, 0o755), (destination / "index-AbCd1234.js", 0o644)})
            if os.name == "posix":
                self.assertEqual(stat.S_IMODE(destination.stat().st_mode), 0o755)
                self.assertEqual(stat.S_IMODE((destination / "index-AbCd1234.js").stat().st_mode), 0o644)
                self.assertEqual(stat.S_IMODE(destination.parent.stat().st_mode), 0o700)


if __name__ == "__main__": unittest.main()
