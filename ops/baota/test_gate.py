import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("canvas_gate", Path(__file__).with_name("gate.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class GateTests(unittest.TestCase):
    def test_site_keeps_existing_certificates_restrictions_logs_exactly(self):
        source = b"# site\nserver {\n listen 80;\n ssl_certificate /private/cert;\n allow 10.0.0.0/8;\n deny all;\n access_log /safe canvas_safe;\n}\n"
        change = b"\n    return 503; # canvas-maintenance-unit\n"
        self.assertEqual(gate.gated_site(source, "canvas-maintenance-unit").replace(change, b""), source)
        for invalid in [b"http {}", b"server {}\nserver {}", source + b"# canvas-maintenance-old"]:
            with self.assertRaises(gate.Rejected):
                gate.gated_site(invalid, "canvas-maintenance-unit")

    def test_only_published_old_web_ports_and_exact_container_ips_are_gated(self):
        network = {"Networks": {"production": {"IPAddress": "172.27.0.5", "GlobalIPv6Address": ""}},
                   "Ports": {"80/tcp": None, "3000/tcp": [{"HostIp": "0.0.0.0", "HostPort": "3000"}, {"HostIp": "::", "HostPort": "3000"}]}}
        rules = gate.firewall_plan(network, "canvas-maintenance-test")
        self.assertEqual(len(rules), 3)
        forwarded = next(rule for rule in rules if rule[1] == "DOCKER-USER")
        self.assertIn("172.27.0.5", forwarded)
        self.assertEqual(forwarded[forwarded.index("--ctorigdstport") + 1], "3000")
        self.assertNotIn("0.0.0.0/0", forwarded)
        self.assertEqual(gate.rule_command(forwarded, "-I")[:6], ["iptables", "--wait", "5", "-I", "DOCKER-USER", "1"])
        self.assertEqual(gate.rule_command(forwarded, "-D")[:5], ["iptables", "--wait", "5", "-D", "DOCKER-USER"])

    def test_loopback_web_needs_no_direct_port_firewall_change(self):
        self.assertEqual(gate.firewall_plan({"Ports": {"3000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "3000"}]}, "Networks": {}}, "test"), [])

    def test_close_failure_never_replaces_an_unknown_site_or_removes_its_gate(self):
        self.check_failed_close("changed")

    def test_close_failure_can_restore_either_known_site_state(self):
        for state in ["closed", "original"]:
            with self.subTest(state=state):
                self.check_failed_close(state)

    def check_failed_close(self, state):
        # Exercise main's compensation path without touching files, nginx,
        # Docker or firewall state. The probe fails after the gate was installed.
        source = b"server {\n listen 80;\n}\n"
        changed = b"server {\n listen 80; # another operator's edit\n}\n"
        files = {"/site.conf": source, "/proxy.conf": b"proxy"}

        class Sink(io.BytesIO):
            def __init__(self, key):
                super().__init__()
                self.key = key

            def __exit__(self, *arguments):
                files[self.key] = self.getvalue()
                return False

        class MemoryPath:
            def __init__(self, value): self.value = str(value)
            def __str__(self): return self.value
            def __truediv__(self, value): return MemoryPath(self.value + "/" + value)
            def is_dir(self): return True
            def is_symlink(self): return False
            def exists(self): return self.value in files
            def resolve(self): return self
            def open(self, mode): return Sink(self.value)

        instance = {"auditRoot": "/audit", "containers": {"web": "old-web"},
                    "ingress": {"siteFile": "/site.conf", "proxyFile": "/proxy.conf", "nginxBinary": "/nginx",
                                "expectedSiteSha256": gate.sha(source), "expectedProxySha256": gate.sha(b"proxy")}}
        writes = []

        def replace(path, content):
            writes.append(content)
            files[str(path)] = content

        def fail_probe(*arguments):
            if state == "changed": files["/site.conf"] = changed
            elif state == "original": files["/site.conf"] = source
            raise gate.Rejected("SIMULATED_PROBE_FAILURE")

        with patch.object(gate, "Path", MemoryPath), patch.object(gate.os, "geteuid", return_value=0, create=True), \
             patch.object(gate.os, "chmod"), patch.object(gate, "read_json", return_value=instance), \
             patch.object(gate, "validate_instance", side_effect=lambda value: value), \
             patch.object(gate, "read_regular", side_effect=lambda path: files[str(path)]), \
             patch.object(gate, "run", return_value=SimpleNamespace(stdout='{"Networks":{},"Ports":{}}', returncode=0)), \
             patch.object(gate, "replace_site", side_effect=replace), \
             patch.object(gate, "write_new_json", side_effect=lambda path, value: files.__setitem__(str(path), json.dumps(value).encode())), \
             patch.object(gate, "probe", side_effect=fail_probe), patch.object(gate, "remove_rules") as cleanup:
            code = "REFUSING_TO_REPLACE_CHANGED_SITE" if state == "changed" else "SIMULATED_PROBE_FAILURE"
            with self.assertRaisesRegex(gate.Rejected, code):
                gate.main(["close", "instance.json", "/audit/run"])
        self.assertIn("/audit/run/gate-journal.json", files)
        self.assertEqual(files["/site.conf"], changed if state == "changed" else source)
        self.assertEqual(len(writes), 1 if state == "changed" else 2)
        self.assertEqual(cleanup.call_count, 0 if state == "changed" else 1)


if __name__ == "__main__":
    unittest.main()
