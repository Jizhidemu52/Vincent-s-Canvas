"""No Docker: verify ordering and fail-closed orchestration around tested SQL."""
import copy
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import test_creative_050_051 as checks

operator = checks.operator


class FakeOperator(operator.Creative050051):
    def __init__(self, root, failure=None):
        self.root, self.failure, self.events = root, failure, []
        self.instance_path = root / "instance.json"
        self.instance_path.write_text("{}", encoding="utf-8")
        self.instance = {"database": {"name": "canvas"}, "minimumFreeBytes": 0, "retainedMigrationNames": [],
                         "localBaseUrl": "http://127.0.0.1", "publicBaseUrl": "https://example.invalid",
                         "containers": {role: "original-" + role for role in ["api", "worker", "web"]}}
        containers = [{"Name": "/original-" + role, "Id": role + "-original-id"} for role in ["api", "worker", "web"]]
        self.baseline = {"database": checks.before_state(), "configurationHashes": {}, "containers": containers, "model": {"services": {}}}
        self.after = checks.after_state()

    def new_audit(self, name):
        self.events.append("audit")
        self.audit = self.root / "audit"; self.audit.mkdir()

    def capture(self, label): return copy.deepcopy(self.baseline)
    def assert_platform(self, release): self.events.append("platform")
    def dependencies(self, options, label): self.events.append("dependencies:" + label)
    def disabled(self, label): self.events.append("disabled")
    def preparation_unchanged(self, current): self.events.append("prepared")
    def gate(self, operation): self.events.append("gate:" + operation)
    def wait_for_drain(self):
        self.events.append("drain")
        if self.failure == "drain": raise RuntimeError("injected drain failure")
    def stop_app(self, model):
        self.events.append("stop-original")
        return self.baseline["containers"]
    def freeze_stopped_baseline(self, current, rows):
        self.events.append("stopped-baseline")
        return copy.deepcopy(self.baseline)
    def backup_048(self):
        self.events.append("backup")
        if self.failure == "package-drift":
            (self.root / "package/server/src/migrations" / operator.MIGRATIONS[0]).write_text("-- changed during backup", encoding="utf-8")
    def protected_and_database(self, baseline, label): self.events.append("protected-and-baseline")
    def raw_sql(self, query, label, timeout=120):
        self.events.append("transaction")
        if self.failure == "transaction": raise RuntimeError("unknown transaction outcome")
        return b""
    def sql(self, name, label):
        if name == "database-state.sql":
            value = copy.deepcopy(self.after)
            if self.failure == "restart-drift" and label == "051-original-verified": value["tables"][0]["sha256"] = "changed"
            return value
        return {key: 0 for key in ["waitingTasks", "processingTasks", "submittedWaitingTasks", "processingChatRequests",
                                  "processingAnalysisPreviews", "optimizingPromptCompilations", "admittingBatches", "pendingAssetThumbnails", "pausedTasks"]}
    def inventory(self, label): return copy.deepcopy(self.baseline["containers"])
    def application_configuration_unchanged(self, baseline): self.events.append("configuration-check")
    def start_original(self, baseline):
        self.events.append("start-original")
        if self.failure == "start": raise RuntimeError("original start failure")
    def wait_health(self, origin): self.events.append("health:" + origin)
    def command(self, args):
        self.events.append("worker-health")
        return b""


class Creative050051Lifecycle(unittest.TestCase):
    def run_operator(self, root, failure=None, prior_change=None):
        runner = FakeOperator(root, failure)
        package = root / "package"; package.mkdir()
        for relative in ["release-manifest.json", operator.SEED_PATH, operator.CATALOG_PATH, *["server/src/migrations/" + name for name in operator.MIGRATIONS]]:
            path = package / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("-- fixed fixture", encoding="utf-8")
        prior_dir = root / "preflight"; prior_dir.mkdir()
        prior = {"kind": "creative-050-051-preflight", "createdAt": time.time(), "instanceSha256": operator.sha_file(runner.instance_path),
                 "manifestSha256": operator.sha_file(package / "release-manifest.json"), "payloadHashes": operator.payload_hashes(package),
                 "package": str(package), "options": checks.OPTIONS, "baseline": runner.baseline}
        if prior_change: prior_change(prior)
        (prior_dir / "preflight.json").write_text(json.dumps(prior), encoding="utf-8")
        release = {"migrations": [{"name": "049_quick_image_configurations.sql"},
                   *[{"name": name, "sha256": operator.digest_file(package / "server/src/migrations" / name)} for name in operator.MIGRATIONS]]}
        with patch.object(operator, "verify_creative_package", return_value=(release, checks.CATALOG, checks.source_seed())), \
             patch.object(operator, "private_directory", side_effect=Path), \
             patch.object(operator, "assert_rollback_source"), patch.object(operator, "assert_protected"), \
             patch.object(operator.support, "assert_same_original") as same_original:
            try:
                value = runner.migrate_creative(package, prior_dir, checks.OPTIONS)
                return runner, value, same_original.call_args
            except Exception as error:
                return runner, error, same_original.call_args

    def test_backup_precedes_one_transaction_and_same_original_restart_precedes_gate_reopen(self):
        with tempfile.TemporaryDirectory() as directory:
            runner, receipt, same_original = self.run_operator(Path(directory))
            self.assertIsInstance(receipt, dict, receipt)
            order = ["gate:close", "drain", "stop-original", "stopped-baseline", "backup", "protected-and-baseline", "transaction", "start-original", "gate:open"]
            self.assertEqual([event for event in runner.events if event in order], order)
            self.assertTrue(same_original.args[-1])
            self.assertEqual(receipt["originalContainerIds"], {role: role + "-original-id" for role in ["api", "worker", "web"]})
            self.assertFalse(receipt["processingEnabled"])
            self.assertTrue(receipt["existingRecipesPreserved"])
            self.assertTrue((runner.audit / "receipt.json").is_file())

    def test_failure_never_retries_restores_database_or_opens_ingress(self):
        for failure, phase in [("drain", "maintenance"), ("package-drift", "maintenance"), ("transaction", "sql-outcome-unknown-until-verified"),
                               ("start", "schema-committed-original-start-pending"), ("restart-drift", "schema-committed-original-start-pending")]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                runner, error, _ = self.run_operator(Path(directory), failure)
                self.assertIsInstance(error, Exception)
                self.assertNotIn("gate:open", runner.events)
                self.assertLessEqual(runner.events.count("transaction"), 1)
                self.assertFalse((runner.audit / "receipt.json").exists())
                record = json.loads((runner.audit / "failure.json").read_text(encoding="utf-8"))
                self.assertEqual(record["phase"], phase)
                self.assertFalse(record["automaticRetry"])
                self.assertFalse(record["automaticRestore"])

    def test_expired_or_retargeted_preflight_fails_before_maintenance(self):
        for mutation in [lambda p: p.update(createdAt=time.time() - 901), lambda p: p.update(options={"actorId": "other"})]:
            with tempfile.TemporaryDirectory() as directory:
                runner, error, _ = self.run_operator(Path(directory), prior_change=mutation)
                self.assertIsInstance(error, operator.Rejected)
                self.assertEqual(runner.events, [])


if __name__ == "__main__": unittest.main()
