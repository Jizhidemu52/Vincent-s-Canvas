"""Deployment failure-path tests use no Docker or remote resources."""
import copy
import base64
import json
import os
from pathlib import Path
import tempfile
import subprocess
import unittest
import uuid
from unittest.mock import patch

import deploy
from test_contract import compose, inspect, instance, mounts


def idle_activity():
    return {"waitingTasks": 0, "processingTasks": 0, "submittedWaitingTasks": 0,
            "processingChatRequests": 0, "processingAnalysisPreviews": 0,
            "optimizingPromptCompilations": 0, "admittingBatches": 0, "pendingAssetThumbnails": 0, "pausedTasks": 2}


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

    def test_rollback_accepts_only_mount_reordering_not_changed_fields_or_duplicate_mounts(self):
        model = compose()
        rows = [inspect(name, "same-image", role) for role, name in instance()["containers"].items()]
        for row in rows: row["Mounts"] = mounts()
        reordered = copy.deepcopy(rows)
        for row in reordered: row["Mounts"].reverse()
        deploy.assert_rollback_source(model, model, reordered, rows, instance())
        for values in [[dict(rows[0]["Mounts"][0], Source="/changed"), rows[0]["Mounts"][1]],
                       rows[0]["Mounts"][:-1], rows[0]["Mounts"] + [rows[0]["Mounts"][0]]]:
            with self.subTest(mounts=values):
                changed = copy.deepcopy(reordered); changed[0]["Mounts"] = copy.deepcopy(values)
                with self.assertRaisesRegex(deploy.Rejected, "ROLLBACK_RUNNING_APPLICATION_DRIFT"):
                    deploy.assert_rollback_source(model, model, changed, rows, instance())

    def test_preparation_accepts_mount_reordering_but_refuses_actual_drift(self):
        runner = deploy.Deployment.__new__(deploy.Deployment)
        rows = [inspect(name, "same-image", role) for role, name in instance()["containers"].items()]
        rows.append(inspect("newvcan-api-1", "same-image", "api"))
        for row in rows: row["Mounts"] = mounts()
        baseline = {"containers": rows, "database": database_state()}
        current = copy.deepcopy(rows)
        for row in current: row["Mounts"].reverse()
        runner.application_configuration_unchanged = lambda baseline: None
        runner.inventory = lambda label: copy.deepcopy(current)
        runner.sql = lambda name, label: database_state()
        runner.preparation_unchanged(baseline)
        current[-1]["Mounts"][0]["Source"] = "/changed"
        with self.assertRaisesRegex(deploy.Rejected, "CONTAINER_DRIFT_DURING_PREPARATION"):
            runner.preparation_unchanged(baseline)

    @unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "requires CI Docker Compose CLI, never starts containers")
    def test_compose_cli_roundtrips_resolved_literal_environment(self):
        raw = {"services": {"api": {"image": "example.invalid/never-pulled:0", "environment": {"LITERAL": "literal-$secret-${OTHER}-$$-end"}, "command": ["sh", "-c", "printf '%s' $RUNTIME"]}}}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compose.json"
            path.write_text(json.dumps(deploy.compose_literals(raw)), encoding="utf-8")
            executable = [os.environ["DOCKER_COMPOSE_TEST_BINARY"]] if os.environ.get("DOCKER_COMPOSE_TEST_BINARY") else ["docker", "compose"]
            for _ in range(3):
                result = subprocess.run(executable + ["-p", "canvas-contract", "--project-directory", temporary, "-f", str(path), "config", "--format", "json"], capture_output=True, text=True, check=True)
                rendered = deploy.parse_compose_config(result.stdout)
                self.assertEqual(rendered["services"]["api"]["environment"], raw["services"]["api"]["environment"])
                self.assertEqual(rendered["services"]["api"]["command"], raw["services"]["api"]["command"])
                path.write_text(json.dumps(deploy.compose_literals(rendered)), encoding="utf-8")

    def test_compose_config_output_is_reescaped_and_decoded_once(self):
        raw = {"services": {"api": {"environment": {"LITERAL": "$one-${TWO}-$$-$$$-$$$$-end$"}, "command": ["echo $RUNTIME"]}}}
        rendered = json.dumps(raw).replace("$", "$$")
        self.assertEqual(deploy.parse_compose_config(rendered), raw)
        self.assertEqual(deploy.parse_compose_config(rendered.encode()), raw)
        with self.assertRaisesRegex(deploy.Rejected, "UNEXPECTED_COMPOSE_DOLLAR_ENCODING"):
            deploy.parse_compose_config(json.dumps(raw))

    @unittest.skipUnless(os.environ.get("COMPOSE_RUNTIME_TEST_IMAGE"), "requires exact CI-built API image and isolated Docker container")
    def test_compose_literal_environment_reaches_exact_isolated_runtime(self):
        literal = "literal-$secret-${OTHER}-$$-$$$-end$"
        argument = "printf '%s' $RUNTIME ${NOT_FROM_HOST} $$"
        encoded_literal = base64.b64encode(literal.encode()).decode()
        encoded_argument = base64.b64encode(argument.encode()).decode()
        script = ("const decode=s=>Buffer.from(s,'base64').toString();"
                  "if(process.env.LITERAL!==decode('%s'))throw Error('literal environment changed');"
                  "if(process.argv.at(-1)!==decode('%s'))throw Error('literal command changed');"
                  "console.log('COMPOSE_LITERAL_RUNTIME_OK')") % (encoded_literal, encoded_argument)
        raw = {"services": {"probe": {"image": os.environ["COMPOSE_RUNTIME_TEST_IMAGE"], "pull_policy": "never",
                "entrypoint": ["bun", "--no-env-file", "-e"], "command": [script, "--", argument],
                "environment": {"LITERAL": literal}, "network_mode": "none", "read_only": True,
                "cap_drop": ["ALL"], "security_opt": ["no-new-privileges:true"], "mem_limit": "512m", "pids_limit": 64}}}
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "compose.json"
            path.write_text(json.dumps(deploy.compose_literals(raw)), encoding="utf-8")
            project = "canvas-literal-" + uuid.uuid4().hex[:12]
            result = subprocess.run(["docker", "compose", "-p", project, "--project-directory", temporary,
                                     "-f", str(path), "run", "--rm", "--no-deps", "--pull", "never", "probe"],
                                    capture_output=True, text=True, check=True, timeout=90)
            self.assertIn("COMPOSE_LITERAL_RUNTIME_OK", result.stdout)

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
        runner.wait_worker_health = lambda expected_image, previous_id: None
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

    def test_worker_readiness_failure_uses_existing_guarded_fallback(self):
        runner = self.fake_cutover(None)
        target = runner.audit / "candidate.json"
        target.write_text(json.dumps({"services": {role: {"image": "old"} for role in instance()["containers"]}}))
        def worker_health(expected_image, previous_id):
            self.assertEqual(expected_image, "old")
            self.assertEqual(previous_id, "1" * 64)
            raise deploy.Rejected("WORKER_HEALTH_NOT_READY")
        runner.wait_worker_health = worker_health
        with self.assertRaisesRegex(deploy.Rejected, "WORKER_HEALTH_NOT_READY"):
            runner.cutover(runner.prepared, target, "fallback")
        self.assertLess(runner.calls.index("stop:" + str(target)), runner.calls.index("check:failed-stopped-check"))
        self.assertLess(runner.calls.index("check:failed-stopped-check"), runner.calls.index("start:fallback"))
        self.assertNotIn("gate:open", runner.calls)
        self.assertTrue(json.loads((runner.audit / "failure.json").read_text())["fallbackApplicationRestored"])

    def test_worker_readiness_binds_release_image_id_not_a_compose_tag(self):
        runner = self.fake_cutover(None)
        release = {"images": {"api": {"id": "sha256:" + "b" * 64}}}
        def worker_health(expected_image, previous_id):
            self.assertEqual(expected_image, "sha256:" + "b" * 64)
            self.assertEqual(previous_id, "1" * 64)
            raise deploy.Rejected("WORKER_HEALTH_NOT_READY")
        runner.wait_worker_health = worker_health
        with self.assertRaisesRegex(deploy.Rejected, "WORKER_HEALTH_NOT_READY"):
            runner.cutover(runner.prepared, "candidate", "fallback", release=release)

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
        for field in ["processingTasks", "processingChatRequests", "optimizingPromptCompilations", "admittingBatches", "pendingAssetThumbnails"]:
            activity = idle_activity(); activity[field] = 1
            seen.append(activity)
        seen.append(idle_activity())
        snapshots = iter(seen)
        runner.sql = lambda name, label: next(snapshots)
        with patch("deploy.time.sleep") as sleep:
            result = runner.wait_for_drain(timeout_seconds=20, poll_seconds=1)
        self.assertEqual(result, idle_activity())
        self.assertEqual(sleep.call_count, 5)
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


