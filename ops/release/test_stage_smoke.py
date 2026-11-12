import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("stage_smoke", str(ROOT / "stage-smoke.py"))
stage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(stage)
package_spec = importlib.util.spec_from_file_location("stage_smoke_package", str(ROOT / "stage-smoke-package.py"))
package = importlib.util.module_from_spec(package_spec)
package_spec.loader.exec_module(package)


def state_fixture(directory="/private/stage"):
    return {"schema": 1, "kind": "canvas-isolated-staging", "commit": "a" * 40, "version": "v1.2.3", "platform": "linux/amd64",
            "project": "canvas-staging-" + "a" * 12 + "-" + "b" * 12, "runId": "c" * 32,
            "webPort": 13080, "edgePort": 18080, "directory": directory, "toolsDirectory": "/public/stage-tools",
            "images": {role: "sha256:" + str(index + 1) * 64 for index, role in enumerate(("api", "web") + stage.ROLES)}}


def resources_fixture(state):
    labels = {stage.LABEL: state["runId"], stage.PROJECT_LABEL: state["project"], "com.docker.compose.project": state["project"]}
    network_name = state["project"] + "_default"
    container = {"Id": "1" * 64, "Name": "/" + state["project"] + "-mock-provider-1", "Image": state["images"]["api"],
                 "Config": {"Labels": dict(labels, **{"com.docker.compose.service": "mock-provider"})}, "State": {"Running": True},
                 "HostConfig": {"NetworkMode": network_name, "PortBindings": {}, "PublishAllPorts": False},
                 "NetworkSettings": {"Networks": {network_name: {"NetworkID": "2" * 64}}, "Ports": {"3100/tcp": None}},
                 "Mounts": [{"Type": "bind", "Source": str(Path(state["toolsDirectory"]) / "scripts"), "Destination": "/smoke", "RW": False},
                            {"Type": "tmpfs", "Source": "", "Destination": "/tmp", "RW": True}]}
    volume = {"Name": state["project"] + "_postgres-data", "CreatedAt": "2026-01-01T00:00:00Z", "Labels": labels}
    network = {"Id": "2" * 64, "Name": network_name, "Labels": dict(labels, **{"com.docker.compose.network": "default"}), "Driver": "bridge", "Internal": True, "Containers": {container["Id"]: {}}}
    return {"containers": [container], "volumes": [volume], "networks": [network]}


def web_resources_fixture(state):
    resources = resources_fixture(state)
    web = copy.deepcopy(resources["containers"][0])
    web.update(Id="3" * 64, Name="/" + state["project"] + "-web-1", Image=state["images"]["web"], Mounts=[])
    web["Config"]["Labels"]["com.docker.compose.service"] = "web"
    binding = {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "13080"}]}
    web["HostConfig"]["PortBindings"] = copy.deepcopy(binding)
    web["NetworkSettings"]["Ports"] = copy.deepcopy(binding)
    web["NetworkSettings"]["Networks"][state["project"] + "_ingress"] = {"NetworkID": "4" * 64}
    ingress = copy.deepcopy(resources["networks"][0])
    ingress.update(Id="4" * 64, Name=state["project"] + "_ingress", Internal=False, Containers={web["Id"]: {}})
    ingress["Labels"]["com.docker.compose.network"] = "ingress"
    resources["networks"][0]["Containers"][web["Id"]] = {}
    resources["networks"].append(ingress)
    resources["containers"].append(web)
    return resources


def release_fixture():
    state = state_fixture()
    return {"schema": 1, "kind": "canvas-image-release", "commit": state["commit"], "version": state["version"], "platform": state["platform"],
            "images": {role: {"id": state["images"][role]} for role in ("api", "web")},
            "verification": {"status": "passed", "commit": state["commit"], "platform": state["platform"], "imageIds": {role: state["images"][role] for role in ("api", "web")},
                             "checks": ["runtime", "production-stack", "browser-smoke"], "workflowRunId": "123"}}


