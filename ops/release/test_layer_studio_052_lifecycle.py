"""052 maintenance lifecycle, no Docker/network or real database."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch
import test_layer_studio_052 as checks

operator = checks.operator


def add_dropped_tail(database):
    layout = database["layerStudioTaskLayout"]
    layout["relnatts"] += 1
    layout["attributes"].append({"attnum": layout["relnatts"], "attname": "dropped_tail", "attisdropped": True})


class FakeOperator(operator.LayerStudio052):
    def __init__(self, root, failure=None):
        self.root, self.failure, self.events = root, failure, []
        self.instance_path = root / "instance.json"; self.instance_path.write_text("{}", encoding="utf-8")
        self.instance = {"database": {"name": "canvas"}, "minimumFreeBytes": 0, "retainedMigrationNames": [],
                         "localBaseUrl": "http://127.0.0.1", "publicBaseUrl": "https://example.invalid",
                         "containers": {role: "original-" + role for role in ["api", "worker", "web"]}}
        self.baseline = {"database": checks.before_state(), "configurationHashes": {}, "model": {"services": {}},
                         "containers": [{"Name": "/original-" + role, "Id": role + "-original-id"} for role in ["api", "worker", "web"]]}
    def new_audit(self, name):
        self.events.append("audit"); self.audit = self.root / "audit"; self.audit.mkdir()
    def capture(self, label):
        value = copy.deepcopy(self.baseline)
        if self.failure == "physical-preflight-drift": add_dropped_tail(value["database"])
        return value
    def assert_platform(self, release): self.events.append("platform")
    def disabled(self, label):
        self.events.append("disabled")
        if self.failure == "enabled": raise operator.Rejected("statistics enabled")
    def preparation_unchanged(self, current): self.events.append("prepared")
    def gate(self, operation): self.events.append("gate:" + operation)
    def wait_for_drain(self):
        self.events.append("drain")
        if self.failure == "drain": raise RuntimeError("drain failed")
    def stop_app(self, model):
        self.events.append("stop-original"); return self.baseline["containers"]
    def freeze_stopped_baseline(self, current, rows):
        self.events.append("stopped-baseline"); value = copy.deepcopy(self.baseline)
        if self.failure == "physical-drain-drift": add_dropped_tail(value["database"])
        return value
    def backup_048(self):
        self.events.append("backup")
        if self.failure in ["sql-drift", "catalog-drift", "support-drift"]:
            path = {"sql-drift": operator.SQL_PATH, "catalog-drift": operator.CATALOG_PATH, "support-drift": "ops/release/activity.sql"}[self.failure]
            (self.root / "package" / path).write_text("changed during backup", encoding="utf-8")
    def protected_and_database(self, baseline, label): self.events.append("protected-baseline")
    def raw_sql(self, query, label, timeout=120):
        self.events.append("transaction")
        if self.failure == "transaction": raise RuntimeError("unknown transaction outcome")
        return b""
    def sql(self, name, label):
        if name == "database-state.sql":
            after = checks.after_state()
            if self.failure == "restart-drift" and label == "052-original-verified": after["layerStudioOriginalTasks"]["sha256"] = "changed"
            return after
        return {key: 0 for key in ["waitingTasks", "processingTasks", "submittedWaitingTasks", "processingChatRequests", "processingAnalysisPreviews", "optimizingPromptCompilations", "admittingBatches", "pendingAssetThumbnails", "pausedTasks"]}
    def inventory(self, label): return copy.deepcopy(self.baseline["containers"])
    def application_configuration_unchanged(self, baseline): self.events.append("configuration-check")
    def start_original(self, baseline):
        self.events.append("start-original")
        if self.failure == "start": raise RuntimeError("original start failed")
    def wait_health(self, origin): self.events.append("health:" + origin)
    def command(self, args): self.events.append("worker-health"); return b""


class LayerStudio052Lifecycle(unittest.TestCase):
    def run_operator(self, root, failure=None, prior_change=None):
        runner = FakeOperator(root, failure); package = root / "package"; package.mkdir()
        for relative in ["release-manifest.json", operator.SQL_PATH, *operator.RUNTIME_PATHS]:
            path = package / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("-- fixed fixture", encoding="utf-8")
        prior_dir = root / "preflight"; prior_dir.mkdir()
        prior = {"kind": "layer-studio-052-preflight", "createdAt": time.time(), "instanceSha256": operator.sha_file(runner.instance_path),
                 "manifestSha256": operator.sha_file(package / "release-manifest.json"), "payloadHashes": operator.payload_hashes(package),
                 "package": str(package), "baseline": runner.baseline}
        if prior_change: prior_change(prior)
        (prior_dir / "preflight.json").write_text(json.dumps(prior), encoding="utf-8")
        release = {"migrations": [{"name": operator.PREVIOUS}, {"name": operator.MIGRATION, "sha256": operator.digest_file(package / operator.SQL_PATH)}]}
        with patch.object(operator, "verify_052_package", return_value=(release, checks.CATALOG)), patch.object(operator, "private_directory", side_effect=Path), \
             patch.object(operator, "assert_rollback_source"), patch.object(operator, "assert_protected"), patch.object(operator.support, "assert_same_original") as same_original:
            try: return runner, runner.migrate_052(package, prior_dir), same_original.call_args
            except Exception as error: return runner, error, same_original.call_args

    def test_backup_then_one_transaction_then_verified_same_id_restart_then_open(self):
        with tempfile.TemporaryDirectory() as directory:
            runner, result, same = self.run_operator(Path(directory))
            self.assertIsInstance(result, dict, result)
            order = ["gate:close", "drain", "stop-original", "stopped-baseline", "backup", "protected-baseline", "transaction", "start-original", "gate:open"]
            self.assertEqual([event for event in runner.events if event in order], order); self.assertTrue(same.args[-1])
            self.assertEqual(result["originalContainerIds"], {role: role + "-original-id" for role in ["api", "worker", "web"]})
            for key in ["processingEnabled", "featureEnabled", "modelBound"]: self.assertFalse(result[key])
            self.assertTrue(result["originalTaskColumnsPreserved"]); self.assertTrue(result["pricesEmpty"])

    def test_failures_do_not_retry_restore_or_reopen_and_report_exact_stage(self):
        for failure, phase in [("enabled", "preparation"), ("drain", "maintenance"), ("sql-drift", "maintenance"), ("catalog-drift", "maintenance"), ("support-drift", "maintenance"),
                               ("transaction", "sql-outcome-unknown-until-verified"), ("start", "schema-committed-original-start-pending"), ("restart-drift", "schema-committed-original-start-pending")]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                runner, error, _ = self.run_operator(Path(directory), failure)
                self.assertIsInstance(error, Exception); self.assertNotIn("gate:open", runner.events)
                self.assertLessEqual(runner.events.count("transaction"), 1); self.assertFalse((runner.audit / "receipt.json").exists())
                record = json.loads((runner.audit / "failure.json").read_text(encoding="utf-8"))
                self.assertEqual(record["phase"], phase); self.assertFalse(record["automaticRetry"]); self.assertFalse(record["automaticRestore"])

    def test_expired_retargeted_preflight_refused_before_audit_or_maintenance(self):
        for change in [lambda p: p.update(createdAt=time.time()-901), lambda p: p.update(package="other"), lambda p: p.update(payloadHashes={})]:
            with tempfile.TemporaryDirectory() as directory:
                runner, error, _ = self.run_operator(Path(directory), prior_change=change)
                self.assertIsInstance(error, operator.Rejected); self.assertEqual(runner.events, [])

    def test_physical_only_drift_is_checked_before_maintenance_and_after_drain(self):
        for failure, code, closed in [("physical-preflight-drift", "052_CATALOG_DRIFT_SINCE_PREFLIGHT", False),
                                      ("physical-drain-drift", "052_CATALOG_DRIFT_DURING_DRAIN", True)]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                runner, error, _ = self.run_operator(Path(directory), failure)
                self.assertIsInstance(error, operator.Rejected); self.assertEqual(str(error), code)
                self.assertEqual("gate:close" in runner.events, closed)
                self.assertNotIn("backup", runner.events); self.assertNotIn("transaction", runner.events)
                self.assertNotIn("gate:open", runner.events)


if __name__ == "__main__": unittest.main()
