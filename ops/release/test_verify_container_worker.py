"""No-Docker tests of the receipt verifier; these do not prove container HTTP behavior."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import urlsplit


SCRIPT = Path(__file__).with_name("verify-container-worker.py")
spec = importlib.util.spec_from_file_location("worker_http_check", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class Response(io.BytesIO):
    def __init__(self, address, status, headers, body):
        super().__init__(body)
        self.address, self.status, self.headers = address, status, headers

    def geturl(self):
        return self.address


class WorkerReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.output = Path(self.temporary.name) / "receipt.json"
        self.commit = "a" * 40
        self.image_id = "sha256:" + "b" * 64
        self.container_id = "c" * 64
        self.worker = "/usr/share/nginx/html/assets/pdf.worker.min-abcdefgh.mjs"
        self.wrapper = "/usr/share/nginx/html/assets/pdf.worker.min-ijklmnop.js"
        self.css = "/usr/share/nginx/html/assets/index-qrstuvwx.css"
        self.files = {
            self.worker: b"export const WorkerMessageHandler = {};",
            self.wrapper: b'new URL("/assets/pdf.worker.min-abcdefgh.mjs", import.meta.url);',
            self.css: b"body { margin: 0; }",
        }
        self.container = {
            "Id": self.container_id, "Image": self.image_id,
            "State": {"Running": True},
            "Config": {"Labels": {"com.docker.compose.project": "ci-release-123-1-amd64",
                                   "com.docker.compose.service": "web"}},
            "NetworkSettings": {"Ports": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "41234"}]}},
        }
        self.image = {"Os": "linux", "Architecture": "amd64",
                      "Config": {"Labels": {"org.opencontainers.image.revision": self.commit}}}
        self.endpoint = "unix:///var/run/docker.sock"
        self.responses = {
            "/deployment-release.json": [200, {"Content-Type": "application/json"}, json.dumps({"commit": self.commit}).encode()],
            "/index.html": [200, {"Content-Type": "text/html", "Cache-Control": "no-store"}, b'<div id="root"></div>'],
            "/assets/pdf.worker.min-regressionMissing.mjs": [404, {"Content-Type": "text/html"}, b"not found"],
        }
        for filename, mime in ((self.worker, "application/javascript"),
                               (self.wrapper, "text/javascript; charset=utf-8"), (self.css, "text/css")):
            self.responses["/assets/" + Path(filename).name] = [
                200, {"Content-Type": mime, "X-Content-Type-Options": "nosniff",
                      "Cache-Control": "public, max-age=31536000, immutable"}, self.files[filename]]
        self.requests = []

    def docker(self, arguments, **kwargs):
        self.assertEqual(kwargs, {"check": True, "capture_output": True, "timeout": 30})
        self.assertEqual(arguments[0], "docker")
        values = arguments[1:]
        if values == ["context", "show"]:
            data = b"default\n"
        elif values == ["context", "inspect", "default", "--format", "{{json .Endpoints.docker.Host}}"]:
            data = json.dumps(self.endpoint).encode()
        else:
            self.assertEqual(values[:2], ["--context", "default"])
            values = values[2:]
            if values == ["inspect", self.container_id]:
                data = json.dumps([self.container]).encode()
            elif values == ["image", "inspect", self.image_id]:
                data = json.dumps([self.image]).encode()
            elif values == ["exec", self.container_id, "find", "/usr/share/nginx/html/assets", "-maxdepth", "1", "-type", "f"]:
                data = "\n".join(self.files).encode()
            elif values[:3] == ["exec", self.container_id, "cat"] and len(values) == 4:
                data = self.files[values[3]]
            else:
                self.fail("Unexpected or mutating Docker command: " + repr(values))
        return SimpleNamespace(stdout=data)

    def open(self, address, timeout):
        self.assertEqual(timeout, 15)
        self.assertTrue(address.startswith("http://127.0.0.1:41234/"))
        path = urlsplit(address).path
        self.requests.append(path)
        status, headers, body = self.responses[path]
        if status >= 400:
            raise HTTPError(address, status, "fixture", headers, io.BytesIO(body))
        return Response(address, status, headers, body)

    def run_check(self):
        arguments = [str(SCRIPT), "--container", self.container_id,
                     "--base-url", "http://127.0.0.1:41234", "--expected-image-id", self.image_id,
                     "--expected-commit", self.commit, "--output", str(self.output)]
        with patch.object(check.sys, "argv", arguments), patch.dict(check.os.environ, {}, clear=True), \
                patch.object(check.shutil, "which", return_value="docker"), \
                patch.object(check.subprocess, "run", side_effect=self.docker), \
                patch.object(check, "build_opener", return_value=SimpleNamespace(open=self.open)) as opener_factory, \
                contextlib.redirect_stdout(io.StringIO()):
            check.main()
            return opener_factory.call_args.args

    def assert_failure(self, message):
        with self.assertRaisesRegex(RuntimeError, message):
            self.run_check()
        self.assertFalse(self.output.exists(), "A failed verifier must not emit a passed receipt")

    def test_verified_inputs_emit_bound_receipt(self):
        self.run_check()
        receipt = json.loads(self.output.read_text())
        self.assertEqual(receipt["status"], "passed")
        self.assertEqual(receipt["imageId"], self.image_id)
        self.assertEqual(receipt["containerId"], self.container_id)
        self.assertEqual(receipt["commit"], self.commit)
        self.assertFalse(receipt["paid"])
        self.assertEqual(len(receipt["checks"]), 6)
        self.assertEqual(receipt["checks"][-1]["status"], 404)

    def test_original_octet_stream_failure_is_rejected(self):
        self.responses["/assets/" + Path(self.worker).name][1]["Content-Type"] = "application/octet-stream"
        self.assert_failure("BUILT_ASSET_MIME_MISMATCH")

    def test_exact_arm64_stack_emits_arm64_receipt(self):
        self.container["Config"]["Labels"]["com.docker.compose.project"] = "ci-release-123-1-arm64"
        self.image["Architecture"] = "arm64"
        self.run_check()
        self.assertEqual(json.loads(self.output.read_text())["platform"], "linux/arm64")

    def test_worker_and_wrapper_must_be_unique(self):
        for extra in ("pdf.worker.min-extra.mjs", "pdf.worker.min-extra.js"):
            with self.subTest(extra=extra):
                path = "/usr/share/nginx/html/assets/" + extra
                self.files[path] = b"extra asset"
                self.assert_failure("ONE_REAL_BUILT_PDF_WORKER_REQUIRED|WORKER_WRAPPER_REFERENCE_MISMATCH")
                del self.files[path]

    def test_worker_wrapper_cannot_point_at_old_immutable_worker(self):
        self.files[self.wrapper] = b'const url="/assets/pdf.worker-Dg_VPFYK.mjs";export{url as default};'
        self.assert_failure("WORKER_WRAPPER_REFERENCE_MISMATCH")
        self.assertEqual(self.requests, [])

    def test_legacy_non_minified_assets_cannot_remain_in_new_image(self):
        for name in ("pdf.worker-Dg_VPFYK.mjs", "pdf.worker-D-wNPUdQ.js"):
            with self.subTest(name=name):
                path = "/usr/share/nginx/html/assets/" + name
                self.files[path] = b"legacy artifact"
                self.assert_failure("LEGACY_NON_MINIFIED_PDF_WORKER_NOT_ALLOWED")
                del self.files[path]
        self.assertEqual(self.requests, [])

    def test_old_reference_cannot_be_hidden_next_to_correct_worker_reference(self):
        self.files[self.wrapper] += b'const legacy="/assets/pdf.worker-Dg_VPFYK.mjs";'
        self.assert_failure("WORKER_WRAPPER_REFERENCE_MISMATCH")

    def test_nosniff_cannot_be_removed_to_hide_failure(self):
        del self.responses["/assets/" + Path(self.worker).name][1]["X-Content-Type-Options"]
        self.assert_failure("NOSNIFF_MUST_BE_PRESERVED")

    def test_wrong_worker_body_is_rejected(self):
        self.responses["/assets/" + Path(self.worker).name][2] = b"different worker"
        self.assert_failure("HTTP_BYTES_DIFFER_FROM_BUILT_IMAGE")

    def test_wrong_wrapper_body_is_rejected(self):
        self.responses["/assets/" + Path(self.wrapper).name][2] = b"different wrapper"
        self.assert_failure("HTTP_BYTES_DIFFER_FROM_BUILT_IMAGE")

    def test_wrapper_mime_and_fingerprint_cache_are_required(self):
        self.responses["/assets/" + Path(self.wrapper).name][1]["Content-Type"] = "application/octet-stream"
        self.assert_failure("BUILT_ASSET_MIME_MISMATCH")
        self.responses["/assets/" + Path(self.wrapper).name][1]["Content-Type"] = "application/javascript"
        self.responses["/assets/" + Path(self.worker).name][1]["Cache-Control"] = "no-store"
        self.assert_failure("FINGERPRINT_CACHE_MISSING")

    def test_stock_css_mapping_is_required(self):
        self.responses["/assets/" + Path(self.css).name][1]["Content-Type"] = "application/octet-stream"
        self.assert_failure("BUILT_ASSET_MIME_MISMATCH")

    def test_stock_html_mapping_is_required(self):
        self.responses["/index.html"][1]["Content-Type"] = "application/octet-stream"
        self.assert_failure("HTML_MAPPING_REGRESSION")

    def test_html_must_stay_no_store(self):
        self.responses["/index.html"][1]["Cache-Control"] = "public, max-age=31536000, immutable"
        self.assert_failure("INDEX_CACHE_REGRESSION")

    def test_missing_worker_must_not_be_spa_html(self):
        self.responses["/assets/pdf.worker.min-regressionMissing.mjs"][0] = 200
        self.assert_failure("MISSING_WORKER_MUST_BE_UNCACHED_404")

    def test_missing_worker_must_not_be_immutable(self):
        self.responses["/assets/pdf.worker.min-regressionMissing.mjs"][1]["Cache-Control"] = "public, max-age=31536000, immutable"
        self.assert_failure("MISSING_WORKER_MUST_BE_UNCACHED_404")

    def test_wrong_container_image_is_rejected_before_http(self):
        self.container["Image"] = "sha256:" + "d" * 64
        self.assert_failure("RUNNING_IMAGE_ID_MISMATCH")
        self.assertEqual(self.requests, [])

    def test_wrong_image_commit_is_rejected_before_http(self):
        self.image["Config"]["Labels"]["org.opencontainers.image.revision"] = "e" * 40
        self.assert_failure("IMAGE_COMMIT_MISMATCH")
        self.assertEqual(self.requests, [])

    def test_wrong_image_platform_is_rejected_before_http(self):
        self.image["Architecture"] = "arm64"
        self.assert_failure("IMAGE_PLATFORM_MISMATCH")
        self.assertEqual(self.requests, [])

    def test_http_marker_commit_must_match_candidate(self):
        self.responses["/deployment-release.json"][2] = json.dumps({"commit": "e" * 40}).encode()
        self.assert_failure("HTTP_MARKER_COMMIT_MISMATCH")

    def test_stopped_container_and_changed_loopback_port_are_refused(self):
        self.container["State"]["Running"] = False
        self.assert_failure("RUNNING_IMAGE_ID_MISMATCH")
        self.container["State"]["Running"] = True
        self.container["NetworkSettings"]["Ports"]["3000/tcp"][0]["HostPort"] = "41235"
        self.assert_failure("CONTAINER_HTTP_PORT_MISMATCH")
        self.assertEqual(self.requests, [])

    def test_existing_receipt_is_never_overwritten(self):
        original = b"existing immutable receipt"
        self.output.write_bytes(original)
        with self.assertRaisesRegex(RuntimeError, "NEW_RECEIPT_REQUIRED"):
            self.run_check()
        self.assertEqual(self.output.read_bytes(), original)
        self.assertEqual(self.requests, [])

    def test_redirect_handler_does_not_allow_following_location(self):
        handlers = self.run_check()
        self.assertEqual(len(handlers), 2)
        self.assertIsInstance(handlers[0], check.ProxyHandler)
        self.assertEqual(handlers[0].proxies, {})
        self.assertIsInstance(handlers[1], check.NoRedirect)
        self.assertIsNone(handlers[1].redirect_request(None, None, 302, "redirect", {}, "https://external.invalid"))

    def test_production_or_other_project_is_refused(self):
        self.container["Config"]["Labels"]["com.docker.compose.project"] = "canvas-production"
        self.assert_failure("ISOLATED_RELEASE_STACK_REQUIRED")
        self.assertEqual(self.requests, [])

    def test_remote_docker_context_is_refused(self):
        self.endpoint = "tcp://192.0.2.1:2375"
        self.assert_failure("LOCAL_DOCKER_ENDPOINT_REQUIRED")
        self.assertEqual(self.requests, [])


class ReleaseIntegrationTests(unittest.TestCase):
    def test_real_probe_is_mandatory_inside_live_stack_before_browser_and_sealing(self):
        script = SCRIPT.with_name("stack-smoke.sh").read_text(encoding="utf-8")
        invocation = 'python3 -B "$repo/ops/release/verify-container-worker.py" \\\n  --container "$(dc ps -q web)" --base-url "http://127.0.0.1:$port" \\\n  --expected-image-id "$web_id" --expected-commit "$commit" \\\n  --output "$work/pdf-worker-http.json"'
        self.assertEqual(script.count(invocation), 1)
        marker = script.index("assert marker=={'schema':1,'version':candidate['version'],'commit':candidate['commit']}")
        probe = script.index(invocation)
        browser = script.index('bash "$repo/ops/release/browser-smoke.sh"')
        seal = script.index('seal-verification --candidate "$candidate"')
        self.assertLess(script.index("trap cleanup EXIT"), marker)
        self.assertLess(marker, probe)
        self.assertLess(probe, browser)
        self.assertLess(browser, seal)
        self.assertIn("set -Eeuo pipefail", script)

    def test_existing_ci_discovers_offline_tests_and_archives_public_receipt(self):
        root = SCRIPT.parents[2]
        workflow = (root / ".github/workflows/docker-image.yml").read_text(encoding="utf-8")
        self.assertIn("python3 -m unittest discover -s ops/release -p 'test_*.py'", workflow)
        self.assertEqual(workflow.count("${{ runner.temp }}/release-smoke/pdf-worker-http.json"), 1)
        receipts = workflow.split("- name: Preserve only public verification receipts", 1)[1]
        self.assertIn("${{ runner.temp }}/release-smoke/pdf-worker-http.json", receipts)
        self.assertIn("if: always()", receipts)


if __name__ == "__main__":
    unittest.main()
