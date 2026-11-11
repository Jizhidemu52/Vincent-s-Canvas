#!/usr/bin/env python3
"""Linux instance-based, zero-migration application image cutover.

No shell interpolation, production defaults, bootstrap, build, pull, volume delete,
database restore, automatic retry, or secret-bearing console output.
"""
import argparse
from contextlib import ExitStack
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

from contract import (Rejected, assert_application_runtime, assert_configured_environment, assert_database_layout, assert_idle, assert_image,
                      assert_live_inventory, assert_migrations, assert_mounts, assert_protected,
                      candidate_compose, canonical, container_map, digest, read_json,
                      inside, loopback_web_ports, overlaps_code, prepare_compatibility_assets, require, stable_container,
                      validate_instance, verify_package, write_new_json)


def sha_file(path):
    value = Path(path)
    require(value.is_file() and not value.is_symlink(), "REGULAR_FILE_REQUIRED")
    result = hashlib.sha256()
    with value.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): result.update(block)
    return result.hexdigest()


def private_directory(path):
    value = Path(path)
    require(value.is_absolute() and value.is_dir() and not value.is_symlink(), "EXISTING_PRIVATE_DIRECTORY_REQUIRED")
    require(value.stat().st_mode & 0o077 == 0, "PRIVATE_DIRECTORY_MODE_REQUIRED")
    return value


def stopped(rows, instance):
    inventory = container_map(rows)
    return all(target in inventory and inventory[target].get("State", {}).get("Running") is False
               and inventory[target].get("State", {}).get("Restarting") is False
               for target in instance["containers"].values())


def rollback_compose(model, rows, instance):
    result = json.loads(json.dumps(model))
    inventory = container_map(rows)
    for role, target in instance["containers"].items():
        service = result["services"][role]
        service["image"] = inventory[target]["Image"]
        service["container_name"] = target
        service["pull_policy"] = "never"
        service.pop("build", None)
        if role == "web": loopback_web_ports(service, instance)
        if role in ("api", "worker"):
            require(service.get("entrypoint") in (None, []), "CUSTOM_ROLLBACK_ENTRYPOINT_REFUSED")
            service["command"] = ["bun", "src/index.ts" if role == "api" else "src/worker.ts"]
    return result


def require_unchanged(before, after, code):
    require(canonical(before) == canonical(after), code)


def compose_literals(value):
    """Resolved private Compose strings must not undergo variable expansion twice."""
    if isinstance(value, str): return value.replace("$", "$$")
    if isinstance(value, list): return [compose_literals(item) for item in value]
    if isinstance(value, dict): return {key: compose_literals(item) for key, item in value.items()}
    return value


def parse_compose_config(raw):
    """Decode Compose's canonical-file escaping, not shell interpolation.

    Compose 2.28.1 and 2.38.2 re-escape every dollar in `config` output so
    that output can itself be loaded as a Compose file. Our in-memory model
    must contain actual runtime strings before comparison or re-serialization.
    Never apply this to raw configuration files or Docker inspect output.
    """
    text = raw.decode("utf-8") if isinstance(raw, bytes) else raw
    require(isinstance(text, str) and "$" not in text.replace("$$", ""), "UNEXPECTED_COMPOSE_DOLLAR_ENCODING")
    return json.loads(text.replace("$$", "$"))


def assert_rollback_source(current_model, expected_model, current_rows, expected_rows, instance):
    # The exact deployment is the rollback source, not merely an image with the
    # same credentials. Include mounts, ports, networks, commands and all other
    # service fields. Compose itself performs normalization before this call.
    require_unchanged(current_model, expected_model, "ROLLBACK_COMPOSE_DRIFT_REQUIRES_REVIEW")
    current, expected = container_map(current_rows), container_map(expected_rows)
    for name in instance["containers"].values():
        require(name in current and name in expected, "ROLLBACK_APPLICATION_MISSING")
        before, now = stable_container(expected[name]), stable_container(current[name])
        # A normal restart of the same container does not alter its deployment.
        # Recreated containers or any configuration/mount/network drift do.
        for value in [before, now]:
            value.pop("startedAt", None); value.pop("restartCount", None)
        require_unchanged(before, now, "ROLLBACK_RUNNING_APPLICATION_DRIFT_REQUIRES_REVIEW")


