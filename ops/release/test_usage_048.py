"""Fixed operator tests: pure contracts plus optional isolated WASM PostgreSQL."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from contract import Rejected
from test_contract import compose, inspect, instance

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("usage_048", HERE / "usage-048.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
CATALOG = json.loads((HERE / "usage-048-catalog.json").read_text(encoding="utf-8"))


def before_state():
    return {"identity": {"database": "canvas", "schema": "public", "systemIdentifier": "same-cluster"},
            "migrations": [{"name": "001_schema.sql", "applied_at": "old-time"}],
            "sequences": [{"sequencename": "audit_logs_id_seq", "last_value": 17}],
            "sequenceStates": [{"name": "audit_logs_id_seq", "lastValue": "17", "isCalled": True}],
            "tables": [{"name": "business", "count": 4, "sha256": "a" * 64}, {"name": "schema_migrations", "count": 1, "sha256": "b" * 64}],
            **{field: [] for field in operator.SORT_KEYS}}


def after_state(before=None):
    before = before or before_state()
    value = copy.deepcopy(before)
    value.update(operator.catalog_union(before, CATALOG))
    value["migrations"].append({"name": operator.MIGRATION, "applied_at": "new-time"})
    value["tables"][1]["count"] = 2; value["tables"][1]["sha256"] = "c" * 64
    value["tables"] += [{"name": name, "count": 1 if name in {"usage_rollup_state", "usage_dirty_days"} else 0, "sha256": "d" * 64} for name in sorted(operator.NEW_TABLES)]
    return value


class Usage048Contracts(unittest.TestCase):
    def test_exact_allowed_delta_preserves_all_old_data_and_sequences(self):
        operator.assert_048_delta(before_state(), after_state(), CATALOG)
        mutations = [lambda s: s["identity"].update(database="other"),
                     lambda s: s["sequences"][0].update(last_value=18),
                     lambda s: s["sequenceStates"][0].update(isCalled=False),
                     lambda s: s["tables"][0].update(sha256="e" * 64),
                     lambda s: s["migrations"][0].update(applied_at="changed"),
                     lambda s: s["tables"].append({"name": "unknown", "count": 0, "sha256": "f" * 64})]
        for change in mutations:
            with self.subTest(change=change):
                state = after_state(); change(state)
                with self.assertRaises(Rejected): operator.assert_048_delta(before_state(), state, CATALOG)
        for field in operator.SORT_KEYS:
            with self.subTest(field=field):
                state = after_state(); state[field][0] = dict(state[field][0], unexpected=True)
                with self.assertRaises(Rejected): operator.assert_048_delta(before_state(), state, CATALOG)

    def test_initial_source_invalidation_journal_must_be_empty(self):
        state = after_state()
        next(row for row in state["tables"] if row["name"] == "usage_source_invalidations")["count"] = 1
        with self.assertRaisesRegex(Rejected, "048_PROCESSING_STARTED_BEFORE_ENABLE"):
            operator.assert_048_delta(before_state(), state, CATALOG)

    def test_existing_048_or_unexpected_previous_migration_is_rejected(self):
        release = {"migrations": [{"name": "001_schema.sql"}, {"name": operator.MIGRATION}]}
        operator.validate_source_migrations(before_state(), release, {"retainedMigrationNames": []})
        for names in [[operator.MIGRATION], [], ["001_schema.sql", "extra.sql"], ["001_schema.sql", "001_schema.sql"]]:
            with self.subTest(names=names), self.assertRaises(Rejected):
                operator.validate_source_migrations({"migrations": [{"name": n} for n in names]}, release, {"retainedMigrationNames": []})

    def test_transaction_has_one_commit_after_registration_and_guards(self):
        sql = operator.migration_sql(before_state(), CATALOG, "-- exact package SQL")
        self.assertEqual(sql.count("COMMIT;"), 1)
        self.assertLess(sql.index("LOCK TABLE"), sql.index("-- exact package SQL"))
        self.assertLess(sql.index("-- exact package SQL"), sql.index("INSERT INTO schema_migrations"))
        self.assertLess(sql.index("048_ORIGINAL_BUSINESS_ROWS_CHANGED"), sql.index("COMMIT;"))
        self.assertIn("SET LOCAL lock_timeout='30s'", sql)
        self.assertIn("SET LOCAL statement_timeout='300s'", sql)
        self.assertNotIn("DROP TABLE", sql)

    def test_control_uses_exclusive_shared_protocol_and_only_flag_assignment(self):
        for enabled in [False, True]:
            sql = operator.control_sql(enabled, before_state()["identity"], CATALOG)
            self.assertIn("pg_advisory_xact_lock(" + operator.CONTROL_LOCK + ")", sql)
            self.assertIn("UPDATE usage_rollup_state SET processing_enabled=", sql)
            self.assertIn("FOR UPDATE", sql)
            self.assertIn("048_CONTROL_NON_FLAG_STATE_CHANGED", sql)
            self.assertNotIn(" @> ", sql)
            self.assertNotIn("DELETE FROM", sql)
            body = sql.split("$canvas048json$::jsonb;", 1)[1]
            self.assertNotIn("INSERT INTO", body)

    def rows(self):
        rows = [inspect(name, "same-image", role) for role, name in instance()["containers"].items()]
        for row in rows:
            row["NetworkSettings"]["Networks"][instance()["network"]].update(
                IPAddress="172.19.0.5", IPPrefixLen=16, Gateway="172.19.0.1", IPAMConfig=None,
                IPv6Gateway="", GlobalIPv6PrefixLen=0)
        return rows

    def test_same_id_restart_accepts_only_reviewed_dynamic_ipv4_same_subnet(self):
        rows = self.rows(); after = copy.deepcopy(rows)
        for row in after:
            row["NetworkSettings"]["Networks"][instance()["network"]]["IPAddress"] = "172.19.0.17"
            row["State"]["StartedAt"] = "new-start"
        operator.assert_same_original(rows, after, compose(), instance(), True)
        for field, value in [("IPAddress", "172.20.0.7"), ("Gateway", "172.19.0.2"), ("IPPrefixLen", 24),
                             ("IPAMConfig", {}), ("NetworkID", "new-network"), ("Aliases", ["changed"]), ("GlobalIPv6Address", "::1")]:
            state = copy.deepcopy(after)
            state[0]["NetworkSettings"]["Networks"][instance()["network"]][field] = value
            with self.subTest(field=field), self.assertRaises(Rejected):
                operator.assert_same_original(rows, state, compose(), instance(), True)
        for field in ["Id", "Image"]:
            state = copy.deepcopy(after); state[0][field] = "different"
            with self.assertRaises(Rejected): operator.assert_same_original(rows, state, compose(), instance(), True)
        model = compose(); model["services"]["api"]["networks"] = {"default": {"ipv4_address": "172.19.0.5"}}
        with self.assertRaises(Rejected): operator.assert_same_original(rows, after, model, instance(), True)

    def test_original_start_never_recreates_and_refuses_config_drift(self):
        runner = operator.Usage048.__new__(operator.Usage048)
        runner.instance = instance()
        rows = self.rows()
        state = copy.deepcopy(rows)
        for row in state: row["State"]["Running"] = False
        runner.inventory = lambda label: copy.deepcopy(state)
        commands = []
        runner.command = lambda args, **kwargs: commands.append(args)
        baseline = {"containers": rows, "model": compose()}
        runner.start_original(baseline)
        self.assertEqual(commands, [["docker", "start", *[row["Id"] for row in rows]]])
        state[0]["Config"]["Env"].append("NEW=drift")
        with self.assertRaises(Rejected): runner.start_original(baseline)
        self.assertEqual(len(commands), 1)

    def test_stopped_endpoint_may_be_empty_but_not_reconfigured(self):
        rows = self.rows(); stopped = copy.deepcopy(rows)
        for row in stopped:
            row["State"]["Running"] = False
            row["NetworkSettings"]["Networks"][instance()["network"]].update(IPAddress="", Gateway="", IPPrefixLen=0)
        operator.assert_same_original(rows, stopped, compose(), instance(), False)
        for field, value in [("NetworkID", "different"), ("IPAMConfig", {}), ("Aliases", ["different"]), ("Gateway", "172.18.0.1")]:
            changed = copy.deepcopy(stopped)
            changed[0]["NetworkSettings"]["Networks"][instance()["network"]][field] = value
            with self.subTest(field=field), self.assertRaises(Rejected):
                operator.assert_same_original(rows, changed, compose(), instance(), False)

    def fake_migrate(self, failure=None):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); audit = root / "audit"; audit.mkdir()
        prior = root / "prior"; prior.mkdir(); package = root / "package"; package.mkdir()
        runner = operator.Usage048.__new__(operator.Usage048)
        runner.instance = instance(); runner.instance["minimumFreeBytes"] = 0
        runner.instance["retainedMigrationNames"] = []
        runner.instance_path = root / "instance.json"; runner.root = root; runner.audit = audit
        runner.calls = []
        rows = self.rows()
        current = {"model": compose(), "containers": rows, "database": before_state(), "configurationHashes": {}}
        (prior / "preflight.json").write_text(json.dumps({"kind": "usage-048-preflight", "createdAt": time.time(),
            "instanceSha256": "hash", "manifestSha256": "hash", "sqlSha256": "hash", "package": str(package), "baseline": current}), encoding="utf-8")
        sql = package / operator.SQL_PATH; sql.parent.mkdir(parents=True); sql.write_text("-- fixed SQL", encoding="utf-8")
        release = {"migrations": [{"name": "001_schema.sql"}, {"name": operator.MIGRATION}]}
        runner.new_audit = lambda name: audit
        runner.capture = lambda label: copy.deepcopy(current)
        runner.assert_platform = lambda value: None
        runner.preparation_unchanged = lambda value: None
        runner.gate = lambda action: runner.calls.append("gate:" + action)
        runner.wait_for_drain = lambda: runner.calls.append("drain")
        runner.stop_app = lambda model: runner.calls.append("stop") or rows
        runner.freeze_stopped_baseline = lambda value, stopped_rows: copy.deepcopy(current)
        runner.backup_048 = lambda: runner.calls.append("backup")
        runner.protected_and_database = lambda *args: None
        def raw_sql(query, label, **options):
            runner.calls.append("transaction")
            if failure == "sql": raise Rejected("COMMAND_FAILED_OR_TIMED_OUT_NO_AUTOMATIC_RETRY")
        runner.raw_sql = raw_sql
        runner.sql = lambda name, label: after_state() if name == "database-state.sql" else {"waitingTasks": 0, "processingTasks": 0, "submittedWaitingTasks": 0, "processingChatRequests": 0, "processingAnalysisPreviews": 0, "optimizingPromptCompilations": 0, "admittingBatches": 0, "pausedTasks": 8}
        runner.disabled = lambda label: None
        runner.inventory = lambda label: rows
        runner.application_configuration_unchanged = lambda baseline: None
        runner.start_original = lambda baseline: runner.calls.append("start-original")
        def health(origin):
            runner.calls.append("health")
            if failure == "health": raise Rejected("APPLICATION_HEALTH_NOT_READY")
        runner.wait_health = health
        runner.command = lambda *args, **options: None
        patches = [patch.object(operator, "verify_048_package", return_value=(release, CATALOG)),
                   patch.object(operator, "private_directory", side_effect=lambda value: Path(value)),
                   patch.object(operator, "sha_file", return_value="hash"), patch.object(operator, "digest_file", return_value="hash")]
        for item in patches: item.start(); self.addCleanup(item.stop)
        return runner, package, prior

    def test_migrate_success_uses_backup_once_sql_once_original_restart_then_gate(self):
        runner, package, prior = self.fake_migrate()
        result = runner.migrate_048(package, prior)
        self.assertEqual(result["status"], "048-migrated-disabled")
        self.assertEqual(runner.calls.count("transaction"), 1)
        self.assertLess(runner.calls.index("backup"), runner.calls.index("transaction"))
        self.assertLess(runner.calls.index("transaction"), runner.calls.index("start-original"))
        self.assertLess(runner.calls.index("start-original"), runner.calls.index("gate:open"))

    def test_unknown_sql_outcome_keeps_gate_and_never_retries_or_starts(self):
        runner, package, prior = self.fake_migrate("sql")
        with self.assertRaisesRegex(Rejected, "NO_AUTOMATIC_RETRY"): runner.migrate_048(package, prior)
        self.assertEqual(runner.calls.count("transaction"), 1)
        self.assertNotIn("start-original", runner.calls)
        self.assertNotIn("gate:open", runner.calls)
        failure = json.loads((runner.audit / "failure.json").read_text(encoding="utf-8"))
        self.assertEqual(failure["phase"], "sql-outcome-unknown-until-verified")
        self.assertFalse(failure["automaticRestore"])
        self.assertFalse((runner.audit / "receipt.json").exists())

    def test_postcommit_health_failure_is_not_reclassified_as_rollback(self):
        runner, package, prior = self.fake_migrate("health")
        with self.assertRaisesRegex(Rejected, "HEALTH_NOT_READY"): runner.migrate_048(package, prior)
        self.assertEqual(runner.calls.count("transaction"), 1)
        self.assertEqual(runner.calls.count("start-original"), 1)
        self.assertNotIn("gate:open", runner.calls)
        failure = json.loads((runner.audit / "failure.json").read_text(encoding="utf-8"))
        self.assertEqual(failure["phase"], "schema-committed-original-start-pending")
        self.assertFalse((runner.audit / "receipt.json").exists())

    def test_function_or_trigger_drift_during_drain_is_not_absorbed_into_baseline(self):
        runner, package, prior = self.fake_migrate()
        freeze = runner.freeze_stopped_baseline
        def changed(current, rows):
            baseline = freeze(current, rows)
            baseline["database"]["functions"].append({"identity": "unexpected()", "definition": "changed"})
            return baseline
        runner.freeze_stopped_baseline = changed
        with self.assertRaisesRegex(Rejected, "048_CATALOG_DRIFT_DURING_DRAIN"):
            runner.migrate_048(package, prior)
        self.assertNotIn("transaction", runner.calls)
        self.assertNotIn("start-original", runner.calls)

    def fake_enable(self, tamper=None):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root = Path(temporary.name); applied = root / "applied"; applied.mkdir()
        audit = root / "control"; audit.mkdir()
        runner = operator.Usage048.__new__(operator.Usage048)
        runner.instance = instance(); runner.instance["retainedMigrationNames"] = []
        runner.instance_path = root / "instance.json"; runner.instance_path.write_text("fixture", encoding="utf-8")
        runner.audit = audit; runner.calls = []
        rows = self.rows(); model = compose()
        current = after_state(); current["identity"]["database"] = runner.instance["database"]["name"]
        release = {"commit": "1" * 40, "migrations": [{"name": row["name"]} for row in current["migrations"]],
                   "images": {role: {"id": "same-image"} for role in ["api", "web"]}}
        evidence_values = {"baseline.private.json": {"database": current}, "candidate-model.private.json": model,
                           "candidate.private.json": operator.compose_literals(model), "containers-started.private.json": rows}
        for name, value in evidence_values.items(): (applied / name).write_text(json.dumps(value), encoding="utf-8")
        receipt = {"status": "applied", "instanceSha256": operator.sha_file(runner.instance_path), "commit": release["commit"],
                   "databaseChanged": False, "infrastructureChanged": False, "databaseBaseline": "confirmed-stopped",
                   "imageIds": {role: "same-image" for role in ["api", "web"]},
                   "rollbackEvidence": {name: operator.sha_file(applied / name) for name in evidence_values}}
        if tamper == "commit": receipt["commit"] = "2" * 40
        (applied / "receipt.json").write_text(json.dumps(receipt), encoding="utf-8")
        if tamper == "evidence": (applied / "candidate.private.json").write_text("{}", encoding="utf-8")
        if tamper == "image": rows = copy.deepcopy(rows); rows[0]["Image"] = "wrong-image"
        runner.new_audit = lambda name: audit
        runner.compose = lambda *args, **kwargs: json.dumps(operator.compose_literals(model)).encode()
        runner.inventory = lambda label: rows
        runner.command = lambda *args, **kwargs: b'[{}]'
        runner.sql = lambda *args: copy.deepcopy(current)
        runner.gate = lambda action: runner.calls.append("gate:" + action)
        runner.raw_sql = lambda query, label, **options: runner.calls.append("transaction")
        patches = [patch.object(operator, "verify_048_package", return_value=(release, CATALOG)),
                   patch.object(operator, "private_directory", side_effect=lambda value: Path(value)),
                   patch.object(operator, "assert_live_inventory"), patch.object(operator, "assert_configured_environment")]
        for item in patches: item.start(); self.addCleanup(item.stop)
        return runner, root, applied

    def test_enable_requires_matching_successful_apply_evidence_and_live_images(self):
        runner, package, applied = self.fake_enable()
        # manifest and SQL hashes are independently checked by verify_048_package;
        # this test exercises the apply receipt/live target linkage itself.
        with patch.object(operator, "digest_file", return_value="hash"), patch.object(operator, "sha_file", wraps=operator.sha_file) as hashing:
            original = hashing._mock_wraps
            hashing.side_effect = lambda path: "manifest-hash" if Path(path).name == "release-manifest.json" else original(path)
            result = runner.control_048(package, True, applied)
        self.assertEqual(result["status"], "048-enabled")
        self.assertEqual(runner.calls, ["gate:verify-open", "transaction"])
        for tamper in ["commit", "evidence", "image"]:
            with self.subTest(tamper=tamper):
                target, package, prior = self.fake_enable(tamper)
                with self.assertRaises(Rejected): target.control_048(package, True, prior)
                self.assertNotIn("transaction", target.calls)

    def test_disable_has_no_apply_receipt_requirement_or_busy_capture(self):
        runner, package, _ = self.fake_enable()
        runner.capture = lambda *args: self.fail("control must not reject a busy database before waiting for the advisory lock")
        with patch.object(operator, "digest_file", return_value="hash"), patch.object(operator, "sha_file", return_value="hash"):
            result = runner.control_048(package, False)
        self.assertEqual(result["status"], "048-disabled")
        self.assertEqual(runner.calls, ["transaction"])

    def test_unknown_transaction_result_is_not_retried(self):
        source = (HERE / "usage-048.py").read_text(encoding="utf-8")
        self.assertIn('"automaticRetry": False', source)
        self.assertIn('"automaticRestore": False', source)
        self.assertNotIn("pg_restore\", \"-d", source)


@unittest.skipUnless(os.environ.get("PGLITE_RUNTIME_PATH"), "requires explicit disposable PGlite runtime; no network PostgreSQL")
class Usage048IsolatedSql(unittest.TestCase):
    def execute(self, operations):
        environment = dict(os.environ, USAGE_048_TEST_PYTHON=sys.executable)
        process = subprocess.run(["node", str(HERE / "test_usage_048_sql.mjs")], input=json.dumps(operations), text=True,
                                 encoding="utf-8", capture_output=True, timeout=60, env=environment)
        self.assertEqual(process.returncode, 0, process.stderr)
        results = json.loads(process.stdout)
        for result in results:
            if "snapshotJson" in result: result["snapshot"] = json.loads(result.pop("snapshotJson"))
        return results

    def test_fixed_catalog_is_exactly_the_migration_catalog(self):
        process = subprocess.run(["node", str(HERE / "test_usage_048_sql.mjs"), "catalog"], text=True, encoding="utf-8", capture_output=True, timeout=60)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(json.loads(process.stdout), CATALOG)

    def test_exact_migration_commits_disabled_with_zero_business_delta(self):
        result = self.execute([{"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"},
                               {"sql": "SELECT processing_enabled,(SELECT count(*)::int FROM usage_source_invalidations) AS source_invalidations FROM usage_rollup_state"}])
        self.assertTrue(result[1]["ok"], result[1])
        operator.assert_048_delta(result[0]["snapshot"], result[2]["snapshot"], CATALOG)
        self.assertEqual(result[3]["values"][0]["rows"], [{"processing_enabled": False, "source_invalidations": 0}])

    def test_business_or_catalog_mutation_rolls_back_entire_schema_and_registration(self):
        for injected in ["UPDATE schema_migrations SET applied_at=now()", "CREATE TABLE unrelated(id int)",
                         "ALTER TABLE users ADD COLUMN unrelated text", "CREATE SEQUENCE unwanted_seq",
                         "INSERT INTO usage_source_invalidations(day) VALUES('2026-09-01')"]:
            with self.subTest(injected=injected):
                result = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(result[1]["ok"], result[1])
                self.assertEqual(result[0]["snapshot"], result[2]["snapshot"])

    def test_control_keeps_all_rows_except_flag_and_refuses_unexpected_state_trigger(self):
        result = self.execute([{"kind": "migration"}, {"sql": "INSERT INTO usage_source_invalidations(day) VALUES('2026-09-01')"},
                               {"kind": "snapshot"}, {"kind": "control", "enabled": True},
                               {"kind": "control", "enabled": False}, {"kind": "snapshot"},
                               {"sql": "CREATE FUNCTION unexpected_state_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER unexpected BEFORE UPDATE ON usage_rollup_state FOR EACH ROW EXECUTE FUNCTION unexpected_state_trigger();"},
                               {"kind": "control", "enabled": True}, {"sql": "SELECT processing_enabled FROM usage_rollup_state"}])
        for index in [0, 1, 2, 3, 4, 5, 6, 8]: self.assertTrue(result[index]["ok"], result[index])
        self.assertEqual(next(row for row in result[2]["snapshot"]["tables"] if row["name"] == "usage_source_invalidations")["count"], 1)
        self.assertEqual(result[2]["snapshot"], result[5]["snapshot"])
        self.assertFalse(result[7]["ok"], result[7])
        self.assertEqual(result[8]["values"][0]["rows"], [{"processing_enabled": False}])


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--sql-builder":
        request = json.load(sys.stdin)
        before = json.loads(request["beforeJson"])
        if request["kind"] == "control":
            value = operator.control_sql(request["enabled"], before["identity"], CATALOG)
        else:
            source = (HERE.parent.parent / operator.SQL_PATH).read_text(encoding="utf-8")
            value = operator.migration_sql(before, CATALOG, source + ";\n" + request.get("inject", "") + ";\n")
        # Match raw_sql().encode exactly; Windows text stdout would translate
        # LF into CRLF inside stored function bodies and change their catalog.
        sys.stdout.buffer.write(value.encode("utf-8"))
    else: unittest.main()
