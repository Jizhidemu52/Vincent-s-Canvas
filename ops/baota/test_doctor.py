from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch

import doctor


ROOT = Path(__file__).resolve().parents[2]


@contextmanager
def service(handler):
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join()


class StreamHandler(BaseHTTPRequestHandler):
    actor = "601d5e50-be44-4801-a579-f109d62bb114"
    cookie = "test_session=only-a-fake-token"
    heartbeat_count = 3

    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.headers.get("Cookie") != self.cookie:
            self.send_error(401)
            return
        if self.path == "/api/auth/session":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(f'{{"user":{{"id":"{self.actor}"}}}}'.encode())
            return
        if self.path != f"/api/tasks/events?ownerId={self.actor}":
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        try:
            self.wfile.write(b'event: tasks-changed\ndata: {"ids":[]}\n\n')
            for _ in range(self.heartbeat_count):
                time.sleep(0.05)
                self.wfile.write(b": heartbeat\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


class DoctorTest(unittest.TestCase):
    def doctor(self):
        return doctor.Doctor({"containers": {"api": "api", "web": "web", "worker": "worker"},
                              "publicBaseUrl": "http://canvas.test", "localBaseUrl": "http://127.0.0.1:3300"})

    def test_production_environment_requires_https_for_browser_sessions(self):
        instance = self.doctor()
        instance.runtime_result = {"errors": [], "warnings": []}
        with self.assertRaisesRegex(doctor.ProbeFailed, "HTTPS"):
            instance.environment()
        instance.public = "https://canvas.test"
        self.assertEqual(instance.environment(), "生产变量通过")

    def test_stream_session_will_not_read_credentials_for_http_origin(self):
        with patch.object(doctor, "private_input") as read, self.assertRaisesRegex(doctor.ProbeFailed, "HTTPS"):
            doctor.session_headers(Path("unused"), "http://canvas.test")
        read.assert_not_called()

    def test_stream_reads_authentication_and_heartbeats_from_same_origin(self):
        with service(StreamHandler) as origin:
            result = doctor.probe_stream(origin, {"Cookie": StreamHandler.cookie}, duration=0.09)
        self.assertRegex(result, r"收到 [1-3] 条心跳")

    def test_stream_rejects_early_disconnect(self):
        class ImmediateDisconnect(StreamHandler):
            heartbeat_count = 0

        with service(ImmediateDisconnect) as origin, self.assertRaisesRegex(doctor.ProbeFailed, "提前断开"):
            doctor.probe_stream(origin, {"Cookie": StreamHandler.cookie}, duration=0.09)

    def test_unauthenticated_response_does_not_count_as_healthy_stream(self):
        with service(StreamHandler) as origin, self.assertRaisesRegex(doctor.ProbeFailed, "HTTP 401"):
            doctor.probe_stream(origin, {"Cookie": "test_session=bad"}, duration=0.09)

    def test_failed_inventory_cannot_pass_health_or_timezone(self):
        instance = self.doctor()
        with patch.object(instance, "inventory", side_effect=doctor.ProbeFailed("failed")), patch.object(instance, "config"), \
                patch.object(instance, "runtime"), patch.object(doctor, "run", side_effect=doctor.ProbeFailed("failed")), \
                patch.object(doctor, "get", side_effect=doctor.ProbeFailed("failed")):
            rows = instance.verify()
        self.assertEqual([row["id"] for row in rows], list(range(1, 17)))
        self.assertEqual([rows[1]["status"], rows[15]["status"]], ["失败", "失败"])

    def test_inventory_uses_declared_app_and_volume_owners_not_old_one_off_containers(self):
        instance = self.doctor()
        instance.instance.update(project="canvas", protectedContainers=["pg", "redis", "minio", "old-api"],
                                 expectedVolumes={"pg": [], "redis": [], "minio": []}, database={"container": "pg"})
        rows = []
        for name, role in (("api", "api"), ("worker", "worker"), ("web", "web"), ("pg", "postgres"),
                           ("redis", "redis"), ("minio", "minio"), ("old-api", "api")):
            rows.append({"Id": (str(len(rows) + 1)) * 64, "Name": "/" + name,
                         "Config": {"Labels": {"com.docker.compose.project": "canvas", "com.docker.compose.service": role}}})
        with patch.object(doctor, "run", return_value=doctor.json.dumps(rows).encode()):
            instance.inventory()
        self.assertEqual(instance.roles["api"], "api")
        self.assertEqual(instance.roles["postgres"], "pg")

    def test_repository_proxy_templates_pass_streaming_and_upload_rules(self):
        instance = self.doctor()
        instance.inner = doctor.no_comments((ROOT / "nginx.conf").read_text(encoding="utf-8"))
        instance.outer = doctor.no_comments((ROOT / "ops/baota/site-proxy.conf").read_text(encoding="utf-8"))
        self.assertIn("240 秒 / 75 秒", instance.proxy_streaming())
        self.assertIn("200m", instance.upload_limits())
        instance.outer = instance.outer.replace("proxy_read_timeout 75s;", "proxy_read_timeout 60s;")
        with self.assertRaisesRegex(doctor.ProbeFailed, "/api/tasks/events"):
            instance.proxy_streaming()

    def test_active_host_binding_must_be_loopback_and_match_proxy(self):
        instance = self.doctor()
        binding = {"HostIp": "127.0.0.1", "HostPort": "3300"}
        instance.containers = {"web": {"NetworkSettings": {"Ports": {"3000/tcp": [binding]}}}}
        with patch.object(instance, "proxy_raw", return_value=b"set $canvas_web http://127.0.0.1:3300;"):
            self.assertIn("127.0.0.1:3300", instance.ports())
            binding["HostIp"] = "0.0.0.0"
            with self.assertRaisesRegex(doctor.ProbeFailed, "只监听回环"):
                instance.ports()

    def test_release_identity_checks_all_three_images(self):
        instance = self.doctor()
        marker = b'{"schema":1,"version":"v0.5.138","commit":"1111111111111111111111111111111111111111"}'
        instance.containers = {role: {"Config": {"Labels": {"org.opencontainers.image.revision": "1" * 40,
                                                           "org.opencontainers.image.version": "v0.5.138"}}} for role in instance.app}
        with patch.object(doctor, "get", return_value=(marker, None)):
            self.assertIn("v0.5.138", instance.release_identity())
            instance.containers["worker"]["Config"]["Labels"]["org.opencontainers.image.revision"] = "2" * 40
            with self.assertRaisesRegex(doctor.ProbeFailed, "运行容器"):
                instance.release_identity()


if __name__ == "__main__":
    unittest.main()