def activity_query(query):
    # Reused compilation records may retain an old status; only the original
    # optimizer row owns execution. Admission is separate from task execution.
    return ("WITH activity(snapshot) AS (" + query.strip().rstrip(";") + ") "
            "SELECT snapshot::jsonb || jsonb_build_object("
            "'optimizingPromptCompilations',(SELECT count(*) FROM prompt_compilations WHERE status='optimizing' AND reused_from_id IS NULL),"
            "'admittingBatches',(SELECT count(*) FROM batch_tasks WHERE admission_status='admitting')) FROM activity;")


class Deployment:
    def __init__(self, instance_path, audit=None):
        self.instance_path = Path(instance_path)
        require(self.instance_path.is_absolute(), "ABSOLUTE_INSTANCE_REQUIRED")
        self.instance = validate_instance(read_json(self.instance_path))
        self.root = Path(self.instance["root"])
        require(self.root.is_dir(), "INSTANCE_ROOT_MISSING")
        project_directory = Path(self.instance.get("projectDirectory", self.instance["root"]))
        require(project_directory.is_dir(), "PROJECT_DIRECTORY_MISSING")
        resolved_root, resolved_project = self.root.resolve(), project_directory.resolve()
        require(resolved_project == resolved_root or resolved_root in resolved_project.parents, "PROJECT_DIRECTORY_RESOLVES_OUTSIDE_ROOT")
        self.audit = audit
        self.sequence = 0
        self.tools = Path(__file__).resolve().parent
        self.lock = None

    def command(self, arguments, input_data=None, timeout=120, output=None, read_output=True, input_file=None):
        self.sequence += 1
        destination = output or self.audit / f"command-{self.sequence:03d}.private.log"
        with Path(destination).open("xb") as stdout, (self.audit / f"stderr-{self.sequence:03d}.private.log").open("xb") as stderr, ExitStack() as streams:
            stdin = streams.enter_context(Path(input_file).open("rb")) if input_file else None
            try:
                result = subprocess.run(arguments, input=input_data, stdin=stdin, stdout=stdout, stderr=stderr,
                                        cwd=self.root, timeout=timeout, check=False)
            except (OSError, subprocess.TimeoutExpired):
                raise Rejected("COMMAND_FAILED_OR_TIMED_OUT_NO_AUTOMATIC_RETRY") from None
        require(result.returncode == 0, "COMMAND_FAILED_SEE_PRIVATE_AUDIT")
        return Path(destination).read_bytes() if read_output else b""

    def compose_arguments(self, model=None):
        result = ["docker", "compose", "-p", self.instance["project"], "--project-directory", self.instance.get("projectDirectory", self.instance["root"]),
                  "--env-file", self.instance["environmentFile"]]
        active = Path(self.instance["stateRoot"]) / "active-compose.private.json"
        if model:
            files = [str(model)]
        elif active.exists():
            require(active.is_file() and not active.is_symlink() and active.stat().st_mode & 0o077 == 0, "ACTIVE_COMPOSE_NOT_PRIVATE")
            files = [str(active)]
        else:
            files = self.instance["composeFiles"]
        for file in files: result += ["-f", file]
        return result

    def compose(self, *arguments, model=None, timeout=180, output=None):
        return self.command(self.compose_arguments(model) + list(arguments), timeout=timeout, output=output)

    def inventory(self, label):
        ids = self.command(["docker", "ps", "-aq"]).decode().split()
        require(ids, "EMPTY_DOCKER_INVENTORY")
        return json.loads(self.command(["docker", "inspect", *ids], output=self.audit / f"containers-{label}.private.json"))

    def sql(self, name, label):
        database = self.instance["database"]
        query = (self.tools / name).read_text(encoding="utf-8")
        if name == "activity.sql": query = activity_query(query)
        command = ["docker", "exec", "-i", database["container"], "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", database["user"], "-d", database["name"]]
        value = self.command(command, input_data=("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='60s';\n" + query + "\nCOMMIT;\n").encode(), output=self.audit / f"{label}.private.json")
        return json.loads(value)

    def gate(self, operation):
        gate = self.instance["gate"]
        require(sha_file(gate["command"]) == gate["sha256"], "INGRESS_GATE_CHANGED")
        self.command(["python3", "-B", gate["command"], operation, str(self.instance_path), str(self.audit)], timeout=120)

    def configuration_hashes(self):
        files = [str(self.instance_path), self.instance["environmentFile"], *self.instance["composeFiles"], self.instance["gate"]["command"]]
        active = Path(self.instance["stateRoot"]) / "active-compose.private.json"
        if active.exists(): files.append(str(active))
        if self.instance.get("ingress"):
            ingress = self.instance["ingress"]
            for field, hash_field in [("siteFile", "expectedSiteSha256"), ("proxyFile", "expectedProxySha256")]:
                require(sha_file(ingress[field]) == ingress[hash_field], "REVIEWED_INGRESS_CHANGED")
                files.append(ingress[field])
        return {path: sha_file(path) for path in files}

    def new_audit(self, operation):
        import fcntl
        audit_root = private_directory(self.instance["auditRoot"])
        state = Path(self.instance["stateRoot"])
        if not state.exists(): state.mkdir(mode=0o700)
        private_directory(state)
        self.lock = (state / "deployment.lock").open("a+")
        try: fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: raise Rejected("ANOTHER_DEPLOYMENT_OPERATION_IS_ACTIVE") from None
        self.audit = Path(tempfile.mkdtemp(prefix=operation + "-", dir=audit_root))
        endpoint = json.loads(self.command(["docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"]))
        require(isinstance(endpoint, str) and endpoint.startswith("unix:///"), "LOCAL_UNIX_DOCKER_CONTEXT_REQUIRED")
        return self.audit

    def capture(self, label):
        model = parse_compose_config(self.compose("config", "--format", "json", output=self.audit / f"compose-{label}.private.json"))
        rows = self.inventory(label)
        assert_live_inventory(rows, model, self.instance)
        for role, target in self.instance["containers"].items():
            row = container_map(rows)[target]
            image = json.loads(self.command(["docker", "image", "inspect", row["Image"]]))[0]
            assert_configured_environment(row, image, model["services"][role])
        database = self.sql("database-state.sql", "database-" + label)
        activity = self.sql("activity.sql", "activity-" + label)
        maintenance = self.sql("maintenance.sql", "maintenance-" + label)
        require(all(type(maintenance.get(key)) is int and maintenance[key] == 0 for key in ["longTransactions", "waitingLocks"]), "DATABASE_BUSY")
        return {"model": model, "containers": rows, "database": database, "activity": activity,
                "configurationHashes": self.configuration_hashes()}

    def assert_platform(self, release):
        actual = self.command(["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"]).decode().strip()
        actual = actual.replace("x86_64", "amd64").replace("aarch64", "arm64")
        require(actual == release["platform"], "DOCKER_PLATFORM_MISMATCH")

    def preflight(self, package):
        release = verify_package(package)
        self.new_audit("preflight")
        self.assert_platform(release)
        require(shutil.disk_usage(self.root).free >= self.instance["minimumFreeBytes"] + (package / "images.tar.gz").stat().st_size * 3, "INSUFFICIENT_DISK_SPACE")
        current = self.capture("preflight")
        assert_migrations([item["name"] for item in current["database"]["migrations"]], release, self.instance)
        candidate_compose(current["model"], release, self.planning_instance(current["model"]), str(self.audit / "previous-public/assets"))
        self.gate("verify-open")
        write_new_json(self.audit / "preflight.json", {"schema": 1, "createdAt": time.time(), "instanceSha256": sha_file(self.instance_path),
                       "manifestSha256": sha_file(package / "release-manifest.json"), "package": str(package), "baseline": current})
        return {"status": "preflight-passed", "audit": str(self.audit), "commit": release["commit"], "mutations": False,
                "transportSecurity": "https" if self.instance["publicBaseUrl"].startswith("https://") else "existing-http-unencrypted-not-changed"}

    def planning_instance(self, model):
        if not (Path(self.instance["stateRoot"]) / "active-compose.private.json").exists(): return self.instance
        result = json.loads(json.dumps(self.instance))
        result["retiredCodeMounts"] = {"api": [], "worker": [], "web": []}
        for role in ["api", "worker", "web"]:
            for mount in model["services"][role].get("volumes", []):
                if not overlaps_code(mount["target"]): continue
                require(role == "web" and mount["target"] == "/opt/canvas/previous-public/assets" and mount.get("type") == "bind"
                        and mount.get("read_only") is True and str(mount.get("source", "")).startswith(self.instance["auditRoot"] + "/"), "ACTIVE_RELEASE_CODE_MOUNT_CHANGED")
                result["retiredCodeMounts"][role].append({"source": mount["source"], "target": mount["target"]})
        return result

    def activate(self, model):
        state = private_directory(self.instance["stateRoot"])
        temporary = state / (self.audit.name + ".new.json")
        write_new_json(temporary, read_json(model))
        os.replace(temporary, state / "active-compose.private.json")

    def prepare_previous_assets(self, current, planned, destination):
        web = container_map(current["containers"])[self.instance["containers"]["web"]]
        container_id = web.get("Id")
        labels = web.get("Config", {}).get("Labels") or {}
        require(isinstance(container_id, str) and re.fullmatch(r"[a-f0-9]{64}", container_id)
                and labels.get("com.docker.compose.project") == self.instance["project"]
                and labels.get("com.docker.compose.service") == "web", "STATIC_SOURCE_CONTAINER_IDENTITY_REQUIRED")
        service = current["model"]["services"]["web"]
        assert_mounts(web, service, current["model"])
        compatibility_target = "/opt/canvas/previous-public/assets"
        retained = [mount for mount in service.get("volumes", []) if mount["target"] == compatibility_target]
        require(len(retained) <= 1, "UNREVIEWED_COMPATIBILITY_MOUNT")
        if retained:
            mount = retained[0]
            require(mount.get("type") == "bind" and mount.get("read_only") is True
                    and inside(self.instance["auditRoot"], mount.get("source", ""))
                    and {"source": mount["source"], "target": compatibility_target} in planned["retiredCodeMounts"]["web"],
                    "UNREVIEWED_COMPATIBILITY_MOUNT")
        source = self.audit / "previous-public-source"
        self.command(["docker", "cp", container_id + ":/usr/share/nginx/html/assets", str(source)])
        retained_source = None
        if retained:
            # Only the compatibility mount of this already-verified old Web is
            # eligible. Never scan historical host directories or follow links.
            retained_source = self.audit / "previous-public-retained-source"
            self.command(["docker", "cp", container_id + ":" + compatibility_target, str(retained_source)])
        return prepare_compatibility_assets(source, destination, retained_source)

    def wait_health(self, origin, release=None):
        # Bounded GET-only readiness checks; never retry a state-changing operation.
        for attempt in range(45):
            result = subprocess.run(["curl", "--disable", "--noproxy", "*", "--retry", "0", "--fail", "--silent", "--show-error", "--max-time", "5", origin.rstrip("/") + "/api/health"], capture_output=True)
            if result.returncode == 0: break
            time.sleep(2)
        else: raise Rejected("APPLICATION_HEALTH_NOT_READY")
        if release:
            marker = json.loads(self.command(["curl", "--disable", "--noproxy", "*", "--retry", "0", "--fail", "--silent", "--show-error", "--max-time", "10", origin.rstrip("/") + "/deployment-release.json"]))
            require(marker == {"schema": 1, "version": release["version"], "commit": release["commit"]}, "DEPLOYED_RELEASE_MARKER_MISMATCH")

    def wait_worker_health(self, expected_image, previous_id, timeout_seconds=120, poll_seconds=2):
        # Cover the worker's 90s startup period plus one 30s health interval.
        # Retry only this read-only heartbeat check, never a lifecycle operation.
        require(0 < timeout_seconds <= 120 and 0 < poll_seconds <= timeout_seconds, "BOUNDED_WORKER_READINESS_REQUIRED")
        deadline = time.monotonic() + timeout_seconds
        target = self.instance["containers"]["worker"]
        identity = None

        def remaining():
            value = deadline - time.monotonic()
            require(value > 0, "WORKER_HEALTH_NOT_READY")
            return value

        def inspect_worker():
            nonlocal identity
            rows = json.loads(self.command(["docker", "inspect", target], timeout=min(10, remaining())))
            require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict), "WORKER_INSPECTION_INVALID")
            row = rows[0]
            state = row.get("State", {})
            labels = row.get("Config", {}).get("Labels") or {}
            require(row.get("Name") == "/" + target and row.get("Image") == expected_image
                    and labels.get("com.docker.compose.project") == self.instance["project"]
                    and labels.get("com.docker.compose.service") == "worker", "WORKER_TARGET_MISMATCH")
            require(state.get("Running") is True and state.get("Restarting") is False
                    and state.get("Paused") is False and row.get("RestartCount") == 0, "WORKER_RESTARTED_OR_STOPPED")
            current = (row.get("Id"), state.get("StartedAt"))
            require(all(isinstance(value, str) and value for value in current)
                    and current[0] != previous_id, "NEW_WORKER_IDENTITY_REQUIRED")
            if identity is None: identity = current
            require(current == identity, "WORKER_IDENTITY_CHANGED")
            return current[0]

        while True:
            container_id = inspect_worker()
            ready = False
            try:
                self.command(["docker", "exec", container_id, "bun", "src/worker-healthcheck.ts"], timeout=min(5, remaining()))
                ready = True
            except Rejected as error:
                if str(error) != "COMMAND_FAILED_SEE_PRIVATE_AUDIT": raise
            # A successful check must not accept a replacement or restarted worker.
            inspect_worker()
            budget = remaining()
            if ready: return container_id
            time.sleep(min(poll_seconds, budget))

    def stop_app(self, model):
        self.compose("stop", "-t", "1300", "web", "api", "worker", model=model, timeout=1350)
        rows = self.inventory("stopped-" + str(self.sequence))
        require(stopped(rows, self.instance), "APPLICATION_STOP_UNCONFIRMED")
        return rows

    def start_app(self, model):
        self.compose("up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "api", "worker", "web", model=model, timeout=180)

    def protected_and_database(self, baseline, label):
        assert_protected(baseline["containers"], self.inventory(label), self.instance)
        require_unchanged(baseline["database"], self.sql("database-state.sql", "database-" + label), "DATABASE_CHANGED_MANUAL_RECOVERY_REQUIRED")
        assert_idle(self.sql("activity.sql", "activity-" + label))

    def preparation_unchanged(self, baseline):
        self.application_configuration_unchanged(baseline)
        rows = self.inventory("prepared")
        require_unchanged({name: stable_container(row) for name, row in container_map(baseline["containers"]).items()},
                          {name: stable_container(row) for name, row in container_map(rows).items()}, "CONTAINER_DRIFT_DURING_PREPARATION")
        assert_database_layout(baseline["database"], self.sql("database-state.sql", "database-prepared"))

    def wait_for_drain(self, timeout_seconds=1200, poll_seconds=5):
        require(timeout_seconds > 0 and poll_seconds > 0, "BOUNDED_DRAIN_REQUIRED")
        deadline = time.monotonic() + timeout_seconds
        attempt = 0
        while True:
            snapshot = self.sql("activity.sql", f"activity-drain-{attempt:04d}")
            remaining = deadline - time.monotonic()
            require(remaining >= 0, "DRAIN_TIMEOUT_NO_APPLICATION_STOP_OR_RESUBMISSION")
            try:
                assert_idle(snapshot)
                return snapshot
            except Rejected as error:
                if str(error) != "INFLIGHT_WORK_REQUIRES_DRAIN": raise
            require(remaining > 0, "DRAIN_TIMEOUT_NO_APPLICATION_STOP_OR_RESUBMISSION")
            time.sleep(min(poll_seconds, remaining))
            attempt += 1

    def freeze_stopped_baseline(self, prepared, rows):
        require(stopped(rows, self.instance), "APPLICATION_STOP_UNCONFIRMED")
        assert_protected(prepared["containers"], rows, self.instance)
        self.application_configuration_unchanged(prepared)
        activity = self.sql("activity.sql", "activity-stopped-baseline")
        assert_idle(activity)
        maintenance = self.sql("maintenance.sql", "maintenance-stopped-baseline")
        require(all(type(maintenance.get(key)) is int and maintenance[key] == 0 for key in ["longTransactions", "waitingLocks", "otherCanvasLocks"]), "STOPPED_DATABASE_BUSY")
        database = self.sql("database-state.sql", "database-stopped-baseline")
        assert_database_layout(prepared["database"], database)
        final = {**prepared, "database": database, "activity": activity}
        write_new_json(self.audit / "baseline.private.json", final)
        return final

    def application_configuration_unchanged(self, baseline):
        for path, expected in baseline["configurationHashes"].items():
            if self.instance.get("ingress") and path in [self.instance["ingress"]["siteFile"], self.instance["ingress"]["proxyFile"]]: continue
            require(sha_file(path) == expected, "APPLICATION_CONFIGURATION_CHANGED")

    def cutover(self, baseline, target, fallback, release=None, images=None):
        gate_closed = False
        launched = False
        stopped_confirmed = False
        baseline_frozen = False
        try:
            self.preparation_unchanged(baseline)
            gate_closed = True
            self.gate("close")
            self.gate("verify-closed")
            self.wait_for_drain()
            stopped_rows = self.stop_app(fallback); stopped_confirmed = True
            baseline = self.freeze_stopped_baseline(baseline, stopped_rows)
            baseline_frozen = True
            self.protected_and_database(baseline, "stopped")
            database = self.instance["database"]
            self.command(["docker", "exec", database["container"], "pg_dump", "-U", database["user"], "-d", database["name"], "-Fc"], timeout=600, output=self.audit / "database-before.dump", read_output=False)
            require((self.audit / "database-before.dump").stat().st_size > 0, "EMPTY_DATABASE_BACKUP")
            self.command(["docker", "exec", "-i", database["container"], "pg_restore", "--list"], input_file=self.audit / "database-before.dump", timeout=120, read_output=False)
            write_new_json(self.audit / "database-backup.json", {"file": "database-before.dump", "sha256": sha_file(self.audit / "database-before.dump"), "bytes": (self.audit / "database-before.dump").stat().st_size})
            self.protected_and_database(baseline, "backed-up")
            self.start_app(target); launched = True
            self.wait_health(self.instance["localBaseUrl"], release)
            worker_image = release["images"]["api"]["id"] if release else read_json(target)["services"]["worker"]["image"]
            self.wait_worker_health(worker_image, container_map(baseline["containers"])[self.instance["containers"]["worker"]]["Id"])
            after = self.inventory("started")
            if release:
                running_model = parse_compose_config(self.compose("config", "--format", "json", model=target))
                assert_application_runtime(baseline["containers"], after, running_model, images, release, self.instance)
            else:
                for role, container in self.instance["containers"].items():
                    require(container_map(after)[container]["Image"] == read_json(target)["services"][role]["image"], "ROLLBACK_IMAGE_MISMATCH")
            self.protected_and_database(baseline, "verified")
            # Gate changes ingress temporarily, so compare only application inputs here.
            self.application_configuration_unchanged(baseline)
            self.gate("open"); self.gate("verify-open"); gate_closed = False
            self.wait_health(self.instance["publicBaseUrl"], release)
        except Exception:
            # No uncertain writes are retried. A failed new application may be
            # restored only after positively stopping it and proving zero change.
            restored = False
            if gate_closed and stopped_confirmed and baseline_frozen:
                try:
                    self.gate("verify-closed")
                    self.application_configuration_unchanged(baseline)
                    if launched: self.stop_app(target)
                    require(stopped(self.inventory("failed-stopped"), self.instance), "FAILED_APP_STOP_UNCONFIRMED")
                    self.protected_and_database(baseline, "failed-stopped-check")
                    self.start_app(fallback)
                    self.wait_health(self.instance["localBaseUrl"])
                    self.protected_and_database(baseline, "restored")
                    restored = True
                except Exception:
                    restored = False
            write_new_json(self.audit / "failure.json", {"status": "failed", "fallbackApplicationRestored": restored,
                           "maintenanceMayBeClosed": gate_closed, "manualReviewRequired": True})
            raise

    def apply(self, package, preflight):
        release = verify_package(package)
        prior = read_json(private_directory(preflight) / "preflight.json")
        require(0 <= time.time() - prior.get("createdAt", 0) <= 900, "PREFLIGHT_EXPIRED")
        require(prior.get("instanceSha256") == sha_file(self.instance_path) and prior.get("manifestSha256") == sha_file(package / "release-manifest.json") and prior.get("package") == str(package), "PREFLIGHT_TARGET_CHANGED")
        self.new_audit("apply")
        current = self.capture("apply")
        require_unchanged(prior["baseline"]["configurationHashes"], current["configurationHashes"], "CONFIGURATION_DRIFT_SINCE_PREFLIGHT")
        assert_database_layout(prior["baseline"]["database"], current["database"])
        require_unchanged([stable_container(row) for row in prior["baseline"]["containers"]], [stable_container(row) for row in current["containers"]], "CONTAINER_DRIFT_SINCE_PREFLIGHT")
        assert_migrations([item["name"] for item in current["database"]["migrations"]], release, self.instance)
        self.assert_platform(release)
        self.command(["docker", "image", "load", "-i", str(package / "images.tar.gz")], timeout=600)
        images = {}
        for role in ["api", "web"]:
            images[role] = json.loads(self.command(["docker", "image", "inspect", release["images"][role]["reference"]]))[0]
            assert_image(images[role], release, role)
        compatibility = self.audit / "previous-public/assets"
        planned = self.planning_instance(current["model"])
        target = candidate_compose(current["model"], release, planned, str(compatibility))
        write_new_json(self.audit / "previous-public-files.json", self.prepare_previous_assets(current, planned, compatibility))
        fallback = rollback_compose(current["model"], current["containers"], self.instance)
        write_new_json(self.audit / "candidate-model.private.json", target)
        write_new_json(self.audit / "rollback-model.private.json", fallback)
        write_new_json(self.audit / "candidate.private.json", compose_literals(target))
        write_new_json(self.audit / "rollback.private.json", compose_literals(fallback))
        write_new_json(self.audit / "preparation-baseline.private.json", current)
        self.compose("config", "--quiet", model=self.audit / "candidate.private.json")
        self.cutover(current, self.audit / "candidate.private.json", self.audit / "rollback.private.json", release, images)
        self.activate(self.audit / "candidate.private.json")
        evidence = ["candidate-model.private.json", "candidate.private.json", "rollback-model.private.json", "rollback.private.json", "containers-started.private.json", "baseline.private.json"]
        receipt = {"schema": 1, "status": "applied", "instanceSha256": sha_file(self.instance_path), "commit": release["commit"], "imageIds": {role: row["id"] for role, row in release["images"].items()}, "audit": str(self.audit), "databaseChanged": False, "infrastructureChanged": False,
                   "rollbackEvidence": {name: sha_file(self.audit / name) for name in evidence}, "databaseBaseline": "confirmed-stopped"}
        write_new_json(self.audit / "receipt.json", receipt)
        return receipt

    def rollback(self, deployed_audit):
        old = private_directory(deployed_audit)
        receipt = read_json(old / "receipt.json")
        require(receipt.get("status") == "applied" and receipt.get("instanceSha256") == sha_file(self.instance_path), "SUCCESSFUL_MATCHING_DEPLOYMENT_REQUIRED")
        evidence = ["candidate-model.private.json", "candidate.private.json", "rollback-model.private.json", "rollback.private.json", "containers-started.private.json", "baseline.private.json"]
        require(isinstance(receipt.get("rollbackEvidence"), dict) and set(receipt["rollbackEvidence"]) == set(evidence), "SEALED_ROLLBACK_EVIDENCE_REQUIRED")
        for name in evidence: require(sha_file(old / name) == receipt["rollbackEvidence"][name], "ROLLBACK_EVIDENCE_CHANGED")
        target = read_json(old / "rollback-model.private.json")
        self.new_audit("rollback")
        current = self.capture("rollback")
        expected_model = parse_compose_config(self.compose("config", "--format", "json", model=old / "candidate.private.json"))
        assert_rollback_source(current["model"], expected_model, current["containers"], read_json(old / "containers-started.private.json"), self.instance)
        for role, container in self.instance["containers"].items():
            require(container_map(current["containers"])[container]["Image"] == receipt["imageIds"]["web" if role == "web" else "api"], "ROLLBACK_SOURCE_IMAGE_CHANGED")
            require_unchanged(target["services"][role].get("environment"), current["model"]["services"][role].get("environment"), "ROLLBACK_ENVIRONMENT_CHANGED")
            self.command(["docker", "image", "inspect", target["services"][role]["image"]])
        previous = read_json(old / "baseline.private.json")
        assert_database_layout(previous["database"], current["database"])
        write_new_json(self.audit / "candidate.private.json", compose_literals(target))
        write_new_json(self.audit / "rollback.private.json", compose_literals(rollback_compose(current["model"], current["containers"], self.instance)))
        self.cutover(current, self.audit / "candidate.private.json", self.audit / "rollback.private.json")
        self.activate(self.audit / "candidate.private.json")
        result = {"schema": 1, "status": "rolled-back", "audit": str(self.audit), "previousDeployment": str(old), "databaseChanged": False}
        write_new_json(self.audit / "receipt.json", result)
        return result


def main():
    parser = argparse.ArgumentParser(description="Instance-scoped application image deployment")
    parser.add_argument("operation", choices=["preflight", "apply", "rollback"])
    parser.add_argument("instance"); parser.add_argument("target"); parser.add_argument("preflight", nargs="?")
    args = parser.parse_args()
    require(sys.platform == "linux", "LINUX_DEPLOYMENT_HOST_REQUIRED")
    os.umask(0o077)
    require(not os.environ.get("DOCKER_HOST"), "EXPLICIT_LOCAL_DOCKER_REQUIRED")
    deployment = Deployment(args.instance)
    target = Path(args.target)
    require(target.is_absolute() and target.is_dir() and not target.is_symlink(), "ABSOLUTE_TARGET_DIRECTORY_REQUIRED")
    if args.operation == "preflight": result = deployment.preflight(target)
    elif args.operation == "apply":
        require(args.preflight is not None, "EXPLICIT_FRESH_PREFLIGHT_REQUIRED")
        result = deployment.apply(target, Path(args.preflight))
    else: result = deployment.rollback(target)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try: main()
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        error = sys.exc_info()[1]
        print("DEPLOYMENT_REJECTED " + (str(error) if isinstance(error, Rejected) else "PRIVATE_OPERATION_FAILED"), file=sys.stderr)
        sys.exit(1)