class WorkerReadinessTests(unittest.TestCase):
    image = "sha256:" + "b" * 64
    old_id = "2" * 64

    def worker(self):
        row = inspect(instance()["containers"]["worker"], self.image, "worker")
        # A cached Docker status must not bypass the original heartbeat probe.
        row["State"]["Health"] = {"Status": "healthy"}
        return row

    def runner(self, outcomes, snapshots=None, probe_seconds=0):
        runner = deploy.Deployment.__new__(deploy.Deployment)
        runner.instance = instance()
        clock = {"now": 0.0}
        calls = []
        snapshots = snapshots or [self.worker()]
        inspections = 0
        probes = 0
        def command(arguments, **options):
            nonlocal inspections, probes
            calls.append((arguments, options))
            self.assertGreater(options["timeout"], 0)
            if arguments == ["docker", "inspect", runner.instance["containers"]["worker"]]:
                row = snapshots[min(inspections, len(snapshots) - 1)]
                inspections += 1
                return json.dumps([row]).encode()
            self.assertEqual(arguments, ["docker", "exec", "1" * 64, "bun", "src/worker-healthcheck.ts"])
            clock["now"] += probe_seconds
            result = outcomes[min(probes, len(outcomes) - 1)]
            probes += 1
            if isinstance(result, str): raise deploy.Rejected(result)
            if not result: raise deploy.Rejected("COMMAND_FAILED_SEE_PRIVATE_AUDIT")
            return b""
        runner.command = command
        monotonic = patch("deploy.time.monotonic", side_effect=lambda: clock["now"])
        sleep = patch("deploy.time.sleep", side_effect=lambda seconds: clock.update(now=clock["now"] + seconds))
        monotonic.start(); sleep.start()
        self.addCleanup(monotonic.stop); self.addCleanup(sleep.stop)
        return runner, calls, clock

    def test_initial_missing_heartbeat_waits_then_accepts_same_new_worker(self):
        runner, calls, clock = self.runner([False, True])
        result = runner.wait_worker_health(self.image, self.old_id, timeout_seconds=10, poll_seconds=2)
        self.assertEqual(result, "1" * 64)
        self.assertEqual(clock["now"], 2)
        self.assertEqual(len([args for args, _ in calls if args[1] == "exec"]), 2)
        self.assertTrue(all(args[1] in ("inspect", "exec") for args, _ in calls))

    def test_permanent_not_ready_expires_without_start_stop_or_other_mutation(self):
        runner, calls, clock = self.runner([False])
        with self.assertRaisesRegex(deploy.Rejected, "WORKER_HEALTH_NOT_READY"):
            runner.wait_worker_health(self.image, self.old_id, timeout_seconds=4, poll_seconds=1)
        self.assertEqual(clock["now"], 4)
        self.assertEqual(len([args for args, _ in calls if args[1] == "exec"]), 4)
        self.assertTrue(all(options["timeout"] <= 4 for _, options in calls))

    def test_default_budget_allows_startup_period_before_first_heartbeat(self):
        runner, _, clock = self.runner([False] * 46 + [True])
        self.assertEqual(runner.wait_worker_health(self.image, self.old_id), "1" * 64)
        self.assertEqual(clock["now"], 92)

    def test_recreated_or_restarted_worker_cannot_satisfy_an_existing_probe(self):
        for mutate in [lambda row: row.update(Id="3" * 64),
                       lambda row: row.update(Image="sha256:" + "c" * 64),
                       lambda row: row.update(RestartCount=1),
                       lambda row: row["State"].update(StartedAt="restarted"),
                       lambda row: row["State"].update(Running=False),
                       lambda row: row["State"].update(Restarting=True)]:
            with self.subTest(mutate=mutate):
                changed = self.worker(); mutate(changed)
                runner, calls, clock = self.runner([True], [self.worker(), changed])
                with self.assertRaises(deploy.Rejected):
                    runner.wait_worker_health(self.image, self.old_id)
                self.assertEqual(clock["now"], 0)
                self.assertEqual(len([args for args, _ in calls if args[1] == "exec"]), 1)

    def test_wrong_image_identity_or_old_container_is_rejected_before_exec(self):
        for mutate in [lambda row: row.update(Image="sha256:" + "c" * 64),
                       lambda row: row.update(Id=self.old_id),
                       lambda row: row.update(Name="/another-worker"),
                       lambda row: row["Config"]["Labels"].update({"com.docker.compose.project": "another-project"}),
                       lambda row: row["Config"]["Labels"].update({"com.docker.compose.service": "api"}),
                       lambda row: row["State"].update(Paused=True)]:
            with self.subTest(mutate=mutate):
                changed = self.worker(); mutate(changed)
                runner, calls, _ = self.runner([True], [changed])
                with self.assertRaises(deploy.Rejected):
                    runner.wait_worker_health(self.image, self.old_id)
                self.assertFalse(any(args[1] == "exec" for args, _ in calls))

    def test_probe_transport_timeout_is_not_retried(self):
        runner, calls, clock = self.runner(["COMMAND_FAILED_OR_TIMED_OUT_NO_AUTOMATIC_RETRY"])
        with self.assertRaisesRegex(deploy.Rejected, "COMMAND_FAILED_OR_TIMED_OUT_NO_AUTOMATIC_RETRY"):
            runner.wait_worker_health(self.image, self.old_id)
        self.assertEqual(clock["now"], 0)
        self.assertEqual(len([args for args, _ in calls if args[1] == "exec"]), 1)

    def test_success_after_deadline_is_not_accepted(self):
        runner, _, _ = self.runner([True], probe_seconds=5)
        with self.assertRaisesRegex(deploy.Rejected, "WORKER_HEALTH_NOT_READY"):
            runner.wait_worker_health(self.image, self.old_id, timeout_seconds=4, poll_seconds=1)

    def test_nonpositive_or_unbounded_wait_is_rejected_without_commands(self):
        runner, calls, _ = self.runner([True])
        for timeout, poll in [(0, 1), (-1, 1), (float("inf"), 1), (10, 0), (10, -1)]:
            with self.subTest(timeout=timeout, poll=poll):
                with self.assertRaisesRegex(deploy.Rejected, "BOUNDED_WORKER_READINESS_REQUIRED"):
                    runner.wait_worker_health(self.image, self.old_id, timeout_seconds=timeout, poll_seconds=poll)
        self.assertEqual(calls, [])


if __name__ == "__main__": unittest.main()
