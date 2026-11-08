#!/usr/bin/env python3
"""Read-only HTTP regression against an already running, isolated release Web container.

Run after stack-smoke.sh starts its exact candidate images and validates the marker.
No builds, pulls, writes inside containers, authentication, uploads or model calls.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, build_opener


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


class NoRedirect(HTTPRedirectHandler):
    """A candidate must not send this loopback-only probe to another endpoint."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--container", required=True)
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--expected-image-id", required=True)
    parser.add_argument("--expected-commit", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--docker-host", help="Explicit local Unix socket used by the isolated CI stack")
    args = parser.parse_args()
    require(re.fullmatch(r"[a-f0-9]{12,64}", args.container), "EXACT_CONTAINER_ID_REQUIRED")
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", args.expected_image_id), "EXACT_IMAGE_ID_REQUIRED")
    require(re.fullmatch(r"[a-f0-9]{40}", args.expected_commit), "FULL_COMMIT_REQUIRED")
    base = urlsplit(args.base_url)
    require(base.scheme == "http" and base.hostname == "127.0.0.1" and base.port
            and not base.username and not base.password and base.path in ("", "/")
            and not base.query and not base.fragment, "ISOLATED_LOOPBACK_HTTP_REQUIRED")
    require(not args.output.exists(), "NEW_RECEIPT_REQUIRED")
    require(args.output.parent.is_dir(), "EXISTING_EVIDENCE_DIRECTORY_REQUIRED")
    require(shutil.which("docker"), "LOCAL_DOCKER_CLI_REQUIRED")
    require(not any(os.environ.get(key) for key in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")),
            "IMPLICIT_DOCKER_OVERRIDE_REFUSED")
    if args.docker_host is not None:
        host = urlsplit(args.docker_host)
        require(host.scheme == "unix" and not host.netloc and host.path.startswith("/")
                and host.path != "/" and not host.query and not host.fragment
                and not re.search(r"\s", args.docker_host), "LOCAL_UNIX_DOCKER_HOST_REQUIRED")
        require(os.environ.get("DOCKER_HOST", args.docker_host) == args.docker_host, "DOCKER_HOST_MISMATCH")
    else:
        require(not os.environ.get("DOCKER_HOST"), "IMPLICIT_DOCKER_OVERRIDE_REFUSED")

    def command(*values):
        result = subprocess.run(["docker", *values], check=True, capture_output=True, timeout=30)
        return result.stdout

    if args.docker_host is not None:
        docker_selector = ["--host", args.docker_host]
    else:
        context = command("context", "show").decode().strip()
        require(context and not re.search(r"\s", context), "DOCKER_CONTEXT_INVALID")
        endpoint = json.loads(command("context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"))
        require(isinstance(endpoint, str) and (endpoint.startswith("unix:///") or endpoint.startswith("npipe:////./pipe/")),
                "LOCAL_DOCKER_ENDPOINT_REQUIRED")
        docker_selector = ["--context", context]
    container, = json.loads(command(*docker_selector, "inspect", args.container))
    labels = container["Config"].get("Labels") or {}
    project = labels.get("com.docker.compose.project", "")
    require(re.fullmatch(r"ci-release-[0-9]+-[0-9]+-(amd64|arm64)", project), "ISOLATED_RELEASE_STACK_REQUIRED")
    require(labels.get("com.docker.compose.service") == "web", "RELEASE_WEB_CONTAINER_REQUIRED")
    require(container["State"]["Running"] is True and container["Image"] == args.expected_image_id, "RUNNING_IMAGE_ID_MISMATCH")
    ports = container["NetworkSettings"]["Ports"].get("3000/tcp")
    require(ports == [{"HostIp": "127.0.0.1", "HostPort": str(base.port)}], "CONTAINER_HTTP_PORT_MISMATCH")
    image, = json.loads(command(*docker_selector, "image", "inspect", args.expected_image_id))
    require(image["Os"] == "linux", "LINUX_IMAGE_REQUIRED")
    require(image["Architecture"] == project.rsplit("-", 1)[1], "IMAGE_PLATFORM_MISMATCH")
    require(image["Config"]["Labels"].get("org.opencontainers.image.revision") == args.expected_commit, "IMAGE_COMMIT_MISMATCH")

    def file_bytes(path):
        return command(*docker_selector, "exec", args.container, "cat", path)

    assets = command(*docker_selector, "exec", args.container, "find", "/usr/share/nginx/html/assets", "-maxdepth", "1", "-type", "f").decode().splitlines()
    require(not any(re.fullmatch(r"/usr/share/nginx/html/assets/pdf\.worker-[A-Za-z0-9_-]+\.(?:mjs|js)", path) for path in assets),
            "LEGACY_NON_MINIFIED_PDF_WORKER_NOT_ALLOWED")
    workers = [path for path in assets if re.fullmatch(r"/usr/share/nginx/html/assets/pdf\.worker\.min-[A-Za-z0-9_-]+\.mjs", path)]
    require(len(workers) == 1, "ONE_REAL_BUILT_PDF_WORKER_REQUIRED")
    worker = workers[0]
    worker_name = Path(worker).name
    wrappers = [path for path in assets if re.fullmatch(r"/usr/share/nginx/html/assets/pdf\.worker\.min-[A-Za-z0-9_-]+\.js", path)]
    require(len(wrappers) == 1, "WORKER_WRAPPER_REFERENCE_MISMATCH")
    wrapper_bytes = file_bytes(wrappers[0])
    require(f"/assets/{worker_name}".encode() in wrapper_bytes and b"/assets/pdf.worker-" not in wrapper_bytes,
            "WORKER_WRAPPER_REFERENCE_MISMATCH")
    css = next((path for path in assets if path.endswith(".css")), None)
    require(css, "REAL_BUILT_CSS_REQUIRED")
    opener = build_opener(ProxyHandler({}), NoRedirect())
    receipts = []

    def fetch(path):
        address = args.base_url.rstrip("/") + path
        try:
            response = opener.open(address, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            require(response.geturl() == address, "UNEXPECTED_HTTP_REDIRECT")
            body = response.read()
            headers = {name.lower(): value for name, value in response.headers.items()
                       if name.lower() in {"content-type", "content-length", "cache-control", "x-content-type-options", "etag"}}
            receipts.append({"path": path, "status": response.status, "headers": headers,
                             "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
            return response.status, headers, body

    status, _, marker = fetch("/deployment-release.json")
    require(status == 200 and json.loads(marker).get("commit") == args.expected_commit, "HTTP_MARKER_COMMIT_MISMATCH")
    for artifact, mime in [(worker, {"application/javascript", "text/javascript"}),
                           (wrappers[0], {"application/javascript", "text/javascript"}), (css, {"text/css"})]:
        status, headers, body = fetch("/assets/" + Path(artifact).name)
        require(status == 200, "BUILT_ASSET_HTTP_FAILURE")
        require(headers.get("content-type", "").split(";", 1)[0].strip().lower() in mime, "BUILT_ASSET_MIME_MISMATCH")
        require(headers.get("x-content-type-options", "").lower() == "nosniff", "NOSNIFF_MUST_BE_PRESERVED")
        require("immutable" in headers.get("cache-control", ""), "FINGERPRINT_CACHE_MISSING")
        require(body == file_bytes(artifact), "HTTP_BYTES_DIFFER_FROM_BUILT_IMAGE")
    status, headers, body = fetch("/index.html")
    require(status == 200 and headers.get("content-type", "").startswith("text/html") and b'<div id="root">' in body, "HTML_MAPPING_REGRESSION")
    require("no-store" in headers.get("cache-control", ""), "INDEX_CACHE_REGRESSION")
    status, headers, _ = fetch("/assets/pdf.worker.min-regressionMissing.mjs")
    require(status == 404 and "immutable" not in headers.get("cache-control", ""), "MISSING_WORKER_MUST_BE_UNCACHED_404")
    receipt = {"schema": 1, "status": "passed", "kind": "built-container-pdf-worker-http",
               "commit": args.expected_commit, "imageId": args.expected_image_id, "containerId": container["Id"],
               "project": project, "platform": f"{image['Os']}/{image['Architecture']}",
               "createdAt": datetime.now(timezone.utc).isoformat(), "paid": False, "checks": receipts}
    with args.output.open("x", encoding="utf-8") as output:
        json.dump(receipt, output, indent=2)
        output.write("\n")
    print("BUILT_CONTAINER_PDF_WORKER_HTTP_PASSED")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"PDF_WORKER_HTTP_REGRESSION_FAILED: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
