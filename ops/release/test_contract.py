"""Offline behavioral tests. No Docker, production files, network or model calls."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).with_name("contract.py")
spec = importlib.util.spec_from_file_location("canvas_release_contract", MODULE)
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)

SHA = "a" * 40
API_ID = "sha256:" + "b" * 64
WEB_ID = "sha256:" + "c" * 64


def manifest():
    return {
        "schema": 1, "kind": "canvas-image-release", "version": "v0.6.0", "commit": SHA,
        "platform": "linux/amd64", "images": {
            "api": {"reference": "canvas-release-api:" + SHA + "-amd64", "id": API_ID,
                    "digest": "ghcr.io/example/canvas-api@sha256:" + "d" * 64},
            "web": {"reference": "canvas-release-web:" + SHA + "-amd64", "id": WEB_ID,
                    "digest": "ghcr.io/example/canvas@sha256:" + "e" * 64}},
        "migrations": [{"name": "001_schema.sql", "sha256": "f" * 64}],
        "verification": {"status": "passed", "commit": SHA, "platform": "linux/amd64",
                         "imageIds": {"api": API_ID, "web": WEB_ID},
                         "checks": ["runtime", "production-stack", "browser-smoke"],
                         "workflowRunId": "123"},
    }


def inspect(name, image, service):
    return {"Id": "1" * 64, "Name": "/" + name, "Image": image,
            "Config": {"Env": ["DATABASE_URL=postgres://secret", "TASK_MOCK_MODE=false"],
                       "Labels": {"com.docker.compose.project": "canvas-prod",
                                  "com.docker.compose.service": service}},
            "HostConfig": {"NetworkMode": "canvas-prod_default", "PortBindings": {}},
            "Mounts": [], "NetworkSettings": {"Networks": {"canvas-prod_default": {"NetworkID": "2" * 64}}},
            "State": {"Running": True, "Restarting": False, "Paused": False, "StartedAt": "2026-11-01"},
            "RestartCount": 0}


def mounts():
    return [{"Type": "volume", "Name": "fixture-data", "Source": "/var/lib/docker/volumes/fixture-data/_data",
             "Destination": "/data", "Driver": "local", "Mode": "z", "RW": True, "Propagation": ""},
            {"Type": "bind", "Source": "/srv/canvas/config", "Destination": "/config",
             "Mode": "ro", "RW": False, "Propagation": "rprivate"}]


def instance():
    return {"schema": 1, "kind": "canvas-deployment-instance", "name": "canvas-prod",
            "project": "canvas-prod", "root": "/srv/canvas",
            "composeFiles": ["/srv/canvas/runtime.yml", "/srv/canvas/release.yml"],
            "environmentFile": "/srv/canvas/.env", "auditRoot": "/srv/canvas/backups",
            "stateRoot": "/srv/canvas/deploy-state", "network": "canvas-prod_default",
            "localBaseUrl": "http://127.0.0.1:3000", "publicBaseUrl": "https://canvas.example.invalid",
            "containers": {"api": "canvas-prod-api-1", "worker": "canvas-prod-worker-1", "web": "wireless-canvas-web"},
            "database": {"container": "canvas-prod-postgres-1", "user": "canvas", "name": "canvas"},
            "protectedContainers": ["canvas-prod-postgres-1", "canvas-prod-redis-1", "canvas-prod-minio-1", "newvcan-api-1"],
            "expectedVolumes": {"canvas-prod-postgres-1": [{"name": "real-pg", "destination": "/var/lib/postgresql/data"}],
                                "canvas-prod-redis-1": [{"name": "real-redis", "destination": "/data"}],
                                "canvas-prod-minio-1": [{"name": "real-minio", "destination": "/data"}]},
            "retainedMigrationNames": ["000_historical.sql"],
            "retiredCodeMounts": {"api": [], "worker": [], "web": []},
            "gate": {"command": "/srv/canvas/gate.sh", "sha256": "9" * 64},
            "minimumFreeBytes": 1073741824}


def compose():
    return {"name": "canvas-prod", "services": {
        "api": {"image": "old-api", "environment": {"TASK_MOCK_MODE": "false", "DATABASE_URL": "postgres://secret"},
                "volumes": [], "networks": {"default": None}},
        "worker": {"image": "old-api", "command": ["bun", "src/worker.ts"],
                   "environment": {"TASK_MOCK_MODE": "false", "DATABASE_URL": "postgres://secret"}, "volumes": [], "networks": {"default": None}},
        "web": {"image": "old-web", "container_name": "wireless-canvas-web", "volumes": [],
                "ports": [{"target": 3000, "published": "3000", "protocol": "tcp"}], "networks": {"default": None}},
        "postgres": {"image": "postgres-old", "volumes": [{"type": "volume", "source": "pg", "target": "/var/lib/postgresql/data"}]}},
        "volumes": {"pg": {"name": "real-pg"}}, "networks": {"default": {"name": "canvas-prod_default"}}}


class ManifestTests(unittest.TestCase):
    def test_accepts_only_tested_exact_images(self):
        self.assertEqual(contract.validate_manifest(manifest())["commit"], SHA)
        for mutate in [lambda m: m["verification"]["imageIds"].update(api=WEB_ID),
                       lambda m: m.update(commit="main"),
                       lambda m: m["images"]["api"].update(reference="canvas-api:latest"),
                       lambda m: m["verification"].update(checks=["runtime"]),
                       lambda m: m["migrations"].append(m["migrations"][0])]:
            value = manifest(); mutate(value)
            with self.assertRaises(contract.Rejected): contract.validate_manifest(value)

    def test_public_manifest_rejects_unknown_secret_fields(self):
        value = manifest(); value["DATABASE_URL"] = "postgres://secret"
        with self.assertRaises(contract.Rejected): contract.validate_manifest(value)

    def test_zero_migration_compares_exact_retained_names(self):
        expected = ["000_historical.sql", "001_schema.sql"]
        contract.assert_migrations(expected, manifest(), instance())
        for actual in [expected[:-1], expected + ["002_unapproved.sql"], expected + [expected[0]]]:
            with self.assertRaises(contract.Rejected): contract.assert_migrations(actual, manifest(), instance())

    def test_inspected_image_requires_matching_labels_id_and_platform(self):
        image = {"Id": API_ID, "Os": "linux", "Architecture": "amd64", "Config": {"Labels": {
            "org.opencontainers.image.revision": SHA, "org.opencontainers.image.version": "v0.6.0"}}, "RepoDigests": []}
        contract.assert_image(image, manifest(), "api")
        for key, value in [("Id", WEB_ID), ("Architecture", "arm64")]:
            changed = copy.deepcopy(image); changed[key] = value
            with self.assertRaises(contract.Rejected): contract.assert_image(changed, manifest(), "api")


class DeploymentTests(unittest.TestCase):
    def test_stable_container_sorts_full_mount_copies_without_deduplicating_or_mutating_input(self):
        row = inspect("newvcan-api-1", "old", "api")
        row["Mounts"] = mounts()
        row["Mounts"][0]["Extra"] = {"options": ["z", "a"]}
        row["Mounts"].append(copy.deepcopy(row["Mounts"][0]))
        row["HostConfig"]["Binds"] = ["z:/z", "a:/a"]
        row["NetworkSettings"]["Networks"]["canvas-prod_default"]["Aliases"] = ["z", "a"]
        original = copy.deepcopy(row)
        reordered = copy.deepcopy(row)
        reordered["Mounts"] = reordered["Mounts"][1:] + reordered["Mounts"][:1]
        result = contract.stable_container(row)
        self.assertEqual(result, contract.stable_container(reordered))
        self.assertEqual(result["Mounts"], sorted(original["Mounts"], key=contract.canonical))
        self.assertEqual(len(result["Mounts"]), 3)
        self.assertEqual(result["Mounts"].count(original["Mounts"][0]), 2)
        self.assertEqual(result["Config"]["Env"], original["Config"]["Env"])
        self.assertEqual(result["HostConfig"]["Binds"], original["HostConfig"]["Binds"])
        self.assertEqual(result["networks"]["canvas-prod_default"]["Aliases"], ["z", "a"])
        self.assertEqual(row, original)
        result["Mounts"][1]["Extra"]["options"].append("copy-only")
        self.assertEqual(row, original)

    def test_mount_normalization_does_not_normalize_other_array_order(self):
        row = inspect("newvcan-api-1", "old", "api")
        row["Mounts"] = mounts()
        row["HostConfig"]["Binds"] = ["z:/z", "a:/a"]
        row["NetworkSettings"]["Networks"]["canvas-prod_default"]["Aliases"] = ["z", "a"]
        for path in [("Config", "Env"), ("HostConfig", "Binds"),
                     ("NetworkSettings", "Networks", "canvas-prod_default", "Aliases")]:
            with self.subTest(path=path):
                changed = copy.deepcopy(row); values = changed
                for key in path: values = values[key]
                values.reverse()
                self.assertNotEqual(contract.stable_container(row), contract.stable_container(changed))

    def test_protected_mount_reordering_passes_but_every_field_and_multiplicity_remain_guarded(self):
        row = inspect("newvcan-api-1", "old", "api"); row["Mounts"] = mounts()
        reordered = copy.deepcopy(row); reordered["Mounts"].reverse()
        contract.assert_protected([row], [reordered], instance())
        for field, value in [("Type", "bind"), ("Name", "changed"), ("Source", "/other"),
                             ("Destination", "/other"), ("Driver", "other"), ("Mode", "ro"),
                             ("RW", False), ("Propagation", "rprivate"), ("Extra", {"changed": True})]:
            with self.subTest(field=field):
                changed = copy.deepcopy(row); changed["Mounts"][0][field] = value
                with self.assertRaisesRegex(contract.Rejected, "PROTECTED_INFRASTRUCTURE_CHANGED"):
                    contract.assert_protected([row], [changed], instance())
        for values in [row["Mounts"][:-1], row["Mounts"] + [row["Mounts"][0]],
                       row["Mounts"] + [{"Type": "bind", "Source": "/new", "Destination": "/new", "RW": False}]]:
            with self.subTest(mounts=values):
                changed = copy.deepcopy(row); changed["Mounts"] = copy.deepcopy(values)
                with self.assertRaisesRegex(contract.Rejected, "PROTECTED_INFRASTRUCTURE_CHANGED"):
                    contract.assert_protected([row], [changed], instance())

    def test_project_directory_defaults_to_root_but_may_explicitly_select_inner_compose_base(self):
        contract.validate_instance(instance())
        for directory in ["/srv/canvas", "/srv/canvas/current"]:
            value = instance(); value["projectDirectory"] = directory
            self.assertEqual(contract.validate_instance(value)["projectDirectory"], directory)
        for directory in ["/srv/elsewhere", "/srv/canvas/../elsewhere", "/srv/canvas-other"]:
            value = instance(); value["projectDirectory"] = directory
            with self.assertRaises(contract.Rejected): contract.validate_instance(value)

    def test_container_names_normalize_one_leading_slash_without_new_python_apis(self):
        self.assertIn("canvas-api", contract.container_map([{"Name": "/canvas-api"}]))
        self.assertIn("canvas-api", contract.container_map([{"Name": "canvas-api"}]))
        with self.assertRaises(contract.Rejected): contract.container_map([{"Name": "//canvas-api"}])

    def test_live_unmanaged_env_and_mount_drift_cannot_be_dropped_silently(self):
        row = inspect("api", "old", "api")
        image = {"Config": {"Env": []}}
        service = compose()["services"]["api"]
        contract.assert_configured_environment(row, image, service)
        row["Config"]["Env"].append("UNMANAGED_PRIVATE_KEY=preserve-me")
        with self.assertRaises(contract.Rejected): contract.assert_configured_environment(row, image, service)
        row["Mounts"] = [{"Type": "bind", "Destination": "/app/src", "Source": "/unexpected", "RW": False}]
        with self.assertRaises(contract.Rejected): contract.assert_mounts(row, service, compose())
    def test_instance_has_no_implicit_production_target_or_credentials(self):
        contract.validate_instance(instance())
        for field, value in [("root", "/"), ("project", "newvcan"), ("environmentFile", "../.env"),
                             ("publicBaseUrl", "https://user:password@example.invalid")]:
            item = instance(); item[field] = value
            with self.assertRaises(contract.Rejected): contract.validate_instance(item)

    def test_candidate_preserves_infrastructure_env_port_network_and_custom_web_name(self):
        old = compose()
        new = contract.candidate_compose(old, manifest(), instance(), "/srv/canvas/backups/deploy-123/previous-public/assets")
        self.assertEqual(new["services"]["api"]["image"], manifest()["images"]["api"]["reference"])
        self.assertEqual(new["services"]["api"]["command"], ["bun", "src/index.ts"])
        self.assertEqual(new["services"]["worker"]["command"], ["bun", "src/worker.ts"])
        self.assertEqual(new["services"]["postgres"], old["services"]["postgres"])
        self.assertEqual(new["services"]["web"]["container_name"], "wireless-canvas-web")
        for role in ["api", "worker"]: self.assertEqual(new["services"][role]["environment"], old["services"][role]["environment"])
        self.assertEqual(new["networks"], old["networks"])
        self.assertEqual(new["volumes"], old["volumes"])
        self.assertEqual(old, compose())
        self.assertEqual(new["services"]["web"]["ports"][0]["host_ip"], "127.0.0.1")

    def test_explicit_existing_http_origin_is_retained_without_implicit_tls(self):
        value = instance(); value["publicBaseUrl"] = "http://canvas.example.invalid"
        self.assertEqual(contract.validate_instance(value)["publicBaseUrl"], "http://canvas.example.invalid")

    def test_loopback_port_change_must_not_change_actual_published_port(self):
        value = compose(); value["services"]["web"]["ports"][0]["published"] = "9999"
        with self.assertRaises(contract.Rejected): contract.candidate_compose(value, manifest(), instance(), "/srv/canvas/backups/deploy-123/previous-public/assets")

    def test_unknown_code_bind_or_writable_reviewed_bind_is_not_removed(self):
        for read_only in [False, True]:
            source = compose(); source["services"]["api"]["volumes"] = [{"type": "bind", "source": "/srv/canvas/old/src", "target": "/app/src", "read_only": read_only}]
            with self.assertRaises(contract.Rejected): contract.candidate_compose(source, manifest(), instance(), "/srv/canvas/backups/deploy-123/previous-public/assets")
        source = compose(); binding = {"type": "bind", "source": "/srv/canvas/old/src", "target": "/app/src", "read_only": True}
        source["services"]["api"]["volumes"] = [binding]
        target = instance(); target["retiredCodeMounts"]["api"] = [{"source": binding["source"], "target": binding["target"]}]
        result = contract.candidate_compose(source, manifest(), target, "/srv/canvas/backups/deploy-123/previous-public/assets")
        self.assertEqual(result["services"]["api"]["volumes"], [])

    def test_parent_bind_and_unexpected_app_service_dependency_refuse_cutover(self):
        for target in ["/app", "/shared", "/usr/share/nginx"]:
            value = compose(); value["services"]["api"]["volumes"] = [{"type": "bind", "source": "/srv/canvas/old", "target": target, "read_only": True}]
            with self.assertRaises(contract.Rejected): contract.candidate_compose(value, manifest(), instance(), "/srv/canvas/backups/deploy-123/previous-public/assets")

    def test_production_mock_mode_is_rejected_even_if_all_tests_passed(self):
        value = compose(); value["services"]["worker"]["environment"]["TASK_MOCK_MODE"] = "true"
        with self.assertRaises(contract.Rejected): contract.candidate_compose(value, manifest(), instance(), "/srv/canvas/backups/deploy-123/previous-public/assets")

    def test_uncertain_stop_or_unknown_database_state_never_allows_restart(self):
        self.assertTrue(contract.can_restore_application({"stopConfirmed": True, "databaseUnchanged": True, "configurationKnown": True, "idle": True}))
        for key in ["stopConfirmed", "databaseUnchanged", "configurationKnown", "idle"]:
            state = {"stopConfirmed": True, "databaseUnchanged": True, "configurationKnown": True, "idle": True}; state[key] = False
            self.assertFalse(contract.can_restore_application(state))
        self.assertFalse(contract.can_restore_application({}))

    def test_static_compatibility_copies_only_regular_fingerprinted_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "source"; destination = Path(temporary) / "dest"; source.mkdir()
            (source / "project-AbCd1234.js").write_bytes(b"approved public chunk")
            (source / "index.html").write_text("never copied")
            (source / "app-AbCd1234.js.map").write_text("never copied")
            (source / ".env").write_text("never copied")
            (source / "settings.json").write_text("never copied")
            rows = contract.prepare_compatibility_assets(source, destination)
            self.assertEqual([row["path"] for row in rows], ["project-AbCd1234.js"])
            self.assertEqual(list(destination.iterdir()), [destination / "project-AbCd1234.js"])
            with self.assertRaises(contract.Rejected): contract.prepare_compatibility_assets(source, destination)

    def test_idle_gate_preserves_paused_tasks_but_rejects_inflight_work(self):
        snapshot = {"waitingTasks": 0, "processingTasks": 0, "submittedWaitingTasks": 0, "processingChatRequests": 0, "processingAnalysisPreviews": 0, "optimizingPromptCompilations": 0, "admittingBatches": 0, "pendingAssetThumbnails": 0, "pausedTasks": 7}
        contract.assert_idle(snapshot)
        snapshot["processingChatRequests"] = 1
        with self.assertRaises(contract.Rejected): contract.assert_idle(snapshot)


if __name__ == "__main__": unittest.main()