class StageIsolationTests(unittest.TestCase):
    def test_compose_uses_only_exact_images_and_isolated_new_data(self):
        state = state_fixture()
        config = stage.stage_compose(state, {"postgres": "synthetic-password", "storage": "synthetic-storage", "encryption": "synthetic-key"}, Path(state["toolsDirectory"]) / "scripts")
        self.assertTrue(config["networks"]["default"]["internal"])
        self.assertEqual(config["networks"]["default"]["name"], state["project"] + "_default")
        self.assertEqual(set(config["networks"]), {"default", "ingress"})
        self.assertEqual(config["networks"]["ingress"], {"name": state["project"] + "_ingress", "internal": False, "labels": {stage.LABEL: state["runId"], stage.PROJECT_LABEL: state["project"]}})
        for name, service in config["services"].items():
            self.assertNotIn("build", service)
            self.assertNotIn("env_file", service)
            self.assertNotIn("container_name", service)
            self.assertEqual(service["pull_policy"], "never")
            self.assertEqual(service["labels"][stage.LABEL], state["runId"])
            networks = ["default", "ingress"] if name == "web" else ["default"]
            if name == "mock-provider": networks = {"default": {"aliases": ["mock-provider.example"]}}
            self.assertEqual(service["networks"], networks)
            self.assertEqual(service["image"], state["images"]["api" if name in ("api", "worker", "mock-provider") else name])
            self.assertEqual(service.get("ports", []), ["127.0.0.1:13080:3000"] if name == "web" else [])
        for volume in config["volumes"].values():
            self.assertEqual(volume, {"labels": {stage.LABEL: state["runId"], stage.PROJECT_LABEL: state["project"]}})
        for name in ("api", "worker"):
            environment = config["services"][name]["environment"]
            self.assertEqual(environment["TASK_MOCK_MODE"], "false")
            self.assertEqual(environment["AUTH_ENABLED"], "true")
            self.assertEqual(environment["CANVAS_SMOKE_MODE"], "staging")
            self.assertIn("@postgres:5432/wireless_canvas", environment["DATABASE_URL"])
        self.assertEqual(config["services"]["api"]["environment"]["HOST"], "0.0.0.0")
        self.assertEqual(config["services"]["api"]["healthcheck"]["test"],
                         ["CMD", "wget", "-q", "-O", "-", "http://127.0.0.1:3100/api/health"])

    def test_production_names_reserved_ports_and_mismatched_commit_are_refused(self):
        for change in ({"project": "vincent-s-canvas"}, {"project": "newvcan-testing"}, {"project": "canvas-staging-" + "d" * 12 + "-" + "b" * 12},
                       {"runId": "not-random"}, {"webPort": 3000}, {"edgePort": 3100}, {"edgePort": 13080}, {"platform": "linux/arm64"}):
            with self.subTest(change=change), self.assertRaises(stage.Rejected):
                stage.validate_identity(dict(state_fixture(), **change))

    def test_nginx_entry_is_standalone_loopback_and_run_bound(self):
        state = state_fixture()
        config = stage.nginx_config(state)
        self.assertEqual(config.count("server {"), 1)
        self.assertIn("listen 127.0.0.1:18080;", config)
        self.assertIn("proxy_pass http://127.0.0.1:13080;", config)
        self.assertIn('add_header X-Canvas-Staging "' + state["runId"] + '" always;', config)
        self.assertIn("client_max_body_size 200m;", config)
        self.assertIn("proxy_buffering off;", config)
        self.assertNotIn("include", config)
        self.assertNotIn("listen 0.0.0.0", config)
        self.assertNotIn("ssl_certificate", config)

    def test_browser_has_host_network_but_no_socket_production_mount_or_provider_key(self):
        state = state_fixture()
        arguments = stage.browser_arguments(state)
        self.assertEqual(arguments[arguments.index("--network") + 1], "host")
        self.assertEqual(arguments[-1], state["images"]["browser"])
        self.assertIn("--read-only", arguments)
        self.assertEqual(arguments.count("--mount"), 1)
        self.assertEqual(arguments[arguments.index("--mount") + 1], "type=bind,source=/private/stage,target=/evidence")
        self.assertIn("CANVAS_SMOKE_BASE_URL=http://127.0.0.1:18080", arguments)
        self.assertFalse(any("docker.sock" in value or "PROVIDER_ENCRYPTION_KEY" in value or "S3_SECRET" in value or "PASSWORD" in value for value in arguments))

    def test_only_declared_mock_provider_tmpfs_is_allowed(self):
        state = state_fixture()
        original = resources_fixture(state)["containers"][0]
        self.assertEqual(stage.resource_matches(original, state, "container"), original["Id"])
        bad = copy.deepcopy(original)
        bad["Mounts"][1]["Destination"] = "/production"
        with self.assertRaisesRegex(stage.Rejected, "TMPFS"):
            stage.resource_matches(bad, state, "container")
        bad = copy.deepcopy(original)
        bad["Config"]["Labels"]["com.docker.compose.service"] = "api"
        with self.assertRaisesRegex(stage.Rejected, "TMPFS"):
            stage.resource_matches(bad, state, "container")
        bad = copy.deepcopy(original)
        bad["Mounts"][0]["RW"] = True
        with self.assertRaisesRegex(stage.Rejected, "BIND"):
            stage.resource_matches(bad, state, "container")

    def test_container_image_network_volume_and_formal_commands_are_guarded(self):
        state = state_fixture()
        original = resources_fixture(state)["containers"][0]
        changes = [lambda row: row.update(Image="sha256:" + "f" * 64),
                   lambda row: row["NetworkSettings"]["Networks"].update({"production": {}}),
                   lambda row: row["Mounts"].append({"Type": "volume", "Name": "vincent-s-canvas_postgres-data", "Destination": "/data"}),
                   lambda row: row["Config"]["Labels"].update({"com.docker.compose.project": "vincent-s-canvas"})]
        for change in changes:
            bad = copy.deepcopy(original)
            change(bad)
            with self.assertRaises(stage.Rejected):
                stage.resource_matches(bad, state, "container")
        api = copy.deepcopy(original)
        api["Mounts"] = api["Mounts"][:1]
        api["Config"]["Labels"]["com.docker.compose.service"] = "api"
        api["Config"].update(Cmd=["bun", "src/index.ts"], Env=["NODE_ENV=production", "TASK_MOCK_MODE=false", "AUTH_ENABLED=true", "OA_LOGIN_ENABLED=false", "REDIS_URL=redis://redis:6379", "S3_ENDPOINT=http://minio:9000"])
        self.assertEqual(stage.resource_matches(api, state, "container"), api["Id"])
        api["Config"]["Cmd"] = ["bun", "src/demo-server.ts"]
        with self.assertRaisesRegex(stage.Rejected, "FORMAL"):
            stage.resource_matches(api, state, "container")

    def test_cleanup_plans_exact_recorded_ids_never_prune_or_compose_down(self):
        state = state_fixture()
        resources = resources_fixture(state)
        containers, volumes, networks = stage.cleanup_plan(state, resources, copy.deepcopy(resources))
        self.assertEqual(containers, ["docker", "rm", "-f", "1" * 64])
        self.assertEqual(volumes, [["docker", "volume", "rm", state["project"] + "_postgres-data"]])
        self.assertEqual(networks, [["docker", "network", "rm", "2" * 64]])
        self.assertNotIn("prune", str((containers, volumes, networks)))
        self.assertNotIn("compose", str((containers, volumes, networks)))

    def test_web_only_ingress_is_exact_and_both_owned_network_ids_are_cleaned(self):
        state = state_fixture()
        resources = web_resources_fixture(state)
        web = resources["containers"][1]
        self.assertEqual(stage.resource_matches(web, state, "container", require_running=True), web["Id"])
        containers, _, networks = stage.cleanup_plan(state, resources, copy.deepcopy(resources))
        self.assertEqual(containers, ["docker", "rm", "-f", "1" * 64, "3" * 64])
        self.assertEqual(networks, [["docker", "network", "rm", "2" * 64], ["docker", "network", "rm", "4" * 64]])
        for change in (lambda row: row["HostConfig"]["PortBindings"]["3000/tcp"][0].update(HostIp="0.0.0.0"),
                       lambda row: row["NetworkSettings"]["Ports"]["3000/tcp"][0].update(HostPort="3000"),
                       lambda row: row["HostConfig"].update(PublishAllPorts=True),
                       lambda row: row["HostConfig"].update(NetworkMode="host"),
                       lambda row: row["NetworkSettings"]["Networks"].update(production={"NetworkID": "f" * 64})):
            bad = copy.deepcopy(web)
            change(bad)
            with self.subTest(change=change), self.assertRaises(stage.Rejected):
                stage.resource_matches(bad, state, "container")
        backend = copy.deepcopy(resources["containers"][0])
        backend["NetworkSettings"]["Networks"][state["project"] + "_ingress"] = {"NetworkID": "4" * 64}
        with self.assertRaises(stage.Rejected):
            stage.resource_matches(backend, state, "container")
        backend = copy.deepcopy(resources["containers"][0])
        backend["HostConfig"]["PortBindings"] = {"3100/tcp": [{"HostIp": "127.0.0.1", "HostPort": "13081"}]}
        with self.assertRaises(stage.Rejected):
            stage.resource_matches(backend, state, "container")

    def test_partial_web_start_can_be_journaled_and_cleaned_but_never_verified(self):
        for connected in ([], ["default"], ["ingress"]):
            with self.subTest(connected=connected), tempfile.TemporaryDirectory() as temporary:
                state = state_fixture(str(Path(temporary).resolve()))
                resources = web_resources_fixture(state)
                web = resources["containers"][1]
                web["State"]["Running"] = False
                web["NetworkSettings"]["Networks"] = {name: value for name, value in web["NetworkSettings"]["Networks"].items() if name in {state["project"] + "_" + suffix for suffix in connected}}
                web["NetworkSettings"]["Ports"] = {"3000/tcp": None}
                for network in resources["networks"]:
                    if network["Name"] not in web["NetworkSettings"]["Networks"]:
                        network["Containers"].pop(web["Id"], None)
                self.assertEqual(stage.resource_matches(web, state, "container"), web["Id"])
                with self.assertRaises(stage.Rejected):
                    stage.resource_matches(web, state, "container", require_running=True)
                def listed(arguments, output=None):
                    return b"owned"
                def inspected(*arguments):
                    return resources["containers" if arguments[0] == "inspect" else arguments[0] + "s"]
                with patch.object(stage, "start_stage", side_effect=stage.Rejected("SYNTHETIC_START_FAILURE")), patch.object(stage, "command", side_effect=listed), patch.object(stage, "docker_json", side_effect=inspected):
                    with self.assertRaisesRegex(stage.Rejected, "SYNTHETIC_START_FAILURE"):
                        stage.up(state)
                journal = stage.read_json(Path(temporary) / "created-resources.private.json")
                self.assertEqual(journal, resources)
                self.assertEqual(stage.cleanup_plan(state, resources, journal)[0], ["docker", "rm", "-f", "1" * 64, "3" * 64])

    def test_network_kind_identity_and_endpoint_ids_cannot_widen_cleanup(self):
        state = state_fixture()
        original = web_resources_fixture(state)
        changes = [lambda row: row["networks"][1].update(Internal=True),
                   lambda row: row["networks"][1].update(Name=state["project"] + "_unknown"),
                   lambda row: row["networks"][1].update(Driver="host"),
                   lambda row: row["networks"][1]["Labels"].update({"com.docker.compose.network": "default"}),
                   lambda row: row["networks"][1]["Containers"].update({"f" * 64: {}}),
                   lambda row: row["containers"][1]["NetworkSettings"]["Networks"][state["project"] + "_ingress"].update(NetworkID="f" * 64)]
        for change in changes:
            bad = copy.deepcopy(original)
            change(bad)
            with self.subTest(change=change), self.assertRaises(stage.Rejected):
                stage.cleanup_plan(state, bad, original)

    def test_running_inventory_requires_both_networks_and_actual_loopback_binding(self):
        state = state_fixture()
        resources = web_resources_fixture(state)
        for index, role in enumerate(("postgres", "redis", "minio", "api", "worker"), 5):
            row = copy.deepcopy(resources["containers"][0])
            row.update(Id=str(index) * 64, Name="/" + state["project"] + "-" + role + "-1", Image=state["images"]["api" if role == "worker" else role], Mounts=[])
            row["Config"]["Labels"]["com.docker.compose.service"] = role
            if role in ("api", "worker"):
                row["Config"].update(Cmd=["bun", "src/index.ts" if role == "api" else "src/worker.ts"], Env=["NODE_ENV=production", "TASK_MOCK_MODE=false", "AUTH_ENABLED=true", "OA_LOGIN_ENABLED=false", "REDIS_URL=redis://redis:6379", "S3_ENDPOINT=http://minio:9000"])
            resources["containers"].append(row)
            resources["networks"][0]["Containers"][row["Id"]] = {}
        for suffix in ("redis-data", "minio-data"):
            resources["volumes"].append(dict(resources["volumes"][0], Name=state["project"] + "_" + suffix))
        def inspect(*arguments):
            return resources["containers" if arguments[0] == "inspect" else arguments[0] + "s"]
        with patch.object(stage, "command", return_value=b"owned"), patch.object(stage, "docker_json", side_effect=inspect):
            self.assertEqual(stage.inventory(state, True), resources)
            resources["containers"][1]["NetworkSettings"]["Ports"] = {}
            with self.assertRaisesRegex(stage.Rejected, "INCOMPLETE_RUNNING"):
                stage.inventory(state, True)
            # A failed bind is recoverable without pretending the running entry passed.
            self.assertEqual(stage.inventory(state), resources)

    def test_created_but_not_connected_own_container_can_be_journaled_safely(self):
        state = state_fixture()
        row = resources_fixture(state)["containers"][0]
        row["State"]["Running"] = False
        row["NetworkSettings"]["Networks"] = {}
        row["HostConfig"] = {"NetworkMode": state["project"] + "_default"}
        self.assertEqual(stage.resource_matches(row, state, "container"), row["Id"])
        row["HostConfig"]["NetworkMode"] = "production"
        with self.assertRaises(stage.Rejected):
            stage.resource_matches(row, state, "container")

    def test_cleanup_rejects_foreign_unrecorded_replaced_or_attached_resources(self):
        state = state_fixture()
        original = resources_fixture(state)
        changes = [lambda row: row["containers"][0]["Config"]["Labels"].update({stage.LABEL: "d" * 32}),
                   lambda row: row["containers"][0].update(Id="3" * 64),
                   lambda row: row["networks"][0]["Containers"].update({"4" * 64: {}}),
                   lambda row: row["networks"][0].update(Internal=False),
                   lambda row: row["volumes"][0].update(Name="vincent-s-canvas_postgres-data"),
                   lambda row: row["volumes"][0].update(CreatedAt="2026-02-01T00:00:00Z")]
        for change in changes:
            bad = copy.deepcopy(original)
            change(bad)
            with self.assertRaises(stage.Rejected):
                stage.cleanup_plan(state, bad, original)

    def test_foreign_volume_user_blocks_cleanup_before_first_delete(self):
        with tempfile.TemporaryDirectory() as temporary:
            state = state_fixture(str(Path(temporary).resolve()))
            resources = resources_fixture(state)
            stage.write_json(Path(temporary) / "created-resources.private.json", resources)
            commands = []
            def execute(arguments, output=None):
                commands.append(arguments)
                return ("f" * 12).encode()
            with patch.object(stage, "inventory", return_value=resources), patch.object(stage, "command", side_effect=execute), self.assertRaisesRegex(stage.Rejected, "FOREIGN_CONTAINER_USES_STAGE_VOLUME"):
                stage.cleanup(state)
            self.assertEqual(len(commands), 1)
            self.assertEqual(commands[0][1:3], ["ps", "-aq"])
            self.assertFalse(any("rm" in arguments for arguments in commands))

    def test_release_requires_successful_ci_for_the_same_exact_images(self):
        release = release_fixture()
        self.assertIs(stage.validate_release(release), release)
        changes = [lambda value: value["verification"].update(status="pending"),
                   lambda value: value["verification"]["imageIds"].update(api="sha256:" + "f" * 64),
                   lambda value: value["verification"]["checks"].remove("browser-smoke"),
                   lambda value: value.update(platform="linux/arm64")]
        for change in changes:
            bad = copy.deepcopy(release)
            change(bad)
            with self.assertRaises(stage.Rejected):
                stage.validate_release(bad)

    def test_infrastructure_receipt_is_the_same_ci_run_and_cannot_use_tags(self):
        release = release_fixture()
        receipt = {"schema": 1, "commit": release["commit"], "platform": "linux/amd64", "project": "ci-release-123-1-amd64", "imageIds": {role: state_fixture()["images"][role] for role in stage.ROLES if role != "browser"}}
        package.validate_infra(receipt, release)
        for change in ({"project": "ci-release-456-1-amd64"}, {"project": state_fixture()["project"]}, {"commit": "d" * 40}):
            with self.assertRaises(package.stage.Rejected):
                package.validate_infra(dict(receipt, **change), release)
        bad = copy.deepcopy(receipt)
        bad["imageIds"]["minio"] = "minio:latest"
        with self.assertRaises(package.stage.Rejected):
            package.validate_infra(bad, release)

    def test_tools_package_commit_platform_and_ci_run_must_match_release(self):
        release = release_fixture()
        tools = {"schema": 1, "kind": "canvas-stage-smoke-tools", "commit": release["commit"], "platform": release["platform"], "workflowRunId": "123", "images": {role: state_fixture()["images"][role] for role in stage.ROLES}}
        stage.validate_tools(tools, release)
        for change in ({"commit": "e" * 40}, {"workflowRunId": "456"}, {"platform": "linux/arm64"}, {"images": {"browser": "latest"}}):
            with self.assertRaises(stage.Rejected):
                stage.validate_tools(dict(tools, **change), release)

    def test_prepare_is_new_private_state_and_detects_modified_public_package(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            release_root, tools_root, directory = base / "release", base / "tools", base / "state"
            release_root.mkdir()
            tools_root.mkdir()
            (tools_root / "scripts").mkdir()
            stage.write_new(release_root / "images.tar.gz", b"test-only-not-a-real-image", binary=True)
            release = release_fixture()
            release["files"] = [{"path": "images.tar.gz", "bytes": (release_root / "images.tar.gz").stat().st_size, "sha256": stage.digest(release_root / "images.tar.gz")}]
            stage.write_json(release_root / "release-manifest.json", release)
            for name in ["stage-images.tar", "stage-smoke.py", "stage-smoke-README.md"] + ["scripts/" + name for name in stage.SCRIPT_FILES]:
                stage.write_new(tools_root / name, "synthetic test fixture")
            tools = {"schema": 1, "kind": "canvas-stage-smoke-tools", "commit": release["commit"], "platform": release["platform"], "workflowRunId": "123", "images": {role: state_fixture()["images"][role] for role in stage.ROLES}}
            tools["files"] = [{"path": path.relative_to(tools_root).as_posix(), "bytes": path.stat().st_size, "sha256": stage.digest(path)} for path in tools_root.rglob("*") if path.is_file()]
            stage.write_json(tools_root / "stage-tools-manifest.json", tools)
            state = stage.prepare(release_root, tools_root, directory, 13080, 18080)
            self.assertEqual(stage.load_state(directory), state)
            self.assertEqual((directory / "baota-staging.conf").read_text(), stage.nginx_config(state))
            self.assertTrue(state["project"].startswith("canvas-staging-" + release["commit"][:12] + "-"))
            self.assertNotIn("synthetic-password", (directory / "compose.private.json").read_text())
            if os.name != "nt":
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                self.assertEqual((directory / "compose.private.json").stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                stage.prepare(release_root, tools_root, directory, 13080, 18080)
            with (tools_root / "scripts/seed.ts").open("a") as output:
                output.write("modified")
            with self.assertRaisesRegex(stage.Rejected, "PACKAGE_HASH_MISMATCH"):
                stage.load_state(directory)

    def test_docker_commands_are_fixed_to_local_socket_and_drop_host_overrides(self):
        with patch.dict(os.environ, {"DOCKER_HOST": "ssh://production", "DOCKER_CONTEXT": "other", "COMPOSE_PROJECT_NAME": "production", "HTTPS_PROXY": "http://proxy"}):
            with patch.object(stage.subprocess, "run") as run:
                run.return_value.returncode = 0
                run.return_value.stdout = b"ok"
                run.return_value.stderr = b""
                self.assertEqual(stage.command(["docker", "version"]), b"ok")
                self.assertEqual(run.call_args[0][0], ["docker", "--host", "unix:///var/run/docker.sock", "version"])
                environment = run.call_args[1]["env"]
                self.assertFalse(any(key in environment for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_PROJECT_NAME", "HTTPS_PROXY")))

    def test_packager_exports_only_exact_tool_ids_and_public_allowlist(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary).resolve()
            repository, release_root, destination = base / "repository", base / "release", base / "stage-tools"
            scripts = repository / "server/tests/production-smoke"
            scripts.mkdir(parents=True)
            (repository / "ops/release").mkdir(parents=True)
            release_root.mkdir()
            for filename in stage.SCRIPT_FILES:
                stage.write_new(scripts / filename, "public test script")
            for filename in ("stage-smoke.py", "stage-smoke-README.md"):
                stage.write_new(repository / "ops/release" / filename, "public tool")
            stage.write_new(repository / ".env", "NEVER_PACKAGE_PRODUCTION_SECRET")
            stage.write_new(release_root / "images.tar.gz", "fake app images for unit test")
            release = release_fixture()
            release["files"] = [{"path": "images.tar.gz", "bytes": (release_root / "images.tar.gz").stat().st_size, "sha256": stage.digest(release_root / "images.tar.gz")}]
            stage.write_json(release_root / "release-manifest.json", release)
            state = state_fixture()
            receipt = {"schema": 1, "commit": release["commit"], "platform": "linux/amd64", "project": "ci-release-123-1-amd64", "imageIds": {role: state["images"][role] for role in stage.ROLES if role != "browser"}}
            receipt_path = base / "infra-images.json"
            stage.write_json(receipt_path, receipt)
            calls = []
            def inspect(*arguments):
                identity = arguments[-1]
                return [{"Id": identity, "Os": "linux", "Architecture": "amd64", "Config": {"Labels": {"org.opencontainers.image.revision": state["commit"], "io.canvas.stage.kind": "browser-runner"}}}]
            ci_host = "unix:///home/runner/setup-docker-action/run-test/docker.sock"
            def execute(docker_host, *arguments):
                self.assertEqual(docker_host, ci_host)
                if arguments[:2] == ("image", "inspect"):
                    return json.dumps(inspect(*arguments)).encode()
                calls.append(arguments)
                stage.write_new(Path(arguments[arguments.index("-o") + 1]), "fake tool images for unit test")
                return b""
            with patch.object(package.subprocess, "check_output", side_effect=[release["commit"].encode(), b""]), patch.object(package, "docker_command", side_effect=execute):
                manifest = package.package(repository, release_root, receipt_path, state["images"]["browser"], destination, ci_host)
            self.assertEqual(calls[0][:2], ("image", "save"))
            self.assertEqual(set(calls[0][4:]), {state["images"][role] for role in stage.ROLES})
            self.assertNotIn(state["images"]["api"], calls[0])
            self.assertNotIn(state["images"]["web"], calls[0])
            self.assertEqual(set(stage.verify_files(destination, manifest)), {"stage-images.tar", "stage-smoke.py", "stage-smoke-README.md"} | {"scripts/" + name for name in stage.SCRIPT_FILES})
            with tarfile.open(str(destination.with_suffix(".tar"))) as archive:
                self.assertNotIn(".env", archive.getnames())
                self.assertNotIn("release-manifest.json", archive.getnames())
                self.assertIn("stage-tools-manifest.json", archive.getnames())
            self.assertTrue(Path(str(destination.with_suffix(".tar")) + ".sha256").is_file())

    def test_ci_packager_uses_explicit_local_socket_without_changing_target_default(self):
        host = "unix:///home/runner/setup-docker-action/run-test/docker.sock"
        with patch.dict(os.environ, {"DOCKER_HOST": host, "COMPOSE_PROJECT_NAME": "unrelated", "HTTPS_PROXY": "http://proxy"}, clear=True), \
                patch.object(package.subprocess, "run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = b"[]"
            self.assertEqual(package.docker_command(host, "image", "inspect", "sha256:" + "a" * 64), b"[]")
            self.assertEqual(run.call_args[0][0][:5], ["docker", "--host", host, "image", "inspect"])
            self.assertEqual(run.call_args[1]["env"], {})
            self.assertEqual(run.call_args[1]["timeout"], 1800)
        with patch.dict(os.environ, {}, clear=True), patch.object(package.stage, "command", return_value=b"local") as command:
            self.assertEqual(package.docker_command(None, "version"), b"local")
            command.assert_called_once_with(["docker", "version"])

    def test_ci_packager_rejects_remote_implicit_or_ambiguous_hosts_before_commands(self):
        host = "unix:///tmp/ci-docker.sock"
        cases = [(None, {"DOCKER_HOST": host}, "EXPLICIT_CI_DOCKER_HOST_REQUIRED"),
                 (host, {"DOCKER_HOST": "unix:///tmp/other.sock"}, "DOCKER_HOST_MISMATCH")]
        for remote in ("tcp://192.0.2.1:2375", "ssh://production", "unix://remote/socket", "unix:///", "unix:///tmp/socket?x=1", "unix:///tmp/socket#x", "unix:///tmp/bad\nsocket"):
            cases.append((remote, {"DOCKER_HOST": remote}, "LOCAL_UNIX_DOCKER_HOST_REQUIRED"))
        for key in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
            cases.append((host, {"DOCKER_HOST": host, key: "unexpected"}, "IMPLICIT_DOCKER_OVERRIDE_REFUSED"))
        for argument, environment, message in cases:
            with self.subTest(argument=argument, environment=environment), patch.dict(os.environ, environment, clear=True), \
                    patch.object(package.subprocess, "run") as run, patch.object(package.stage, "command") as command:
                with self.assertRaisesRegex(package.stage.Rejected, message):
                    package.docker_command(argument, "image", "inspect", "sha256:" + "a" * 64)
                run.assert_not_called()
                command.assert_not_called()

    def test_ci_packager_command_failure_is_not_reported_as_success(self):
        host = "unix:///tmp/ci-docker.sock"
        with patch.dict(os.environ, {"DOCKER_HOST": host}, clear=True), patch.object(package.subprocess, "run") as run:
            run.return_value.returncode = 1
            with self.assertRaisesRegex(package.stage.Rejected, "CI_DOCKER_COMMAND_FAILED"):
                package.docker_command(host, "image", "save", "-o", "never-created.tar", "sha256:" + "a" * 64)

    def test_bundled_scripts_parse_with_python_37_grammar_and_runner_lock_matches_project(self):
        for name in ("stage-smoke.py", "stage-smoke-package.py"):
            source = (ROOT / name).read_text(encoding="utf-8")
            if sys.version_info >= (3, 8):
                ast.parse(source, feature_version=(3, 7))
            else:
                compile(source, str(ROOT / name), "exec")
        lock = json.loads((ROOT / "stage-smoke-runner/package-lock.json").read_text(encoding="utf-8"))
        source = (ROOT.parent.parent / "web/bun.lock").read_text(encoding="utf-8")
        self.assertEqual(len(lock["packages"]), 4)
        for name, row in lock["packages"].items():
            if name:
                self.assertEqual(row["version"], "1.64.1")
                self.assertIn(row["integrity"], source)
        self.assertIn("mcr.microsoft.com/playwright:v1.64.1-noble", (ROOT / "stage-smoke-runner/Dockerfile").read_text())


if __name__ == "__main__":
    unittest.main()
