#!/usr/bin/env python3
"""Release identity and zero-migration contracts; standard library, no network.

Public files contain identities/hashes only. Resolved Compose/container snapshots
are private operator evidence and are never printed by this CLI.
"""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
from urllib.parse import urlsplit


class Rejected(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise Rejected(code)


def keys(value, required, optional=()):
    return isinstance(value, dict) and set(required) <= set(value) <= set(required) | set(optional)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def digest_file(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): result.update(block)
    return result.hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def read_json(path):
    try:
        value = Path(path)
        require(value.is_file() and not value.is_symlink(), "REGULAR_JSON_REQUIRED")
        require(value.stat().st_size <= 256 * 1024 * 1024, "JSON_TOO_LARGE")
        return json.loads(value.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise Rejected("JSON_UNREADABLE") from None


def write_new_json(path, value, mode=0o600):
    # O_EXCL prevents reruns from replacing prior evidence, including a started receipt.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
        json.dump(value, output, ensure_ascii=False, sort_keys=True, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())


def safe_relative(value):
    require(isinstance(value, str) and value and not re.search(r"[\\:\x00-\x1f\x7f]", value), "UNSAFE_RELATIVE_PATH")
    require(not value.startswith("/") and all(part not in ("", ".", "..") for part in value.split("/")), "UNSAFE_RELATIVE_PATH")
    return value


def absolute(value, minimum_parts=2):
    require(isinstance(value, str) and re.fullmatch(r"/[A-Za-z0-9._/-]+", value) is not None, "ABSOLUTE_POSIX_PATH_REQUIRED")
    require(str(PurePosixPath(value)) == value and ".." not in value.split("/") and len(PurePosixPath(value).parts) >= minimum_parts, "UNSAFE_ABSOLUTE_PATH")
    return value


def inside(root, value):
    absolute(value)
    return value.startswith(root.rstrip("/") + "/")


def image_id(value):
    return isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value) is not None


def name(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", value) is not None


def validate_manifest(value, require_verification=True):
    required = ["schema", "kind", "version", "commit", "platform", "images", "migrations", "verification"]
    require(keys(value, required, ["files"]), "MANIFEST_FIELDS_INVALID")
    require(value["schema"] == 1 and value["kind"] == "canvas-image-release", "MANIFEST_SCHEMA_INVALID")
    require(isinstance(value["version"], str) and re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?", value["version"]), "VERSION_INVALID")
    require(isinstance(value["commit"], str) and re.fullmatch(r"[a-f0-9]{40}", value["commit"]), "FULL_COMMIT_REQUIRED")
    require(value["platform"] in ("linux/amd64", "linux/arm64"), "PLATFORM_INVALID")
    require(keys(value["images"], ["api", "web"]), "IMAGE_ROLES_INVALID")
    architecture = value["platform"].split("/")[1]
    for role in ["api", "web"]:
        row = value["images"][role]
        require(keys(row, ["reference", "id", "digest"]), "IMAGE_FIELDS_INVALID")
        require(row["reference"] == f"canvas-release-{role}:{value['commit']}-{architecture}", "IMMUTABLE_LOCAL_IMAGE_REFERENCE_REQUIRED")
        require(image_id(row["id"]), "IMAGE_ID_INVALID")
        require(isinstance(row["digest"], str) and re.fullmatch(r"[a-z0-9][a-z0-9._:/-]+@sha256:[a-f0-9]{64}", row["digest"]), "REGISTRY_DIGEST_REQUIRED")
    migrations = value["migrations"]
    require(isinstance(migrations, list) and migrations, "MIGRATION_INVENTORY_REQUIRED")
    names = []
    for row in migrations:
        require(keys(row, ["name", "sha256"]) and isinstance(row["name"], str) and re.fullmatch(r"[0-9]{3}_[a-z0-9_]+\.sql", row["name"]), "MIGRATION_ENTRY_INVALID")
        require(isinstance(row["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]), "MIGRATION_HASH_INVALID")
        names.append(row["name"])
    require(names == sorted(set(names)), "MIGRATION_INVENTORY_NOT_UNIQUE_SORTED")
    verification = value["verification"]
    require(keys(verification, ["status", "commit", "platform", "imageIds", "checks", "workflowRunId"]), "VERIFICATION_FIELDS_INVALID")
    require(verification["commit"] == value["commit"] and verification["platform"] == value["platform"], "VERIFICATION_SOURCE_MISMATCH")
    require(verification["imageIds"] == {role: value["images"][role]["id"] for role in ["api", "web"]}, "UNTESTED_IMAGE_ID")
    require(isinstance(verification["workflowRunId"], str) and re.fullmatch(r"[1-9][0-9]*", verification["workflowRunId"]), "WORKFLOW_RUN_REQUIRED")
    require(isinstance(verification["checks"], list) and len(set(verification["checks"])) == len(verification["checks"]), "VERIFICATION_CHECKS_INVALID")
    if require_verification:
        require(verification["status"] == "passed" and set(verification["checks"]) == {"runtime", "production-stack", "browser-smoke"}, "REQUIRED_IMAGE_VERIFICATION_MISSING")
    else:
        require(verification["status"] in ("pending", "passed"), "VERIFICATION_STATUS_INVALID")
    if "files" in value:
        require(isinstance(value["files"], list) and value["files"], "ARTIFACT_FILES_REQUIRED")
        paths = []
        for row in value["files"]:
            require(keys(row, ["path", "sha256", "bytes"]), "ARTIFACT_FILE_FIELDS_INVALID")
            path = safe_relative(row["path"])
            require(path not in ("release-manifest.json", "SHA256SUMS") and not re.search(r"(^|/)(?:\.env|node_modules|\.git)(?:/|\.|$)|\.(?:sqlite3?|dump|pem|key|pfx|p12)$", path, re.I), "PRIVATE_ARTIFACT_REFUSED")
            require(isinstance(row["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]), "ARTIFACT_HASH_INVALID")
            require(type(row["bytes"]) is int and row["bytes"] >= 0, "ARTIFACT_SIZE_INVALID")
            paths.append(path)
        require(paths == sorted(set(paths)) and "images.tar.gz" in paths, "ARTIFACT_INVENTORY_INVALID")
    return value


def validate_instance(value):
    required = ["schema", "kind", "name", "project", "root", "composeFiles", "environmentFile", "auditRoot", "stateRoot", "network", "localBaseUrl", "publicBaseUrl", "containers", "database", "protectedContainers", "expectedVolumes", "retainedMigrationNames", "retiredCodeMounts", "gate", "minimumFreeBytes"]
    require(keys(value, required, ["ingress", "projectDirectory"]), "INSTANCE_FIELDS_INVALID")
    require(value["schema"] == 1 and value["kind"] == "canvas-deployment-instance", "INSTANCE_SCHEMA_INVALID")
    for field in ["name", "project", "network"]:
        require(name(value[field]), "INSTANCE_NAME_INVALID")
    require(not value["project"].startswith("newvcan"), "PROTECTED_PROJECT_REFUSED")
    root = absolute(value["root"], 3)
    project_directory = value.get("projectDirectory", root)
    require(project_directory == root or inside(root, project_directory), "PROJECT_DIRECTORY_OUTSIDE_ROOT")
    for field in ["environmentFile", "auditRoot", "stateRoot"]:
        require(inside(root, value[field]), "INSTANCE_PATH_OUTSIDE_ROOT")
    require(value["auditRoot"] != value["stateRoot"], "STATE_AND_AUDIT_MUST_DIFFER")
    require(isinstance(value["composeFiles"], list) and 1 <= len(value["composeFiles"]) <= 4 and len(set(value["composeFiles"])) == len(value["composeFiles"]), "COMPOSE_FILES_REQUIRED")
    for item in value["composeFiles"]:
        require(inside(root, item), "COMPOSE_OUTSIDE_ROOT")
    for field in ["localBaseUrl", "publicBaseUrl"]:
        parsed = urlsplit(value[field])
        require(parsed.scheme in ("http", "https") and parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and parsed.path in ("", "/"), "ORIGIN_INVALID")
        if field == "localBaseUrl":
            require(parsed.hostname in ("127.0.0.1", "::1"), "LOCAL_PROBE_MUST_USE_LOOPBACK")
        # The existing origin is explicit instance evidence. Never silently
        # add TLS, disable certificate checks, or downgrade HTTPS on failure.
    require(keys(value["containers"], ["api", "worker", "web"]), "APPLICATION_ROLES_INVALID")
    require(len(set(value["containers"].values())) == 3 and all(name(item) and not item.startswith("newvcan") for item in value["containers"].values()), "APPLICATION_TARGET_INVALID")
    require(keys(value["database"], ["container", "user", "name"]) and all(name(item) for item in value["database"].values()), "DATABASE_IDENTITY_REQUIRED")
    require(isinstance(value["protectedContainers"], list) and len(set(value["protectedContainers"])) == len(value["protectedContainers"]) and all(name(item) for item in value["protectedContainers"]), "PROTECTED_CONTAINER_LIST_REQUIRED")
    require(value["database"]["container"] in value["protectedContainers"] and not set(value["containers"].values()) & set(value["protectedContainers"]), "PROTECTED_APPLICATION_OVERLAP")
    require(isinstance(value["expectedVolumes"], dict) and len(value["expectedVolumes"]) >= 3, "EXPLICIT_PG_REDIS_MINIO_VOLUMES_REQUIRED")
    for container, volumes in value["expectedVolumes"].items():
        require(container in value["protectedContainers"] and isinstance(volumes, list) and volumes, "VOLUME_OWNER_INVALID")
        for volume in volumes:
            require(keys(volume, ["name", "destination"]) and name(volume["name"]), "VOLUME_IDENTITY_INVALID")
            absolute(volume["destination"])
    require(isinstance(value["retainedMigrationNames"], list) and len(set(value["retainedMigrationNames"])) == len(value["retainedMigrationNames"]) and all(isinstance(item, str) and re.fullmatch(r"[0-9]{3}_[a-z0-9_]+\.sql", item) for item in value["retainedMigrationNames"]), "RETAINED_MIGRATIONS_INVALID")
    require(keys(value["retiredCodeMounts"], ["api", "worker", "web"]), "RETIRED_MOUNT_ROLES_INVALID")
    for role, mounts in value["retiredCodeMounts"].items():
        require(isinstance(mounts, list), "RETIRED_MOUNT_LIST_INVALID")
        targets = set()
        for mount in mounts:
            require(keys(mount, ["source", "target"]) and inside(root, mount["source"]), "RETIRED_MOUNT_SOURCE_INVALID")
            require(mount["target"] not in targets and is_code_target(role, mount["target"]), "RETIRED_MOUNT_TARGET_INVALID")
            targets.add(mount["target"])
    require(keys(value["gate"], ["command", "sha256"]) and inside(root, value["gate"]["command"]) and re.fullmatch(r"[a-f0-9]{64}", value["gate"]["sha256"] or ""), "REVIEWED_INGRESS_GATE_REQUIRED")
    if "ingress" in value:
        ingress = value["ingress"]
        require(keys(ingress, ["proxyFile", "expectedProxySha256", "siteFile", "expectedSiteSha256", "nginxBinary", "probeUrl", "host"]), "INGRESS_FIELDS_INVALID")
        for field in ["proxyFile", "siteFile", "nginxBinary"]: absolute(ingress[field])
        for field in ["expectedProxySha256", "expectedSiteSha256"]:
            require(isinstance(ingress[field], str) and re.fullmatch(r"[a-f0-9]{64}", ingress[field]), "INGRESS_FILE_HASH_REQUIRED")
        probe = urlsplit(ingress["probeUrl"])
        require(probe.scheme == "http" and probe.hostname in ("127.0.0.1", "::1") and not probe.username and not probe.password and not probe.query and not probe.fragment, "INGRESS_LOOPBACK_PROBE_REQUIRED")
        require(isinstance(ingress["host"], str) and re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]*", ingress["host"]), "INGRESS_HOST_INVALID")
    require(type(value["minimumFreeBytes"]) is int and value["minimumFreeBytes"] >= 1024 ** 3, "MINIMUM_FREE_SPACE_REQUIRED")
    return value


def is_code_target(role, target):
    if role == "web":
        return target in ("/usr/share/nginx/html", "/opt/canvas/previous-public/assets")
    return target == "/app/src" or bool(re.fullmatch(r"/shared/[A-Za-z0-9_.-]+\.ts", target or ""))


def overlaps_code(target):
    protected = ["/app", "/shared", "/usr/share/nginx/html", "/opt/canvas/previous-public"]
    return any(target == parent or parent.startswith(target.rstrip("/") + "/") or target.startswith(parent + "/") for parent in protected)


def loopback_web_ports(service, deployment):
    ports = service.get("ports", [])
    require(len(ports) == 1 and isinstance(ports[0], dict), "SINGLE_EXPLICIT_WEB_PORT_REQUIRED")
    port = ports[0]
    expected = urlsplit(deployment["localBaseUrl"]).port
    require(port.get("target") == 3000 and str(port.get("published")) == str(expected) and port.get("protocol", "tcp") == "tcp", "WEB_PORT_IDENTITY_MISMATCH")
    port["host_ip"] = "127.0.0.1"
    return service


def candidate_compose(before, release, deployment, compatibility_assets):
    validate_manifest(release)
    validate_instance(deployment)
    require(inside(deployment["auditRoot"], compatibility_assets), "COMPATIBILITY_ASSETS_OUTSIDE_AUDIT")
    require(isinstance(before, dict) and isinstance(before.get("services"), dict), "RESOLVED_COMPOSE_REQUIRED")
    require(before.get("name") == deployment["project"], "COMPOSE_PROJECT_MISMATCH")
    result = copy.deepcopy(before)
    for role in ["api", "worker", "web"]:
        require(role in before["services"], "APPLICATION_SERVICE_MISSING")
        service = result["services"][role]
        require("env_file" not in service, "COMPOSE_ENV_NOT_RESOLVED")
        require(not service.get("links") and not service.get("volumes_from"), "UNSUPPORTED_APPLICATION_DEPENDENCY")
        for field in ["network_mode", "ipc", "pid", "uts", "cgroup"]:
            require(not str(service.get(field, "")).startswith("service:"), "UNSUPPORTED_APPLICATION_DEPENDENCY")
        if role in ("api", "worker"):
            require(service.get("environment", {}).get("TASK_MOCK_MODE") == "false", "PRODUCTION_MOCK_MODE_REFUSED")
            service["command"] = ["bun", "src/index.ts" if role == "api" else "src/worker.ts"]
            # A clean image defines its runtime entrypoint; a legacy override must
            # not reintroduce migration/bootstrap or an old application launcher.
            require(service.get("entrypoint") in (None, []), "CUSTOM_API_ENTRYPOINT_REQUIRES_REVIEW")
        service["image"] = release["images"]["web" if role == "web" else "api"]["reference"]
        service.pop("build", None)
        service["pull_policy"] = "never"
        service["container_name"] = deployment["containers"][role]
        if role == "web": loopback_web_ports(service, deployment)
        expected = {(item["source"], item["target"]) for item in deployment["retiredCodeMounts"][role]}
        observed = set()
        retained = []
        for mount in service.get("volumes", []):
            require(isinstance(mount, dict) and isinstance(mount.get("target"), str), "NORMALIZED_COMPOSE_MOUNT_REQUIRED")
            pair = (mount.get("source"), mount["target"])
            if pair in expected:
                require(mount.get("type") == "bind" and mount.get("read_only") is True, "RETIRED_MOUNT_NOT_READONLY")
                require(pair not in observed, "DUPLICATE_RETIRED_MOUNT")
                observed.add(pair)
            else:
                require(not overlaps_code(mount["target"]), "UNREVIEWED_APPLICATION_CODE_MOUNT")
                retained.append(mount)
        require(observed == expected, "REVIEWED_MOUNT_MISSING")
        if role == "web":
            retained.append({"type": "bind", "source": compatibility_assets,
                             "target": "/opt/canvas/previous-public/assets", "read_only": True,
                             "bind": {"create_host_path": False}})
        service["volumes"] = retained
    return result


def assert_migrations(actual, release, deployment):
    require(isinstance(actual, list) and all(isinstance(item, str) for item in actual), "MIGRATION_REGISTRATIONS_INVALID")
    expected = [row["name"] for row in release["migrations"]] + deployment["retainedMigrationNames"]
    require(len(set(expected)) == len(expected) and sorted(actual) == sorted(expected), "ZERO_MIGRATION_BASELINE_MISMATCH")


def assert_image(actual, release, role):
    require(role in ("api", "web") and isinstance(actual, dict), "IMAGE_ROLE_INVALID")
    expected = release["images"][role]
    labels = actual.get("Config", {}).get("Labels") or {}
    require(actual.get("Id") == expected["id"], "IMAGE_ID_MISMATCH")
    require(f"{actual.get('Os')}/{actual.get('Architecture')}" == release["platform"], "IMAGE_PLATFORM_MISMATCH")
    require(labels.get("org.opencontainers.image.revision") == release["commit"] and labels.get("org.opencontainers.image.version") == release["version"], "IMAGE_SOURCE_LABEL_MISMATCH")
    # docker save/load may omit RepoDigests; image config ID is preserved. When
    # digest metadata is available, it must include the tested registry object.
    digests = actual.get("RepoDigests") or []
    require(not digests or expected["digest"] in digests, "REGISTRY_DIGEST_MISMATCH")


def env_map(values):
    require(isinstance(values, list), "CONTAINER_ENVIRONMENT_INVALID")
    result = {}
    for value in values:
        require(isinstance(value, str) and "=" in value, "CONTAINER_ENVIRONMENT_INVALID")
        key, content = value.split("=", 1)
        require(key not in result, "DUPLICATE_ENVIRONMENT_KEY")
        result[key] = content
    return result


def container_map(rows):
    require(isinstance(rows, list), "CONTAINER_INVENTORY_REQUIRED")
    result = {}
    for row in rows:
        key = str(row.get("Name", ""))
        if key.startswith("/"): key = key[1:]
        require(name(key) and key not in result, "CONTAINER_INVENTORY_INVALID")
        result[key] = row
    return result


def stable_container(row):
    # Do not reduce mounts, network membership, environment or HostConfig to a
    # few convenient fields. Ignore only changing process health observations.
    result = {key: copy.deepcopy(row.get(key)) for key in ["Id", "Name", "Image", "Config", "HostConfig", "Mounts"]}
    # Docker may reorder Mounts between inspections. Sort complete copied
    # objects, preserving every field and duplicate without changing other arrays.
    if isinstance(result["Mounts"], list):
        result["Mounts"].sort(key=canonical)
    result["networks"] = {key: {field: value.get(field) for field in ["NetworkID", "IPAddress", "GlobalIPv6Address", "Aliases", "DNSNames"]}
                          for key, value in row.get("NetworkSettings", {}).get("Networks", {}).items()}
    result["startedAt"] = row.get("State", {}).get("StartedAt")
    result["restartCount"] = row.get("RestartCount")
    return result


def assert_mounts(row, service, model):
    planned_mounts = service.get("volumes", [])
    actual_mounts = row.get("Mounts", [])
    require(len(actual_mounts) == len(planned_mounts), "RUNNING_MOUNT_COUNT_MISMATCH")
    for planned in planned_mounts:
        matching = [mount for mount in actual_mounts if mount.get("Destination") == planned["target"]]
        require(len(matching) == 1, "RUNNING_MOUNT_TARGET_MISMATCH")
        mount = matching[0]
        require(mount.get("Type") == planned["type"] and mount.get("RW") == (not planned.get("read_only", False)), "RUNNING_MOUNT_MODE_MISMATCH")
        if planned["type"] == "bind":
            require(mount.get("Source") == planned["source"], "RUNNING_BIND_SOURCE_MISMATCH")
        elif planned["type"] == "volume":
            expected_name = model.get("volumes", {}).get(planned["source"], {}).get("name")
            require(expected_name and mount.get("Name") == expected_name, "RUNNING_VOLUME_SOURCE_MISMATCH")
        else:
            require(planned["type"] == "tmpfs", "UNSUPPORTED_APPLICATION_MOUNT_TYPE")


def assert_configured_environment(row, image, service):
    expected = env_map(image.get("Config", {}).get("Env", []))
    expected.update({key: str(value) for key, value in (service.get("environment") or {}).items()})
    require(env_map(row.get("Config", {}).get("Env", [])) == expected, "RUNNING_ENVIRONMENT_MISMATCH")


def assert_live_inventory(rows, compose_model, deployment):
    validate_instance(deployment)
    containers = container_map(rows)
    for role, container in deployment["containers"].items():
        require(container in containers, "APPLICATION_CONTAINER_MISSING")
        actual = containers[container]
        labels = actual.get("Config", {}).get("Labels") or {}
        require(labels.get("com.docker.compose.project") == deployment["project"] and labels.get("com.docker.compose.service") == role, "APPLICATION_COMPOSE_IDENTITY_MISMATCH")
        state = actual.get("State", {})
        require(state.get("Running") is True and not state.get("Restarting") and not state.get("Paused"), "APPLICATION_NOT_RUNNING_STABLY")
        require(deployment["network"] in actual.get("NetworkSettings", {}).get("Networks", {}), "APPLICATION_NETWORK_MISMATCH")
        actual_env = env_map(actual.get("Config", {}).get("Env", []))
        assert_mounts(actual, compose_model.get("services", {}).get(role, {}), compose_model)
        configured = compose_model.get("services", {}).get(role, {}).get("environment") or {}
        require(all(actual_env.get(key) == str(value) for key, value in configured.items()), "LIVE_ENVIRONMENT_COMPOSE_DRIFT")
        if role in ("api", "worker"):
            require(actual_env.get("TASK_MOCK_MODE") == "false", "PRODUCTION_MOCK_MODE_REFUSED")
    for container in deployment["protectedContainers"]:
        require(container in containers, "PROTECTED_CONTAINER_MISSING")
    for container, expected in deployment["expectedVolumes"].items():
        actual = sorted([{"name": mount.get("Name"), "destination": mount.get("Destination")}
                         for mount in containers[container].get("Mounts", []) if mount.get("Type") == "volume"], key=canonical)
        require(actual == sorted(expected, key=canonical), "PROTECTED_VOLUME_IDENTITY_MISMATCH")
    # Unknown neighbouring containers are protected too; adding a container
    # cannot bypass the explicit newvcan/infra preservation requirement.
    return {key: stable_container(row) for key, row in containers.items() if key not in deployment["containers"].values()}


def assert_protected(before, after, deployment):
    prior, current = container_map(before), container_map(after)
    excluded = set(deployment["containers"].values())
    require({key: stable_container(row) for key, row in prior.items() if key not in excluded}
            == {key: stable_container(row) for key, row in current.items() if key not in excluded}, "PROTECTED_INFRASTRUCTURE_CHANGED")


def assert_application_runtime(before, after, model, images, release, deployment):
    prior, current = container_map(before), container_map(after)
    for role, container in deployment["containers"].items():
        require(container in current and container in prior, "APPLICATION_CONTAINER_MISSING")
        row, old = current[container], prior[container]
        image_role = "web" if role == "web" else "api"
        require(row.get("Image") == release["images"][image_role]["id"], "RUNNING_IMAGE_ID_MISMATCH")
        require(row.get("RestartCount") == 0 and row.get("State", {}).get("Running") is True, "APPLICATION_RESTARTED_OR_STOPPED")
        assert_configured_environment(row, images[image_role], model["services"][role])
        expected_ports = old.get("HostConfig", {}).get("PortBindings")
        if role == "web":
            expected_ports = {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(urlsplit(deployment["localBaseUrl"]).port)}]}
        require(row.get("HostConfig", {}).get("PortBindings") == expected_ports, "APPLICATION_PORT_CHANGED")
        before_networks = {key: value.get("NetworkID") for key, value in old.get("NetworkSettings", {}).get("Networks", {}).items()}
        after_networks = {key: value.get("NetworkID") for key, value in row.get("NetworkSettings", {}).get("Networks", {}).items()}
        require(before_networks == after_networks, "APPLICATION_NETWORK_CHANGED")
        assert_mounts(row, model["services"][role], model)


def assert_idle(value):
    require(isinstance(value, dict), "ACTIVITY_SNAPSHOT_INVALID")
    fields = ["waitingTasks", "processingTasks", "submittedWaitingTasks", "processingChatRequests", "processingAnalysisPreviews", "optimizingPromptCompilations", "admittingBatches", "pendingAssetThumbnails"]
    require(all(type(value.get(field)) is int and value[field] >= 0 for field in fields), "ACTIVITY_COUNT_INVALID")
    require(type(value.get("pausedTasks")) is int and value["pausedTasks"] >= 0, "PAUSED_TASK_COUNT_INVALID")
    require(all(value[field] == 0 for field in fields), "INFLIGHT_WORK_REQUIRES_DRAIN")


def assert_database_layout(before, after):
    """Business rows and sequence positions may advance before the maintenance stop."""
    fields = ["identity", "migrations", "columns", "indexes", "constraints", "sequences"]
    require(all(isinstance(value, dict) and all(field in value for field in fields) for value in [before, after]), "DATABASE_LAYOUT_SNAPSHOT_INVALID")
    def layout(value):
        result = {field: value[field] for field in fields if field != "sequences"}
        require(isinstance(value["sequences"], list) and all(isinstance(row, dict) for row in value["sequences"]), "DATABASE_SEQUENCE_SNAPSHOT_INVALID")
        result["sequences"] = [{key: item for key, item in row.items() if key != "last_value"} for row in value["sequences"]]
        return result
    require(canonical(layout(before)) == canonical(layout(after)), "DATABASE_IDENTITY_OR_SCHEMA_CHANGED")


def can_restore_application(state):
    return isinstance(state, dict) and all(state.get(field) is True for field in ["stopConfirmed", "databaseUnchanged", "configurationKnown", "idle"])


def prepare_compatibility_assets(source, destination):
    source, destination = Path(source), Path(destination)
    require(source.is_dir() and not source.is_symlink() and not destination.exists(), "STATIC_COMPATIBILITY_PATH_INVALID")
    destination.mkdir(parents=True, mode=0o755)
    rows = []
    for path in sorted(source.rglob("*")):
        require(not path.is_symlink(), "LINKED_STATIC_ASSET_REFUSED")
        if path.is_dir():
            continue
        require(path.is_file(), "SPECIAL_STATIC_ASSET_REFUSED")
        relative = path.relative_to(source).as_posix()
        # Vite immutable chunks/assets only. No source maps, HTML, JSON/config,
        # environment, directory traversal, or arbitrary un-hashed public files.
        if "/" in relative or not re.fullmatch(r"[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8,}\.(?:js|css|woff2?|ttf|otf|png|jpe?g|webp|avif|svg|gif|ico|wasm)", relative):
            continue
        content = path.read_bytes()
        target = destination / relative
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as output:
            output.write(content)
        rows.append({"path": relative, "sha256": digest(content), "bytes": len(content)})
    require(rows, "NO_VERIFIED_PREVIOUS_FINGERPRINTED_ASSETS")
    return rows


def verify_package(directory):
    root = Path(directory)
    require(root.is_dir() and not root.is_symlink(), "PACKAGE_DIRECTORY_REQUIRED")
    manifest = validate_manifest(read_json(root / "release-manifest.json"))
    require("files" in manifest, "ARTIFACT_FILES_REQUIRED")
    actual = set()
    for path in root.rglob("*"):
        require(not path.is_symlink(), "LINKED_PACKAGE_FILE_REFUSED")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
        else:
            require(path.is_dir(), "SPECIAL_PACKAGE_FILE_REFUSED")
    expected = {row["path"] for row in manifest["files"]} | {"release-manifest.json", "SHA256SUMS"}
    require(actual == expected, "PACKAGE_FILE_INVENTORY_MISMATCH")
    for row in manifest["files"]:
        file = root / row["path"]
        require(file.stat().st_size == row["bytes"] and digest_file(file) == row["sha256"], "PACKAGE_CONTENT_MISMATCH")
    sums = (root / "SHA256SUMS").read_text(encoding="utf-8").splitlines()
    decoded = {}
    for line in sums:
        require(re.fullmatch(r"[a-f0-9]{64}  [^\r\n]+", line), "PACKAGE_SUM_LINE_INVALID")
        sha, relative = line.split("  ", 1); safe_relative(relative)
        require(relative not in decoded, "DUPLICATE_PACKAGE_SUM")
        decoded[relative] = sha
    require(set(decoded) == expected - {"SHA256SUMS"}, "PACKAGE_SUM_INVENTORY_MISMATCH")
    require(all(digest_file(root / path) == sha for path, sha in decoded.items()), "PACKAGE_SUM_MISMATCH")
    return manifest


def cli():
    parser = argparse.ArgumentParser(description="Canvas image release contracts (no secrets printed)")
    parser.add_argument("command", choices=["manifest", "package", "instance", "image", "candidate", "migrations", "idle", "live", "protected", "runtime", "compat", "field"])
    parser.add_argument("paths", nargs="+")
    args = parser.parse_args(); paths = args.paths
    if args.command == "manifest" and len(paths) == 1: validate_manifest(read_json(paths[0]))
    elif args.command == "package" and len(paths) == 1: verify_package(paths[0])
    elif args.command == "instance" and len(paths) == 1: validate_instance(read_json(paths[0]))
    elif args.command == "image" and len(paths) == 3:
        rows = read_json(paths[0]); require(isinstance(rows, list) and len(rows) == 1, "ONE_IMAGE_INSPECTION_REQUIRED")
        assert_image(rows[0], validate_manifest(read_json(paths[1])), paths[2])
    elif args.command == "candidate" and len(paths) == 5:
        write_new_json(paths[4], candidate_compose(read_json(paths[0]), read_json(paths[1]), read_json(paths[2]), paths[3]))
    elif args.command == "migrations" and len(paths) == 3: assert_migrations(read_json(paths[0]), read_json(paths[1]), read_json(paths[2]))
    elif args.command == "idle" and len(paths) == 1: assert_idle(read_json(paths[0]))
    elif args.command == "live" and len(paths) == 3: assert_live_inventory(read_json(paths[0]), read_json(paths[1]), read_json(paths[2]))
    elif args.command == "protected" and len(paths) == 3: assert_protected(read_json(paths[0]), read_json(paths[1]), read_json(paths[2]))
    elif args.command == "runtime" and len(paths) == 7:
        images = {"api": read_json(paths[3])[0], "web": read_json(paths[4])[0]}
        assert_application_runtime(read_json(paths[0]), read_json(paths[1]), read_json(paths[2]), images, read_json(paths[5]), read_json(paths[6]))
    elif args.command == "compat" and len(paths) == 3: write_new_json(paths[2], prepare_compatibility_assets(paths[0], paths[1]))
    elif args.command == "field" and len(paths) == 2:
        value = read_json(paths[0])
        if value.get("kind") == "canvas-image-release": validate_manifest(value)
        else: validate_instance(value)
        for field in paths[1].split("."):
            require(isinstance(value, dict) and field in value, "UNKNOWN_FIELD")
            value = value[field]
        require(isinstance(value, (str, int, list)), "SCALAR_OR_LIST_FIELD_REQUIRED")
        if isinstance(value, list):
            require(all(isinstance(item, str) for item in value), "STRING_LIST_REQUIRED")
            print("\n".join(value))
        else: print(value)
        return
    else: raise Rejected("ARGUMENT_CONTRACT_INVALID")
    print("RELEASE_CONTRACT_OK")


if __name__ == "__main__":
    try: cli()
    except (Rejected, OSError, ValueError, KeyError, TypeError):
        # Exceptions may originate from private Compose/env evidence: no repr,
        # traceback or offending value is ever exposed by the operator CLI.
        error = sys.exc_info()[1]
        print("RELEASE_CONTRACT_REJECTED " + (str(error) if isinstance(error, Rejected) else "PRIVATE_EVIDENCE_INVALID"), file=sys.stderr)
        sys.exit(1)
