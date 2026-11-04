#!/usr/bin/env python3
"""Disposable same-host smoke only. Python 3.7+, Docker Compose; no app rebuild.

No command installs/reloads Nginx or edits an existing site's configuration.
Cleanup is explicit and removes only run-labelled resources with recorded IDs.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import urllib.request


LABEL = "io.canvas.stage.run"
PROJECT_LABEL = "io.canvas.stage.project"
ROLES = ("browser", "postgres", "redis", "minio", "minio-init")
SERVICES = ("postgres", "redis", "minio", "minio-init", "api", "worker", "web", "mock-provider")
VOLUMES = ("postgres-data", "redis-data", "minio-data")
CHECKS = ["login", "upload", "canvas-image", "refresh-recovery", "original-download", "video-task", "chat"]
SCRIPT_FILES = ["identity.ts", "seed.ts", "mock-provider.ts", "receipt.ts"]


class Rejected(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def read_json(path):
    require(path.is_file() and not path.is_symlink(), "REGULAR_JSON_FILE_REQUIRED")
    return json.loads(path.read_text(encoding="utf-8"))


def write_new(path, value, binary=False):
    data = value if binary else value.encode("utf-8")
    with os.fdopen(os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
        output.write(data)


def write_json(path, value):
    write_new(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def absolute_directory(value, exists=True):
    path = Path(value)
    require(path.is_absolute() and path != Path(path.anchor) and not path.is_symlink(), "EXPLICIT_SAFE_ABSOLUTE_DIRECTORY_REQUIRED")
    require(path.is_dir() if exists else not path.exists(), "DIRECTORY_STATE_MISMATCH")
    return path.resolve()


def verify_files(root, manifest):
    require(isinstance(manifest.get("files"), list) and manifest["files"], "HASHED_PACKAGE_FILES_REQUIRED")
    seen = set()
    for entry in manifest["files"]:
        relative = entry.get("path", "")
        require(relative and "\\" not in relative and not relative.startswith("/") and all(part not in ("", ".", "..") for part in relative.split("/")), "UNSAFE_PACKAGE_PATH")
        require(relative not in seen, "DUPLICATE_PACKAGE_PATH")
        seen.add(relative)
        path = root / relative
        require(path.is_file() and not path.is_symlink() and root in path.resolve().parents, "REGULAR_CONTAINED_PACKAGE_FILE_REQUIRED")
        require(path.stat().st_size == entry["bytes"] and digest(path) == entry["sha256"], "PACKAGE_HASH_MISMATCH")
    return seen


def validate_release(manifest):
    require(manifest.get("schema") == 1 and manifest.get("kind") == "canvas-image-release", "VERIFIED_RELEASE_MANIFEST_REQUIRED")
    require(re.fullmatch(r"[a-f0-9]{40}", manifest.get("commit", "")) and manifest.get("platform") == "linux/amd64", "EXACT_AMD64_COMMIT_REQUIRED")
    images = manifest.get("images", {})
    require(set(images) == {"api", "web"} and all(re.fullmatch(r"sha256:[a-f0-9]{64}", row.get("id", "")) for row in images.values()), "EXACT_APPLICATION_IMAGE_IDS_REQUIRED")
    verified = manifest.get("verification", {})
    require(verified.get("status") == "passed" and verified.get("commit") == manifest["commit"] and verified.get("platform") == manifest["platform"]
            and verified.get("imageIds") == {role: row["id"] for role, row in images.items()}
            and set(verified.get("checks", [])) == {"runtime", "production-stack", "browser-smoke"}
            and re.fullmatch(r"\d+", str(verified.get("workflowRunId", ""))), "SAME_IMAGES_MUST_ALREADY_PASS_CI")
    return manifest


def validate_tools(manifest, release):
    require(manifest.get("schema") == 1 and manifest.get("kind") == "canvas-stage-smoke-tools"
            and manifest.get("commit") == release["commit"] and manifest.get("platform") == release["platform"], "MATCHING_STAGE_TOOL_PACKAGE_REQUIRED")
    require(set(manifest.get("images", {})) == set(ROLES)
            and all(re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in manifest["images"].values()), "EXACT_TEST_INFRASTRUCTURE_IDS_REQUIRED")
    require(manifest.get("workflowRunId") == release["verification"]["workflowRunId"], "SAME_CI_INFRASTRUCTURE_REQUIRED")


def command(arguments, output=None):
    # Never inherit production-related Compose/project/proxy overrides.
    environment = {key: value for key, value in os.environ.items() if not key.startswith(("COMPOSE_", "DOCKER_")) and key.upper() not in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")}
    if arguments[0] == "docker":
        arguments = ["docker", "--host", "unix:///var/run/docker.sock"] + arguments[1:]
    result = subprocess.run(arguments, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    if output is not None:
        write_new(output, result.stdout + (b"\n" + result.stderr if result.stderr else b""), binary=True)
    require(result.returncode == 0, "COMMAND_FAILED:" + arguments[0] + (":" + output.name if output else ""))
    return result.stdout


def docker_json(*arguments):
    return json.loads(command(["docker"] + list(arguments)).decode("utf-8"))


def compose(state, *arguments):
    return ["docker", "compose", "-p", state["project"], "--env-file", "/dev/null", "-f", str(Path(state["directory"]) / "compose.private.json")] + list(arguments)


def validate_identity(state):
    require(re.fullmatch(r"[a-f0-9]{40}", state.get("commit", "")) and re.fullmatch(r"[a-f0-9]{32}", state.get("runId", "")), "STAGE_IDENTITY_REQUIRED")
    require(re.fullmatch(r"canvas-staging-" + state["commit"][:12] + r"-[a-f0-9]{12}", state.get("project", "")), "NON_PRODUCTION_PROJECT_REQUIRED")
    require(state.get("platform") == "linux/amd64", "AMD64_STAGE_REQUIRED")
    ports = (state.get("webPort"), state.get("edgePort"))
    require(all(isinstance(port, int) and 1024 <= port <= 65535 and port not in (3000, 3100, 5432, 6379, 9000, 9001) for port in ports) and ports[0] != ports[1], "EXPLICIT_DISTINCT_STAGING_PORTS_REQUIRED")


def stage_compose(state, credentials, scripts):
    validate_identity(state)
    labels = {LABEL: state["runId"], PROJECT_LABEL: state["project"]}
    images = state["images"]
    common = {"restart": "no", "networks": ["default"], "labels": labels, "pull_policy": "never"}
    environment = {
        "NODE_ENV": "production", "PORT": "3100", "HOST": "0.0.0.0", "SESSION_COOKIE_NAME": "canvas_ci_session", "SESSION_TTL_SECONDS": "28800", "TRUST_PROXY": "true",
        "DATABASE_URL": "postgres://wireless_canvas:" + credentials["postgres"] + "@postgres:5432/wireless_canvas", "REDIS_URL": "redis://redis:6379",
        "PROVIDER_ENCRYPTION_KEY": credentials["encryption"], "TASK_MOCK_MODE": "false", "AUTH_ENABLED": "true", "OA_LOGIN_ENABLED": "false", "CREDITS_ENABLED": "true", "ROLE_PORTALS_ENABLED": "true",
        "WORKER_CONCURRENCY": "2", "WORKER_SHUTDOWN_GRACE_SECONDS": "120", "S3_ENDPOINT": "http://minio:9000", "S3_PUBLIC_ENDPOINT": "", "S3_REGION": "us-east-1", "S3_BUCKET": "canvas-ci",
        "S3_ACCESS_KEY_ID": "canvas-ci", "S3_SECRET_ACCESS_KEY": credentials["storage"], "S3_FORCE_PATH_STYLE": "true",
        "CANVAS_SMOKE_MODE": "staging", "CANVAS_SMOKE_PROJECT": state["project"], "CANVAS_SMOKE_COMMIT": state["commit"], "CANVAS_SMOKE_ALLOW_SEED": "isolated-compose-only", "CANVAS_SMOKE_SOURCE_ROOT": "/app/src",
    }
    mounted_scripts = {"type": "bind", "source": str(scripts), "target": "/smoke", "read_only": True, "bind": {"create_host_path": False}}
    def service(image, **options):
        return dict(common, image=image, **options)
    def health(arguments, interval="5s", retries=30):
        return {"test": ["CMD"] + arguments, "interval": interval, "timeout": "3s", "retries": retries}
    services = {
        "postgres": service(images["postgres"], environment={"POSTGRES_DB": "wireless_canvas", "POSTGRES_USER": "wireless_canvas", "POSTGRES_PASSWORD": credentials["postgres"]}, volumes=["postgres-data:/var/lib/postgresql/data"], healthcheck=health(["pg_isready", "-U", "wireless_canvas"])),
        "redis": service(images["redis"], command=["redis-server", "--appendonly", "yes"], volumes=["redis-data:/data"], healthcheck=health(["redis-cli", "ping"])),
        "minio": service(images["minio"], command=["server", "/data"], environment={"MINIO_ROOT_USER": "canvas-ci", "MINIO_ROOT_PASSWORD": credentials["storage"]}, volumes=["minio-data:/data"], healthcheck=health(["mc", "ready", "local"])),
        "minio-init": service(images["minio-init"], entrypoint=["/bin/sh", "-ec"], command=['mc alias set local http://minio:9000 "$$S3_ACCESS_KEY_ID" "$$S3_SECRET_ACCESS_KEY" && mc mb local/$$S3_BUCKET && mc version enable local/$$S3_BUCKET'], environment={"S3_ACCESS_KEY_ID": "canvas-ci", "S3_SECRET_ACCESS_KEY": credentials["storage"], "S3_BUCKET": "canvas-ci"}),
        "api": service(images["api"], command=["bun", "src/index.ts"], environment=environment, volumes=[mounted_scripts], healthcheck=health(["wget", "-q", "-O", "-", "http://127.0.0.1:3100/api/health"])),
        "worker": service(images["api"], command=["bun", "src/worker.ts"], environment=environment, volumes=[mounted_scripts], healthcheck=health(["bun", "src/worker-healthcheck.ts"], "10s", 20), stop_grace_period="130s"),
        "web": service(images["web"], networks=["default", "ingress"], ports=["127.0.0.1:%d:3000" % state["webPort"]]),
        "mock-provider": service(images["api"], command=["bun", "/smoke/mock-provider.ts"], environment={"HOST": "0.0.0.0", "PORT": "4180", "CANVAS_SMOKE_PROJECT": state["project"]}, volumes=[mounted_scripts], read_only=True, tmpfs=["/tmp:rw,noexec,nosuid,size=64m"], cap_drop=["ALL"], security_opt=["no-new-privileges:true"], healthcheck=health(["bun", "-e", 'const r=await fetch("http://127.0.0.1:4180/health");if(!r.ok)process.exit(1)'])),
    }
    return {"name": state["project"], "services": services,
            "networks": {"default": {"name": state["project"] + "_default", "internal": True, "labels": labels},
                         "ingress": {"name": state["project"] + "_ingress", "internal": False, "labels": labels}},
            "volumes": {name: {"labels": labels} for name in VOLUMES}}


def nginx_config(state):
    validate_identity(state)
    # Independent, loopback-only server block; never inserted into a live site.
    return '''# Isolated stage only; install as a NEW file, never overwrite a site.
server {
    listen 127.0.0.1:%(edgePort)d;
    server_name localhost;
    access_log off;
    add_header X-Canvas-Staging "%(runId)s" always;
    client_max_body_size 200m;
    location / {
        proxy_pass http://127.0.0.1:%(webPort)d;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 240s;
        proxy_send_timeout 240s;
        proxy_buffering off;
        proxy_cache off;
        proxy_next_upstream off;
        gzip off;
    }
}
''' % state


def prepare(release_root, tools_root, directory, web_port, edge_port):
    release = validate_release(read_json(release_root / "release-manifest.json"))
    require("images.tar.gz" in verify_files(release_root, release), "APPLICATION_ARCHIVE_REQUIRED")
    tools = read_json(tools_root / "stage-tools-manifest.json")
    validate_tools(tools, release)
    files = verify_files(tools_root, tools)
    require({"stage-images.tar", "stage-smoke.py", "stage-smoke-README.md"}.issubset(files) and all("scripts/" + name in files for name in SCRIPT_FILES), "COMPLETE_STAGE_TOOLS_REQUIRED")
    state = {"schema": 1, "kind": "canvas-isolated-staging", "commit": release["commit"], "version": release["version"], "platform": release["platform"],
             "runId": secrets.token_hex(16), "project": "canvas-staging-" + release["commit"][:12] + "-" + secrets.token_hex(6),
             "webPort": web_port, "edgePort": edge_port, "directory": str(directory), "releaseDirectory": str(release_root), "toolsDirectory": str(tools_root),
             "releaseManifestSha256": digest(release_root / "release-manifest.json"), "toolsManifestSha256": digest(tools_root / "stage-tools-manifest.json"),
             "images": dict(tools["images"], **{role: row["id"] for role, row in release["images"].items()})}
    validate_identity(state)
    credentials = {"postgres": secrets.token_hex(24), "storage": secrets.token_hex(24), "encryption": base64.b64encode(secrets.token_bytes(32)).decode("ascii")}
    directory.mkdir(mode=0o700)
    write_json(directory / "compose.private.json", stage_compose(state, credentials, tools_root / "scripts"))
    write_new(directory / "baota-staging.conf", nginx_config(state))
    state["composeSha256"] = digest(directory / "compose.private.json")
    state["nginxSha256"] = digest(directory / "baota-staging.conf")
    write_json(directory / "stage-state.private.json", state)
    return state


def load_state(directory, packages=True):
    state = read_json(directory / "stage-state.private.json")
    validate_identity(state)
    require(state.get("kind") == "canvas-isolated-staging" and state.get("directory") == str(directory), "STAGING_STATE_DIRECTORY_MISMATCH")
    require(digest(directory / "compose.private.json") == state["composeSha256"] and digest(directory / "baota-staging.conf") == state["nginxSha256"], "PREPARED_CONFIGURATION_CHANGED")
    if packages:
        release_root = absolute_directory(state["releaseDirectory"])
        tools_root = absolute_directory(state["toolsDirectory"])
        require(digest(release_root / "release-manifest.json") == state["releaseManifestSha256"] and digest(tools_root / "stage-tools-manifest.json") == state["toolsManifestSha256"], "PACKAGE_MANIFEST_CHANGED")
        release = validate_release(read_json(release_root / "release-manifest.json"))
        tools = read_json(tools_root / "stage-tools-manifest.json")
        validate_tools(tools, release)
        verify_files(release_root, release)
        verify_files(tools_root, tools)
    return state


def assert_image(image, state, role):
    require(image["Id"] == state["images"][role] and image["Os"] == "linux" and image["Architecture"] == "amd64", "EXACT_STAGE_IMAGE_REQUIRED")
    labels = image.get("Config", {}).get("Labels") or {}
    if role in ("api", "web", "browser"):
        require(labels.get("org.opencontainers.image.revision") == state["commit"], "IMAGE_COMMIT_MISMATCH")
    if role == "browser":
        require(labels.get("io.canvas.stage.kind") == "browser-runner", "BROWSER_TOOL_IMAGE_REQUIRED")


def resource_matches(resource, state, kind, require_running=False):
    labels = resource.get("Config", {}).get("Labels") if kind == "container" else resource.get("Labels")
    labels = labels or {}
    require(labels.get(LABEL) == state["runId"] and labels.get(PROJECT_LABEL) == state["project"] and labels.get("com.docker.compose.project") == state["project"], "RESOURCE_IDENTITY_MISMATCH")
    if kind == "container":
        role = labels.get("com.docker.compose.service")
        require(role in SERVICES and resource["Name"].lstrip("/").startswith(state["project"] + "-"), "UNKNOWN_STAGE_CONTAINER")
        expected = state["images"]["api" if role in ("api", "worker", "mock-provider") else role]
        expected_networks = {state["project"] + "_default"}
        if role == "web":
            expected_networks.add(state["project"] + "_ingress")
        connected = set(resource["NetworkSettings"]["Networks"])
        host = resource.get("HostConfig", {})
        # Recovery accepts only missing expected attachments, never a foreign
        # network. Strict verification still requires the complete topology.
        require(resource["Image"] == expected and host.get("NetworkMode") in expected_networks
                and connected.issubset(expected_networks), "STAGE_CONTAINER_IMAGE_OR_NETWORK_MISMATCH")
        expected_ports = {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(state["webPort"])}]} if role == "web" else {}
        published = {port: bindings for port, bindings in (resource["NetworkSettings"].get("Ports") or {}).items() if bindings}
        require(not host.get("PublishAllPorts") and (host.get("PortBindings") or {}) == expected_ports
                and all(port in expected_ports and bindings == expected_ports[port] for port, bindings in published.items()), "STAGE_CONTAINER_PORT_MISMATCH")
        if require_running:
            require(resource["State"]["Running"] and connected == expected_networks and published == expected_ports, "INCOMPLETE_RUNNING_STAGE_CONTAINER")
        mounts = resource.get("Mounts", [])
        for mount in mounts:
            if mount["Type"] == "volume":
                expected_volume = {"postgres": ("postgres-data", "/var/lib/postgresql/data"), "redis": ("redis-data", "/data"), "minio": ("minio-data", "/data")}.get(role)
                require(expected_volume and mount["Name"] == state["project"] + "_" + expected_volume[0] and mount["Destination"] == expected_volume[1], "FOREIGN_VOLUME_MOUNT_REFUSED")
            elif mount["Type"] == "tmpfs":
                require(role == "mock-provider" and mount["Destination"] == "/tmp", "UNKNOWN_TMPFS_MOUNT_REFUSED")
            else:
                require(role in ("api", "worker", "mock-provider") and mount["Type"] == "bind" and mount["Destination"] == "/smoke" and mount["Source"] == str(Path(state["toolsDirectory"]) / "scripts") and not mount["RW"], "FOREIGN_BIND_MOUNT_REFUSED")
        if role in ("api", "worker"):
            environment = dict(value.split("=", 1) for value in resource["Config"].get("Env", []))
            require(resource["Config"].get("Cmd") == ["bun", "src/index.ts" if role == "api" else "src/worker.ts"]
                    and environment.get("NODE_ENV") == "production" and environment.get("TASK_MOCK_MODE") == "false"
                    and environment.get("AUTH_ENABLED") == "true" and environment.get("OA_LOGIN_ENABLED") == "false"
                    and environment.get("REDIS_URL") == "redis://redis:6379" and environment.get("S3_ENDPOINT") == "http://minio:9000", "FORMAL_ISOLATED_RUNTIME_REQUIRED")
        return resource["Id"]
    if kind == "volume":
        require(resource["Name"] in [state["project"] + "_" + name for name in VOLUMES], "UNKNOWN_STAGE_VOLUME")
        return resource["Name"]
    expected_networks = {state["project"] + "_default": ("default", True), state["project"] + "_ingress": ("ingress", False)}
    expected = expected_networks.get(resource["Name"])
    require(expected and resource.get("Internal") is expected[1] and resource.get("Driver") == "bridge"
            and labels.get("com.docker.compose.network") == expected[0], "UNKNOWN_STAGE_NETWORK_OR_ISOLATION")
    return resource["Id"]


def validate_network_membership(resources, require_running=False):
    networks = {row["Name"]: row for row in resources["networks"]}
    containers = {row["Id"]: row for row in resources["containers"]}
    require(len(networks) == len(resources["networks"]), "DUPLICATE_STAGE_NETWORK_NAME")
    for container in containers.values():
        for name, endpoint in container["NetworkSettings"]["Networks"].items():
            identity = endpoint.get("NetworkID")
            if not identity and not container["State"]["Running"] and not require_running:
                continue  # Docker-created but not attached; names/mode were checked above.
            require(name in networks and identity == networks[name]["Id"], "STAGE_NETWORK_ENDPOINT_ID_MISMATCH")
            if require_running:
                require(container["Id"] in networks[name].get("Containers", {}), "STAGE_NETWORK_ATTACHMENT_MISMATCH")
    for name, network in networks.items():
        for identity in network.get("Containers", {}):
            require(identity in containers, "FOREIGN_CONTAINER_ON_STAGE_NETWORK")
            endpoint = containers[identity]["NetworkSettings"]["Networks"].get(name, {})
            require(endpoint.get("NetworkID") == network["Id"], "STAGE_NETWORK_ATTACHMENT_MISMATCH")


def inventory(state, require_running=False):
    result = {"containers": [], "volumes": [], "networks": []}
    for singular, plural, listing in (("container", "containers", ["ps", "-aq"]), ("volume", "volumes", ["volume", "ls", "-q"]), ("network", "networks", ["network", "ls", "-q"])):
        ids = command(["docker"] + listing + ["--filter", "label=" + LABEL + "=" + state["runId"]]).decode().split()
        if ids:
            rows = docker_json(*((["inspect"] if singular == "container" else [singular, "inspect"]) + ids))
            for row in rows:
                resource_matches(row, state, singular, require_running)
                result[plural].append(row)
    validate_network_membership(result, require_running)
    if require_running:
        roles = {row["Config"]["Labels"]["com.docker.compose.service"] for row in result["containers"]}
        require(roles == set(SERVICES) - {"minio-init"} and len(result["containers"]) == len(roles) and all(row["State"]["Running"] for row in result["containers"]), "COMPLETE_RUNNING_STAGE_REQUIRED")
        require(len(result["volumes"]) == 3 and len(result["networks"]) == 2, "COMPLETE_ISOLATED_DATA_RESOURCES_REQUIRED")
    return result


def start_stage(state):
    directory = Path(state["directory"])
    require(not (directory / "up.private.json").exists(), "STAGE_UP_IS_NOT_REPLAYABLE")
    command(["docker", "compose", "version"], directory / "compose-version.private.txt")
    require(command(["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"] ).decode().strip() in ("linux/x86_64", "linux/amd64"), "LINUX_AMD64_DOCKER_REQUIRED")
    for arguments in (["ps", "-aq"], ["volume", "ls", "-q"], ["network", "ls", "-q"]):
        require(not command(["docker"] + arguments + ["--filter", "label=com.docker.compose.project=" + state["project"]]).strip(), "STAGING_PROJECT_ALREADY_EXISTS")
    for port in (state["webPort"], state["edgePort"]):
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                # The separate staging Nginx listener may already be installed.
                require(port == state["edgePort"], "STAGING_WEB_PORT_ALREADY_IN_USE")
    command(["docker", "load", "-i", str(Path(state["releaseDirectory"]) / "images.tar.gz")], directory / "application-load.private.log")
    command(["docker", "load", "-i", str(Path(state["toolsDirectory"]) / "stage-images.tar")], directory / "tools-load.private.log")
    for role, identity in state["images"].items():
        assert_image(docker_json("image", "inspect", identity)[0], state, role)
    command(compose(state, "config", "--quiet"), directory / "compose-check.private.log")
    command(compose(state, "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "postgres", "redis", "minio"), directory / "infra-up.private.log")
    command(compose(state, "run", "--rm", "--no-deps", "--pull", "never", "minio-init"), directory / "minio-init.private.log")
    command(compose(state, "run", "--rm", "--no-deps", "--pull", "never", "api", "bun", "src/migrate.ts"), directory / "migration.private.log")
    # Seed precedes API startup; no guest/bootstrap can create unrelated rows.
    seed = command(compose(state, "run", "--rm", "--no-deps", "--pull", "never", "api", "bun", "--no-env-file", "/smoke/seed.ts"))
    write_new(directory / "seed.private.json", seed, binary=True)
    require(json.loads(seed.decode())["project"] == state["project"], "SEED_PROJECT_MISMATCH")
    command(compose(state, "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "180", "api", "worker", "web", "mock-provider"), directory / "application-up.private.log")
    write_json(directory / "up.private.json", {"schema": 1, "project": state["project"], "runId": state["runId"], "resources": inventory(state, True)})


def up(state):
    journal = Path(state["directory"]) / "created-resources.private.json"
    require(not journal.exists(), "STAGE_UP_IS_NOT_REPLAYABLE")
    try:
        start_stage(state)
    finally:
        # On failure preserve a bounded recovery journal; never auto-delete.
        write_json(journal, inventory(state))


def outer_marker(state):
    url = "http://127.0.0.1:%d/deployment-release.json" % state["edgePort"]
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(url, headers={"Cache-Control": "no-store"}), timeout=10) as response:
        require(response.status == 200 and response.headers.get("X-Canvas-Staging") == state["runId"], "ACTUAL_SEPARATE_NGINX_ENTRY_REQUIRED")
        value = json.loads(response.read().decode("utf-8"))
        require(value == {"schema": 1, "version": state["version"], "commit": state["commit"]}, "OUTER_ENTRY_RELEASE_MISMATCH")
    return url


def browser_arguments(state):
    validate_identity(state)
    arguments = ["docker", "run", "--rm", "--pull", "never", "--init", "--network", "host", "--read-only", "--shm-size", "1g", "--tmpfs", "/tmp:rw,nosuid,size=512m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                 "--mount", "type=bind,source=" + state["directory"] + ",target=/evidence"]
    environment = {"CANVAS_SMOKE_MODE": "staging", "CANVAS_SMOKE_PROJECT": state["project"], "CANVAS_SMOKE_COMMIT": state["commit"], "CANVAS_SMOKE_RUN_ID": state["runId"],
                   "CANVAS_SMOKE_BASE_URL": "http://127.0.0.1:%d" % state["edgePort"], "CANVAS_SMOKE_OUTPUT_DIR": "/evidence", "CANVAS_SMOKE_API_IMAGE_ID": state["images"]["api"], "CANVAS_SMOKE_WEB_IMAGE_ID": state["images"]["web"]}
    for key, value in environment.items():
        arguments += ["-e", key + "=" + value]
    return arguments + [state["images"]["browser"]]


def verify(state, installed_nginx):
    directory = Path(state["directory"])
    require((directory / "up.private.json").is_file(), "SUCCESSFUL_STAGE_UP_REQUIRED")
    require(installed_nginx.is_absolute() and installed_nginx.name == state["project"] + ".conf" and installed_nginx.is_file() and not installed_nginx.is_symlink()
            and digest(installed_nginx) == state["nginxSha256"], "EXACT_SEPARATE_INSTALLED_NGINX_CONFIG_REQUIRED")
    require(not (directory / "provider-before.private.json").exists(), "STAGE_VERIFY_IS_NOT_REPLAYABLE")
    before = inventory(state, True)
    write_json(directory / "verify-before.private.json", before)
    entry = outer_marker(state)
    def provider(path):
        return command(compose(state, "exec", "-T", "mock-provider", "bun", "--no-env-file", "-e", 'const r=await fetch("http://127.0.0.1:4180"+process.argv[1]);if(!r.ok)throw Error("Local evidence failed");await Bun.write(Bun.stdout,await r.arrayBuffer());', path))
    fresh = provider("/__smoke/receipt")
    require(json.loads(fresh.decode())["calls"] == [], "FRESH_UNPAID_PROVIDER_REQUIRED")
    write_new(directory / "provider-before.private.json", fresh, binary=True)
    write_new(directory / "upload.png", provider("/fixtures/upload.png"), binary=True)
    command(browser_arguments(state), directory / "browser.private.log")
    write_new(directory / "provider-after.private.json", provider("/__smoke/receipt"), binary=True)
    seal = ["docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--mount", "type=bind,source=" + str(Path(state["toolsDirectory"]) / "scripts") + ",target=/smoke,readonly", "--mount", "type=bind,source=" + state["directory"] + ",target=/evidence"]
    for key, value in {"MODE": "staging", "PROJECT": state["project"], "COMMIT": state["commit"], "OUTPUT_DIR": "/evidence", "API_IMAGE_ID": state["images"]["api"], "WEB_IMAGE_ID": state["images"]["web"]}.items():
        seal += ["-e", "CANVAS_SMOKE_" + key + "=" + value]
    command(seal + [state["images"]["api"], "bun", "--no-env-file", "/smoke/receipt.ts"], directory / "receipt.private.log")
    browser = read_json(directory / "staging-browser-smoke.json")
    require(browser.get("kind") == "canvas-stage-browser-smoke" and browser.get("project") == state["project"] and browser.get("status") == "passed" and browser.get("checks") == CHECKS, "STAGE_BROWSER_NOT_PASSED")
    after = inventory(state, True)
    write_json(directory / "verify-after.private.json", after)
    require({row["Id"] for row in before["containers"]} == {row["Id"] for row in after["containers"]}, "STAGE_CONTAINERS_CHANGED_DURING_SMOKE")
    outer_marker(state)
    receipt = {"schema": 1, "kind": "canvas-stage-verification", "status": "passed", "commit": state["commit"], "version": state["version"], "platform": state["platform"], "project": state["project"], "runId": state["runId"],
               "imageIds": {role: state["images"][role] for role in ("api", "web")}, "toolImageIds": {role: state["images"][role] for role in ROLES}, "entry": entry, "nginxSha256": state["nginxSha256"], "checks": CHECKS, "paid": False,
               "releaseManifestSha256": state["releaseManifestSha256"], "toolsManifestSha256": state["toolsManifestSha256"]}
    write_json(directory / "stage-verification.json", receipt)


def cleanup_plan(state, resources, recorded):
    """No prefix deletion: validate the whole set before the first mutation."""
    validate_identity(state)
    for plural, identity in (("containers", "Id"), ("networks", "Id"), ("volumes", "Name")):
        previous = {row[identity]: row for row in recorded[plural]}
        require(all(row[identity] in previous for row in resources[plural]), "UNRECORDED_STAGE_RESOURCE_REFUSED")
        if plural == "volumes":
            require(all(row.get("CreatedAt") and row.get("CreatedAt") == previous[row[identity]].get("CreatedAt") for row in resources[plural]), "REPLACED_STAGE_VOLUME_REFUSED")
    allowed_containers = {resource_matches(row, state, "container") for row in resources["containers"]}
    for network in resources["networks"]:
        resource_matches(network, state, "network")
        require(set(network.get("Containers", {})).issubset(allowed_containers), "FOREIGN_CONTAINER_ON_STAGE_NETWORK")
    for volume in resources["volumes"]:
        resource_matches(volume, state, "volume")
    validate_network_membership(resources)
    return (["docker", "rm", "-f"] + sorted(allowed_containers) if allowed_containers else None,
            [["docker", "volume", "rm", row["Name"]] for row in resources["volumes"]],
            [["docker", "network", "rm", row["Id"]] for row in resources["networks"]])


def cleanup(state):
    directory = Path(state["directory"])
    resources = inventory(state)
    recorded = read_json(directory / "created-resources.private.json")
    remove_containers, remove_volumes, remove_networks = cleanup_plan(state, resources, recorded)
    for volume in resources["volumes"]:
        attached = set(command(["docker", "ps", "-aq", "--filter", "volume=" + volume["Name"]]).decode().split())
        allowed = {row["Id"] for row in resources["containers"]}
        require(all(any(identity.startswith(short) for identity in allowed) for short in attached), "FOREIGN_CONTAINER_USES_STAGE_VOLUME")
    write_json(directory / ("cleanup-plan-" + secrets.token_hex(4) + ".private.json"), {"resources": resources})
    if remove_containers:
        command(remove_containers)
    for arguments in remove_volumes + remove_networks:
        command(arguments)
    remaining = inventory(state)
    require(not any(remaining.values()), "STAGING_CLEANUP_INCOMPLETE")
    print("Only this run's containers, volumes and two isolated-stage networks were removed; evidence, images and separate Nginx configuration were retained.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    prepare_parser = sub.add_parser("prepare")
    for name in ("release", "tools", "state"):
        prepare_parser.add_argument("--" + name, required=True)
    prepare_parser.add_argument("--web-port", type=int, required=True)
    prepare_parser.add_argument("--edge-port", type=int, required=True)
    for name in ("up", "verify", "cleanup"):
        child = sub.add_parser(name)
        child.add_argument("--state", required=True)
        if name == "verify":
            child.add_argument("--nginx-config", required=True)
    args = parser.parse_args()
    if args.action == "prepare":
        state = prepare(absolute_directory(args.release), absolute_directory(args.tools), absolute_directory(args.state, False), args.web_port, args.edge_port)
        print(json.dumps({"project": state["project"], "newNginxFilename": state["project"] + ".conf", "entry": "http://127.0.0.1:%d" % state["edgePort"]}))
        return
    state = load_state(absolute_directory(args.state), packages=args.action != "cleanup")
    if args.action == "up":
        up(state)
    elif args.action == "verify":
        verify(state, Path(args.nginx_config))
    else:
        cleanup(state)


if __name__ == "__main__":
    try:
        main()
    except (Rejected, OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("STAGING_REFUSED: " + str(error), file=sys.stderr)
        sys.exit(1)
