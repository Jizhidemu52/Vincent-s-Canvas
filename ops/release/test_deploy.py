"""Deployment failure-path tests use no Docker or remote resources."""
import copy
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
from unittest.mock import patch

import deploy
from test_contract import compose, inspect, instance


def idle_activity():
    return {"waitingTasks": 0, "processingTasks": 0, "submittedWaitingTasks": 0,
            "processingChatRequests": 0, "processingAnalysisPreviews": 0,
            "optimizingPromptCompilations": 0, "admittingBatches": 0, "pausedTasks": 2}


def database_state(count=1):
    return {"identity": {"database": "canvas", "systemIdentifier": "fixture-cluster"},
            "migrations": [{"name": "001_schema.sql", "applied_at": "fixture"}],
            "columns": ["same-columns"], "indexes": [], "constraints": [],
            "sequences": [{"sequencename": "business_id", "increment_by": 1, "last_value": count}],
            "tables": [{"name": "business", "count": count, "sha256": str(count) * 64}]}


class DeploymentContracts(unittest.TestCase):
    def test_explicit_project_directory_preserves_relative_env_and_mount_base(self):
        runner = deploy.Deployment.__new__(deploy.Deployment)
        runner.instance = instance(); runner.root = Path(runner.instance["root"])
        arguments = runner.compose_arguments()
        self.assertEqual(arguments[arguments.index("--project-directory") + 1], "/srv/canvas")
        runner.instance["projectDirectory"] = "/srv/canvas/current"
        arguments = runner.compose_arguments()
        self.assertEqual(arguments[arguments.index("--project-directory") + 1], "/srv/canvas/current")
        self.assertEqual(arguments[arguments.index("--env-file") + 1], runner.instance["environmentFile"])

    def test_premaintenance_rows_and_sequence_positions_may_advance_but_schema_may_not(self):
        before, grown = database_state(1), database_state(2)
        deploy.assert_database_layout(before, grown)
        for field, value in [("identity", {"systemIdentifier": "different"}), ("migrations", []),
                             ("columns", ["changed-column"]), ("indexes", ["changed-index"]),
                             ("constraints", ["changed-constraint"])]:
            changed = copy.deepcopy(grown); changed[field] = value
            with self.assertRaisesRegex(deploy.Rejected, "DATABASE_IDENTITY_OR_SCHEMA_CHANGED"):
                deploy.assert_database_layout(before, changed)
        changed = copy.deepcopy(grown); changed["sequences"][0]["increment_by"] = 10
        with self.assertRaisesRegex(deploy.Rejected, "DATABASE_IDENTITY_OR_SCHEMA_CHANGED"):
            deploy.assert_database_layout(before, changed)

    def test_activity_query_includes_only_original_optimizers_and_live_admission(self):
        query = deploy.activity_query("SELECT json_build_object('pausedTasks',0);\n")
        self.assertIn("WITH activity(snapshot)", query)
        self.assertIn("status='optimizing' AND reused_from_id IS NULL", query)
        self.assertIn("admission_status='admitting'", query)
        for verb in ["UPDATE ", "INSERT ", "DELETE "]:
            self.assertNotIn(verb, query)

    def test_rollback_refuses_unknown_complete_model_drift_before_cutover(self):
        model = compose()
        rows = [inspect(name, "same-image", role) for role, name in instance()["containers"].items()]
        deploy.assert_rollback_source(model, model, rows, rows, instance())
        for key, value in [("volumes", [{"type": "bind", "source": "/data/important", "target": "/important"}]),
                           ("networks", {"unreviewed": None}), ("ports", [{"target": 1234, "published": "1234"}]),
                           ("entrypoint", ["sh"]), ("command", ["bun", "changed.ts"])]:
            changed = copy.deepcopy(model); changed["services"]["api"][key] = value
            with self.assertRaisesRegex(deploy.Rejected, "ROLLBACK_COMPOSE_DRIFT"):
                deploy.assert_rollback_source(changed, model, rows, rows, instance())

    def test_rollback_refuses_live_mount_drift_even_with_unchanged_image_env_and_compose(self):
        model = compose()
        rows = [inspect(name, "same-image", role) for role, name in instance()["containers"].items()]
        changed = copy.deepcopy(rows)
        changed[0]["Mounts"].append({"Type": "bind", "Source": "/data/important", "Destination": "/important", "RW": True})
        with self.assertRaisesRegex(deploy.Rejected, "ROLLBACK_RUNNING_APPLICATION_DRIFT"):
            deploy.assert_rollback_source(model, model, changed, rows, instance())
        changed = copy.deepcopy(rows); changed[0]["State"]["StartedAt"] = "restarted"; changed[0]["RestartCount"] = 1
        deploy.assert_rollback_source(model, model, changed, rows, instance())

    @unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "requires CI Docker Compose CLI, never starts containers")
    def test_compose_cli_roundtrips_resolved_literal_environment(self):
        raw = {"services": {"api": {"image": "example.invalid/never-pulled:0", "environment": {"LITERAL": "literal-$secret-${OTHER}-$$-end"}, "command": ["sh", "-c", "printf '%s' $RUNTIME"]}}}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compose.json"
            path.write_text(json.dumps(deploy.compose_literals(raw)), encoding="utf-8")
            result = subprocess.run(["docker", "compose", "-p", "canvas-contract", "--project-directory", temporary, "-f", str(path), "config", "--format", "json"], capture_output=True, text=True, check=True)
            rendered = json.loads(result.stdout)
            self.assertEqual(rendered["services"]["api"]["environment"], raw["services"]["api"]["environment"])
            self.assertEqual(rendered["services"]["api"]["command"], raw["services"]["api"]["command"])

    def test_resolved_secret_and_command_dollars_are_literal_not_reexpanded(self):
        value = {"environment": {"KEY": "literal-$secret-${OTHER}"}, "command": ["sh", "-c", "echo $RUNTIME"]}
        result = deploy.compose_literals(value)
        self.assertEqual(result["environment"]["KEY"], "literal-$$secret-$${OTHER}")
        self.assertEqual(result["command"][-1], "echo $$RUNTIME")
        self.assertEqual(value["environment"]["KEY"], "literal-$secret-${OTHER}")
    def test_rollback_pins_actual_ids_and_removes_automatic_initialization(self):
        configuration = compose()
        configuration["services"]["api"]["command"] = ["sh", "-c", "bun src/migrate.ts && bun src/bootstrap.ts && bun src/index.ts"]
        rows = [inspect(name, "sha256:" + str(index) * 64, role) for index, (role, name) in enumerate(instance()["containers"].items(), 1)]
        original = copy.deepcopy(configuration)
        result = deploy.rollback_compose(configuration, rows, instance())
        self.assertEqual(configuration, original)
        self.assertEqual(result["services"]["api"]["image"], rows[0]["Image"])
        self.assertEqual(result["services"]["api"]["command"], ["bun", "src/index.ts"])
        self.assertEqual(result["services"]["web"]["ports"][0]["host_ip"], "127.0.0.1")

    def test_stop_requires_positive_known_state_for_every_target(self):
        rows = [inspect(name, "old", role) for role, name in instance()["containers"].items()]
        self.assertFalse(deploy.stopped(rows, instance()))
        for row in rows: row["State"]["Running"] = False
        self.assertTrue(deploy.stopped(rows, instance()))
        self.assertFalse(deploy.stopped(rows[:-1], instance()))
        rows[0]["State"]["Restarting"] = True
        self.assertFalse(deploy.stopped(rows, instance()))

    def fake_cutover(self, fail):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        runner = deploy.Deployment.__new__(deploy.Deployment)
        runner.instance = instance(); runner.audit = Path(temporary.name); runner.sequence = 0
        runner.calls = []; runner.failed = False
        runner.is_stopped = False
        rows = [inspect(name, "old", role) for role, name in instance()["containers"].items()]
        runner.prepared = {"containers": rows, "database": database_state(1), "configurationHashes": {}}
        # Legal activity while images are loaded advances rows and sequences.
        runner.database = database_state(2)
        def gate(operation): runner.calls.append("gate:" + operation)
        def sql(name, label):
            if name == "database-state.sql": return copy.deepcopy(runner.database)
            if name == "maintenance.sql": return {"longTransactions": 0, "waitingLocks": 0, "otherCanvasLocks": 0}
            return idle_activity()
        def stop(model):
            runner.calls.append("stop:" + str(model))
            if fail == "stop": raise deploy.Rejected("STOP_UNKNOWN")
            runner.is_stopped = True
            return inventory("stopped")
        def check(baseline, label):
            runner.calls.append("check:" + label)
            if fail == "database": raise deploy.Rejected("DATABASE_CHANGED")
        def command(arguments, **options):
            runner.calls.append(arguments[0])
            if options.get("output"): Path(options["output"]).write_bytes(b"fixture backup")
        def start(model):
            runner.calls.append("start:" + str(model))
            runner.is_stopped = False
        def health(origin, release=None):
            if fail == "health" and not runner.failed:
                runner.failed = True
                raise deploy.Rejected("HEALTH_FAILED")
        def inventory(label):
            rows = [inspect(name, "old", role) for role, name in instance()["containers"].items()]
            for row in rows: row["State"]["Running"] = not runner.is_stopped
            return rows
        runner.gate = gate; runner.sql = sql; runner.stop_app = stop; runner.protected_and_database = check
        runner.command = command; runner.start_app = start; runner.wait_health = health; runner.inventory = inventory
        runner.application_configuration_unchanged = lambda baseline: None
        return runner

    def test_uncertain_stop_never_starts_or_rolls_back_an_application(self):
        runner = self.fake_cutover("stop")
        with self.assertRaises(deploy.Rejected): runner.cutover(runner.prepared, "candidate", "fallback")
        self.assertFalse(any(call.startswith("start:") for call in runner.calls))
        self.assertNotIn("gate:open", runner.calls)

    def test_changed_database_refuses_restart_and_keeps_gate_closed(self):
        runner = self.fake_cutover("database")
        with self.assertRaises(deploy.Rejected): runner.cutover(runner.prepared, "candidate", "fallback")
        self.assertFalse(any(call.startswith("start:") for call in runner.calls))
        self.assertNotIn("gate:open", runner.calls)
        self.assertFalse(json.loads((runner.audit / "failure.json").read_text())["fallbackApplicationRestored"])

    def test_failed_new_health_restores_only_after_stop_and_unchanged_database_proof(self):
        runner = self.fake_cutover("health")
        with self.assertRaises(deploy.Rejected): runner.cutover(runner.prepared, "candidate", "fallback")
        self.assertLess(runner.calls.index("stop:candidate"), runner.calls.index("start:fallback"))
        self.assertLess(runner.calls.index("check:failed-stopped-check"), runner.calls.index("start:fallback"))
        self.assertNotIn("gate:open", runner.calls)
        self.assertTrue(json.loads((runner.audit / "failure.json").read_text())["fallbackApplicationRestored"])

    def test_legal_writes_during_image_load_are_frozen_after_stop_and_cutover_succeeds(self):
        runner = self.fake_cutover(None)
        del runner.protected_and_database  # Exercise the real full-data guard.
        target = runner.audit / "candidate.json"
        target.write_text(json.dumps({"services": {role: {"image": "old"} for role in instance()["containers"]}}))
        runner.cutover(runner.prepared, target, "fallback")
        final = json.loads((runner.audit / "baseline.private.json").read_text())
        self.assertEqual(final["database"], database_state(2))
        self.assertEqual(runner.prepared["database"], database_state(1))
        self.assertIn("gate:open", runner.calls)
        self.assertFalse((runner.audit / "failure.json").exists())

    def test_data_change_after_confirmed_stop_still_blocks_start_and_rollback(self):
        runner = self.fake_cutover(None)
        del runner.protected_and_database
        original = runner.command
        def command(arguments, **options):
            original(arguments, **options)
            if "pg_dump" in arguments: runner.database = database_state(3)
        runner.command = command
        with self.assertRaisesRegex(deploy.Rejected, "DATABASE_CHANGED_MANUAL_RECOVERY_REQUIRED"):
            runner.cutover(runner.prepared, "candidate", "fallback")
        final = json.loads((runner.audit / "baseline.private.json").read_text())
        self.assertEqual(final["database"], database_state(2))
        self.assertFalse(any(call.startswith("start:") for call in runner.calls))
        self.assertNotIn("gate:open", runner.calls)

    def test_drain_waits_read_only_for_tasks_chat_compilation_and_admission(self):
        runner = self.fake_cutover(None)
        seen = []
        for field in ["processingTasks", "processingChatRequests", "optimizingPromptCompilations", "admittingBatches"]:
            activity = idle_activity(); activity[field] = 1
            seen.append(activity)
        seen.append(idle_activity())
        snapshots = iter(seen)
        runner.sql = lambda name, label: next(snapshots)
        with patch("deploy.time.sleep") as sleep:
            result = runner.wait_for_drain(timeout_seconds=20, poll_seconds=1)
        self.assertEqual(result, idle_activity())
        self.assertEqual(sleep.call_count, 4)
        self.assertEqual(runner.calls, [])

    def test_drain_timeout_does_not_stop_or_resubmit_or_start_any_application(self):
        runner = self.fake_cutover(None)
        original = runner.sql
        def sql(name, label):
            result = original(name, label)
            if name == "activity.sql": result["optimizingPromptCompilations"] = 1
            return result
        runner.sql = sql
        with patch("deploy.time.monotonic", side_effect=[0, 1201]), patch("deploy.time.sleep"):
            with self.assertRaisesRegex(deploy.Rejected, "DRAIN_TIMEOUT"):
                runner.cutover(runner.prepared, "candidate", "fallback")
        self.assertFalse(any(call.startswith(("stop:", "start:")) for call in runner.calls))
        self.assertFalse((runner.audit / "baseline.private.json").exists())

    def test_malformed_drain_activity_fails_immediately_instead_of_waiting(self):
        runner = self.fake_cutover(None)
        malformed = idle_activity(); del malformed["optimizingPromptCompilations"]
        runner.sql = lambda name, label: malformed
        with patch("deploy.time.sleep") as sleep:
            with self.assertRaisesRegex(deploy.Rejected, "ACTIVITY_COUNT_INVALID"):
                runner.wait_for_drain(timeout_seconds=20)
        sleep.assert_not_called()


if __name__ == "__main__": unittest.main()
