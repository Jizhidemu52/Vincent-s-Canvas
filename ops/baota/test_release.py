from contextlib import contextmanager
from email.message import Message
import hashlib
from http.server import BaseHTTPRequestHandler
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import acceptance
from doctor import ProbeFailed
import release
from test_doctor import service


class AssetHandler(BaseHTTPRequestHandler):
    actor = "601d5e50-be44-4801-a579-f109d62bb114"
    asset = "7f4cef60-e0a9-4bd1-a887-cce3024ff96d"
    upload = f"/api/assets/{asset}/upload"
    cookie = "test_session=only-a-fake-token"
    received = b""
    seen = []

    def log_message(self, *_args):
        pass

    def body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", "0")))

    def reply(self, status, body=b"", **headers):
        self.send_response(status)
        self.send_header("Content-Length", str(len(body)))
        for key, value in headers.items():
            self.send_header(key.replace("_", "-"), value)
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path == "/api/auth/login":
            if json.loads(self.body()) != {"identifier": "probe", "password": "fake-password", "portal": "designer"}:
                return self.reply(401)
            type(self).seen.append("login")
            return self.reply(200, json.dumps({"user": {"id": self.actor, "role": "designer"}}).encode(), Set_Cookie=self.cookie + "; HttpOnly; Path=/")
        if self.headers.get("Cookie") != self.cookie:
            return self.reply(401)
        if self.path == "/api/auth/logout":
            type(self).seen.append("logout")
            return self.reply(204)
        if self.path == "/api/assets/upload-request" and json.loads(self.body())["byteSize"] == acceptance.IMAGE_BYTES:
            type(self).seen.append("reserve")
            return self.reply(201, json.dumps({"assetId": self.asset, "uploadUrl": self.upload}).encode())
        return self.reply(400)

    def do_PUT(self):
        if self.path != self.upload or self.headers.get("Cookie") != self.cookie or self.headers.get("X-Canvas-Owner-Id") != self.actor:
            return self.reply(403)
        type(self).received = self.body()
        type(self).seen.append("upload")
        self.reply(204)

    def do_GET(self):
        if self.path != f"/api/assets/{self.asset}/content" or self.headers.get("Cookie") != self.cookie:
            return self.reply(403)
        type(self).seen.append("download")
        self.reply(200, type(self).received, Content_Type="image/png")


class AcceptanceTest(unittest.TestCase):
    def test_release_will_not_read_password_for_http_origin(self):
        with patch.object(acceptance, "private_input") as read, self.assertRaisesRegex(ProbeFailed, "HTTPS"):
            acceptance.account_file(Path("unused"), "http://canvas.test")
        read.assert_not_called()

    def test_https_login_requires_a_secure_session_cookie(self):
        response_headers = Message()
        response_headers["Set-Cookie"] = AssetHandler.cookie + "; HttpOnly; Path=/"
        payload = json.dumps({"user": {"id": AssetHandler.actor, "role": "designer"}}).encode()

        @contextmanager
        def request(*_args, **_options):
            yield SimpleNamespace(headers=response_headers, read=lambda size: payload)

        account = {"identifier": "probe", "password": "fake-password", "cookieName": "test_session"}
        with patch.object(acceptance, "request", request):
            with self.assertRaisesRegex(ProbeFailed, "Secure"):
                acceptance.login("https://canvas.test", account)
            response_headers.replace_header("Set-Cookie", AssetHandler.cookie + "; Secure; HttpOnly; Path=/")
            headers, _ = acceptance.login("https://canvas.test", account)
        self.assertEqual(headers["Cookie"], AssetHandler.cookie)

    def test_local_http_login_and_20mb_original_roundtrip(self):
        class Fixture(AssetHandler):
            seen = []

        image = acceptance.PNG_SIGNATURE + b"a" * (acceptance.IMAGE_BYTES - len(acceptance.PNG_SIGNATURE))
        account = {"identifier": "probe", "password": "fake-password", "cookieName": "test_session"}
        with service(Fixture) as origin, acceptance.authenticated_probe(origin, account) as headers:
            evidence = acceptance.image_roundtrip(origin, headers, image)
        self.assertEqual(evidence["bytes"], acceptance.IMAGE_BYTES)
        self.assertEqual(evidence["sha256"], hashlib.sha256(image).hexdigest())
        self.assertEqual(Fixture.seen, ["login", "reserve", "upload", "download", "logout"])

    def roundtrip(self, upload_url):
        asset = "601d5e50-be44-4801-a579-f109d62bb114"
        origin = "http://canvas.test"
        headers = {"Cookie": "test_session=fake-token"}
        image = acceptance.PNG_SIGNATURE + b"fixture bytes"
        requests = []

        @contextmanager
        def request(url, path, headers, **options):
            self.assertEqual(url, origin)
            self.assertEqual(headers["Cookie"], "test_session=fake-token")
            requests.append((path, options["method"]))
            if path == "/api/assets/upload-request":
                yield SimpleNamespace(read=lambda size: json.dumps({"assetId": asset, "uploadUrl": upload_url}).encode())
            else:
                self.assertEqual(options["body"], image)
                yield None

        def get(url, path, request_headers, *, limit, timeout):
            self.assertEqual((url, path, request_headers, limit, timeout), (origin, f"/api/assets/{asset}/content", headers, len(image), 90))
            return image, SimpleNamespace(get_content_type=lambda: "image/png")

        return patch.object(acceptance, "request", request), patch.object(acceptance, "get", get), origin, headers, image, requests

    def test_image_verifies_same_origin_unique_asset_and_original_hash(self):
        upload = "/api/assets/601d5e50-be44-4801-a579-f109d62bb114/upload"
        request, get, origin, headers, image, requests = self.roundtrip(upload)
        with request, get:
            result = acceptance.image_roundtrip(origin, headers, image)
        self.assertEqual(result["sha256"], hashlib.sha256(image).hexdigest())
        self.assertEqual(requests, [("/api/assets/upload-request", "POST"), (upload, "PUT")])

    def test_asset_upload_rejects_a_url_outside_the_new_asset(self):
        request, get, origin, headers, image, requests = self.roundtrip("https://elsewhere.invalid/upload")
        with request, get, self.assertRaisesRegex(ProbeFailed, "本次创建"):
            acceptance.image_roundtrip(origin, headers, image)
        self.assertEqual(requests, [("/api/assets/upload-request", "POST")])


class ReleaseTest(unittest.TestCase):
    def test_proxy_render_uses_actual_port_and_never_overwrites_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "managed.conf"
            probe = SimpleNamespace(inventory=lambda: None, web_port=lambda: 3300)
            with patch.object(release, "Deployment", return_value=SimpleNamespace(instance={})), patch.object(release, "Doctor", return_value=probe):
                result = release.render_proxy(output, output)
                with self.assertRaises(FileExistsError):
                    release.render_proxy(output, output)
            self.assertEqual(result["port"], 3300)
            self.assertIn("http://127.0.0.1:3300;", output.read_text(encoding="utf-8"))
            self.assertEqual(result["sha256"], hashlib.sha256(output.read_bytes()).hexdigest())

    def apply(self, preflight_failures=0, post_failures=0, image_failure=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = {"commit": "a" * 40, "version": "v0.5.138"}
            (root / "release-manifest.json").write_text(json.dumps(expected), encoding="utf-8")
            receipt = {"status": "applied", "commit": expected["commit"], "audit": str(root)}
            calls = []
            files = []
            instance = {"publicBaseUrl": "https://canvas.test"}

            @contextmanager
            def deployer(instance_path):
                def apply(package, previous, *, verify_public):
                    self.assertFalse(verify_public)
                    calls.append("apply")
                    return receipt

                def rollback(audit):
                    self.assertIn("public-acceptance-failure.json", files)
                    self.assertEqual(audit, root)
                    calls.append("rollback")
                    return {"status": "rolled-back", "databaseChanged": False}

                yield SimpleNamespace(apply=apply, rollback=rollback, instance=instance)

            @contextmanager
            def login(origin, account):
                calls.append("fresh-login")
                yield {"Cookie": "test=test-token"}
                calls.append("logout")

            def doctor(deploy, name, *, headers, expected_release):
                self.assertEqual(name, "doctor-after.json")
                self.assertEqual(expected_release, expected)
                calls.append("doctor-after")
                return post_failures

            def image(*args):
                calls.append("image-roundtrip")
                if image_failure:
                    raise ProbeFailed("不同哈希")
                return {"bytes": 20_000_000}

            with patch.object(release, "deployer", deployer), patch.object(release, "Deployment", return_value=SimpleNamespace(instance=instance)), \
                    patch.object(release, "account_file"), patch.object(release, "fixture_bytes"), \
                    patch.object(release, "preflight", return_value=(root, preflight_failures)), patch.object(release, "authenticated_probe", login), \
                    patch.object(release, "doctor_report", doctor), patch.object(release, "image_roundtrip", image), \
                    patch.object(release, "write_new_json", side_effect=lambda path, data: files.append(path.name)):
                if preflight_failures or post_failures or image_failure:
                    with self.assertRaises(ProbeFailed):
                        release.apply(root, root, root, root)
                else:
                    self.assertEqual(release.apply(root, root, root, root), receipt)
            return calls, files

    def test_failed_doctor_before_cutover_leaves_application_running(self):
        self.assertEqual(self.apply(preflight_failures=1), ([], []))

    def test_failed_post_cutover_checks_roll_back_using_sealed_release_audit(self):
        calls, files = self.apply(post_failures=1)
        self.assertEqual(calls, ["apply", "fresh-login", "doctor-after", "rollback"])
        self.assertEqual(files, ["public-acceptance-failure.json", "public-acceptance.json"])

    def test_failed_image_roundtrip_rolls_back_application(self):
        calls, _ = self.apply(image_failure=True)
        self.assertEqual(calls[-2:], ["image-roundtrip", "rollback"])

    def test_all_checks_then_accepts_new_application(self):
        calls, files = self.apply()
        self.assertEqual(calls, ["apply", "fresh-login", "doctor-after", "image-roundtrip", "logout"])
        self.assertEqual(files, ["public-acceptance.json"])


if __name__ == "__main__":
    unittest.main()
