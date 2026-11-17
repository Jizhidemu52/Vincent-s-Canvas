import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from contract import Rejected

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
spec = importlib.util.spec_from_file_location("canvas_design_chat_053", HERE / "canvas-design-chat-053.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
CATALOG = json.loads((HERE / "canvas-design-chat-053-catalog.json").read_text(encoding="utf-8"))
MODEL_UUID = "05300000-0000-4000-8000-000000000003"


def before_state():
    tables = [{"name": name, "count": 3, "sha256": "a" * 64} for name in sorted(operator.CHANGED_TABLES | {"users", "tasks", "providers", "model_configs", "usage_rollup_state"})]
    return {"identity": {"database": "canvas", "systemIdentifier": "same"},
            "migrations": [{"name": operator.PREVIOUS, "applied_at": "old"}],
            "sequences": [{"sequencename": "audit_logs_id_seq", "last_value": 7}],
            "sequenceStates": [{"name": "audit_logs_id_seq", "lastValue": "7", "isCalled": True}],
            "tables": tables, **{field: [] for field in operator.SORT_KEYS},
            "columns": copy.deepcopy(CATALOG["seedColumns"]),
            "constraints": [copy.deepcopy(row["before"]) for row in CATALOG["replacements"]],
            "designChatSafety": copy.deepcopy(operator.SAFETY),
            "designChatOtherRows": [copy.deepcopy(row) for row in tables if row["name"] in operator.SEEDS],
            "designChatSeeds": {name: [] for name in operator.SEEDS},
            "designChatModel": [{"id": MODEL_UUID, "providerId": operator.PROVIDER_ID, "modelId": operator.MODEL_ID,
                "protocol": "apimart", "modelEnabled": True, "providerEnabled": True, "hasCredentials": True,
                "workflowConfigId": None, "capabilities": ["chat", "vision", "tools"]}]}


def after_state(before=None):
    before = before_state() if before is None else before
    value = copy.deepcopy(before)
    value.update(operator.expected_catalog(before, CATALOG))
    value["migrations"].append({"name": operator.MIGRATION, "applied_at": "new"})
    for row in value["tables"]:
        if row["name"] in operator.CHANGED_TABLES:
            row["count"] += 1
            row["sha256"] = "b" * 64
    value["designChatSeeds"] = {name: [{**seed["values"], **{key: "new" for key in seed["timestamps"]}}]
                                for name, seed in operator.bound_seeds(before).items()}
    return value


class CanvasDesignChat053Contracts(unittest.TestCase):
    def test_only_two_checks_two_exact_seeds_and_one_registration_change(self):
        before = before_state()
        operator.assert_delta(before, after_state(), CATALOG)
        mutations = [lambda v: v["identity"].update(database="other"),
                     lambda v: v["sequences"][0].update(last_value=8),
                     lambda v: v["sequenceStates"][0].update(isCalled=False),
                     lambda v: v["designChatOtherRows"][0].update(sha256="changed"),
                     lambda v: v["designChatModel"][0].update(hasCredentials=False),
                     lambda v: v["designChatSeeds"]["tool_api_configurations"][0].update(model_config_id=None),
                     lambda v: v["designChatSeeds"]["module_flags"][0].update(enabled=False),
                     lambda v: v["migrations"][0].update(applied_at="changed"),
                     lambda v: v["migrations"].pop(),
                     lambda v: v["tables"].append({"name": "unexpected", "count": 0, "sha256": "0" * 64}),
                     lambda v: v.update(unexpected=True)]
        for name in ["users", "tasks", "providers", "model_configs", "usage_rollup_state"]:
            mutations.append(lambda v, name=name: next(row for row in v["tables"] if row["name"] == name).update(sha256="changed"))
        for change in mutations:
            with self.subTest(change=change), self.assertRaises(Rejected):
                value = after_state(); change(value); operator.assert_delta(before, value, CATALOG)
        for field in operator.SORT_KEYS:
            with self.subTest(field=field), self.assertRaises(Rejected):
                value = after_state(); value[field].append({"unexpected": True}); operator.assert_delta(before, value, CATALOG)

    def test_carbon_binding_uses_actual_uuid_not_demo_and_requires_existing_usable_provider(self):
        before = before_state(); before["designChatModel"][0]["id"] = "ab1e58c0-bfb2-4ce6-b6e2-e215ee077d58"
        operator.assert_delta(before, after_state(before), CATALOG)
        self.assertEqual(operator.bound_seeds(before)["tool_api_configurations"]["values"]["model_config_id"], before["designChatModel"][0]["id"])
        for change in [lambda b: b.update(designChatModel=[]), lambda b: b["designChatModel"].append(b["designChatModel"][0])]:
            with self.assertRaises(Rejected):
                value = before_state(); change(value); operator.validate_before(value, CATALOG)
        for field, value in [("modelId", "other"), ("providerId", MODEL_UUID), ("protocol", "openai"), ("modelEnabled", False),
                             ("providerEnabled", False), ("hasCredentials", False), ("workflowConfigId", MODEL_UUID), ("capabilities", ["video"])]:
            with self.subTest(field=field), self.assertRaises(Rejected):
                before = before_state(); before["designChatModel"][0][field] = value; operator.validate_before(before, CATALOG)

    def test_partial_schema_existing_seed_and_unreviewed_hooks_are_rejected_without_overwriting(self):
        mutations = [lambda b: b["constraints"][0].update(definition="CHECK (true)"),
                     lambda b: b["designChatSeeds"]["tool_api_configurations"].append({"model_config_id": "admin-choice"}),
                     lambda b: b["designChatSafety"].update(seedTableTriggers=1),
                     lambda b: b["migrations"].append({"name": operator.MIGRATION, "applied_at": "old"})]
        for change in mutations:
            with self.assertRaises(Rejected):
                before = before_state(); change(before); operator.validate_before(before, CATALOG)
        for change in [lambda c: c["replacements"].pop(), lambda c: c["replacements"][0]["after"].update(name="wrong"),
                       lambda c: c["seeds"]["module_flags"]["values"].update(enabled=False)]:
            with self.assertRaises(Rejected):
                catalog = copy.deepcopy(CATALOG); change(catalog); operator.expected_catalog(before_state(), catalog)

    def test_replay_missing_previous_and_future_migrations_are_rejected(self):
        release = {"migrations": [{"name": operator.PREVIOUS}, {"name": operator.MIGRATION}]}
        operator.validate_source_migrations(before_state(), release, {"retainedMigrationNames": []})
        for names in [[], [operator.MIGRATION], [operator.PREVIOUS, operator.MIGRATION], [operator.PREVIOUS] * 2, ["unexpected.sql"]]:
            with self.assertRaises(Rejected):
                operator.validate_source_migrations({"migrations": [{"name": name} for name in names]}, release, {"retainedMigrationNames": []})
        with self.assertRaises(Rejected):
            operator.validate_source_migrations(before_state(), {"migrations": release["migrations"] + [{"name": "054_future.sql"}]}, {"retainedMigrationNames": []})

    def test_preflight_binds_all_runtime_bytes_instance_package_and_exact_15_minutes(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory); instance = package / "instance.json"; instance.write_text("{}", encoding="utf-8")
            for relative in ["release-manifest.json", operator.SQL_PATH, *operator.RUNTIME_PATHS]:
                path = package / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixed", encoding="utf-8")
            prior = {"kind": "canvas-design-chat-053-preflight", "createdAt": 1000, "instanceSha256": operator.sha_file(instance),
                     "manifestSha256": operator.sha_file(package / "release-manifest.json"), "payloadHashes": operator.payload_hashes(package), "package": str(package)}
            operator.validate_preflight(prior, package, instance, now=1900)
            for now in [999, 1900.001]:
                with self.assertRaises(Rejected): operator.validate_preflight(prior, package, instance, now=now)
            for field in ["kind", "instanceSha256", "manifestSha256", "payloadHashes", "package"]:
                with self.assertRaises(Rejected):
                    changed = copy.deepcopy(prior); changed[field] = "wrong"; operator.validate_preflight(changed, package, instance, now=1001)
            release = {"migrations": [{"name": operator.MIGRATION, "sha256": operator.digest_file(package / operator.SQL_PATH)}]}
            operator.read_migration_sql(package, release)
            (package / operator.SQL_PATH).write_text("tampered", encoding="utf-8")
            with self.assertRaises(Rejected): operator.read_migration_sql(package, release)
            with self.assertRaises(Rejected): operator.validate_preflight(prior, package, instance, now=1001)

    def test_transaction_is_fixed_and_preserves_normal_deploy_zero_migration_contract(self):
        sql = operator.migration_sql(before_state(), CATALOG, "-- fixed SQL")
        self.assertEqual(sql.count("COMMIT;"), 1)
        for token in ["LOCK TABLE", "053_STOPPED_BASELINE_DRIFT", "053_STATISTICS_MUST_REMAIN_DISABLED", "INSERT INTO schema_migrations",
                      "053_CATALOG_OR_ORIGINAL_ROWS_CHANGED", "053_EXACT_INDEPENDENT_BOUND_SEEDS_REQUIRED"]:
            self.assertLess(sql.index(token), sql.index("COMMIT;"))
        source = (HERE / "canvas-design-chat-053.py").read_text(encoding="utf-8")
        for token in [".migrate_048(", ".control_048(", ".start_app(", "UPDATE providers", "UPDATE model_configs", "UPDATE usage_rollup_state"]:
            self.assertNotIn(token, source)
        from contract import assert_migrations
        with self.assertRaisesRegex(Rejected, "ZERO_MIGRATION_BASELINE_MISMATCH"):
            assert_migrations([operator.PREVIOUS], {"migrations": [{"name": operator.PREVIOUS}, {"name": operator.MIGRATION}]}, {"retainedMigrationNames": []})


@unittest.skipUnless(os.environ.get("PGLITE_RUNTIME_PATH"), "requires explicit disposable PGlite runtime; no network PostgreSQL")
class CanvasDesignChat053IsolatedSql(unittest.TestCase):
    def execute(self, operations):
        result = subprocess.run(["node", str(HERE / "test_canvas_design_chat_053_sql.mjs")], input=json.dumps(operations),
                                text=True, encoding="utf-8", capture_output=True, timeout=90,
                                env=dict(os.environ, CANVAS_DESIGN_CHAT_053_TEST_PYTHON=sys.executable))
        self.assertEqual(result.returncode, 0, result.stderr)
        values = json.loads(result.stdout)
        for row in values:
            if "snapshotJson" in row: row["snapshot"] = json.loads(row.pop("snapshotJson"))
        return values

    def test_actual_catalog_and_exact_independent_carbon_commit_preserve_old_chat(self):
        result = subprocess.run(["node", str(HERE / "test_canvas_design_chat_053_sql.mjs"), "catalog"], text=True, encoding="utf-8", capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(json.loads(result.stdout), CATALOG)
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(rows[1]["ok"], rows[1]); operator.assert_delta(rows[0]["snapshot"], rows[2]["snapshot"], CATALOG)
        self.assertEqual(rows[2]["snapshot"]["designChatSeeds"]["tool_api_configurations"][0]["model_config_id"], MODEL_UUID)

    def test_old_business_configuration_provider_and_statistics_writes_roll_back_entire_transaction(self):
        injections = ["UPDATE tasks SET parameters='{}'", "UPDATE users SET credit_balance=99",
                      "UPDATE providers SET enabled=false", "UPDATE model_configs SET rmb_cost=99",
                      "UPDATE tool_api_configurations SET model_config_id=NULL,enabled=true WHERE tool_key='gpt-chat'",
                      "UPDATE tool_api_configurations SET rmb_cost_override=99 WHERE tool_key='canvas-chat'",
                      "UPDATE module_flags SET enabled=NOT enabled WHERE module_key='image'",
                      "UPDATE prompt_recipe_versions SET content='{}' WHERE id='design053-prior-version'",
                      "UPDATE usage_rollup_state SET processing_enabled=true", "UPDATE schema_migrations SET applied_at=now()"]
        for injected in injections:
            with self.subTest(injected=injected):
                rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(rows[1]["ok"], rows[1]); self.assertEqual(rows[0]["snapshot"], rows[2]["snapshot"])

    def test_seed_tampering_unrelated_schema_and_wrong_catalog_roll_back(self):
        injections = ["UPDATE module_flags SET enabled=false WHERE module_key='canvas-design-chat'",
                      "UPDATE tool_api_configurations SET model_config_id=NULL WHERE tool_key='canvas-design-chat'",
                      "UPDATE tool_api_configurations SET allow_raw_prompt=true WHERE tool_key='canvas-design-chat'",
                      "UPDATE tool_api_configurations SET credit_cost_override=3 WHERE tool_key='canvas-design-chat'",
                      "ALTER TABLE tasks ADD COLUMN unexpected text", "CREATE TABLE unrelated(id int)", "CREATE SEQUENCE unexpected_seq"]
        for injected in injections:
            with self.subTest(injected=injected):
                rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(rows[1]["ok"], rows[1]); self.assertEqual(rows[0]["snapshot"], rows[2]["snapshot"])
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "wrongCatalog": True}, {"kind": "snapshot"}])
        self.assertFalse(rows[1]["ok"], rows[1]); self.assertEqual(rows[0]["snapshot"], rows[2]["snapshot"])

    def test_missing_disabled_uncredentialed_model_and_unreviewed_hooks_reject_before_mutation(self):
        setups = ["DELETE FROM model_configs", "UPDATE model_configs SET enabled=false", "UPDATE providers SET enabled=false",
                  "UPDATE providers SET encrypted_credentials=NULL", "UPDATE model_configs SET capabilities=ARRAY['video']",
                  "UPDATE usage_rollup_state SET processing_enabled=true",
                  "CREATE FUNCTION design053_hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER design053_unreviewed BEFORE INSERT ON module_flags FOR EACH ROW EXECUTE FUNCTION design053_hook()"]
        for setup in setups:
            with self.subTest(setup=setup):
                rows = self.execute([{"sql": setup}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
                self.assertTrue(rows[0]["ok"], rows[0]); self.assertFalse(rows[2]["ok"], rows[2]); self.assertEqual(rows[1]["snapshot"], rows[3]["snapshot"])

    def test_drift_after_stopped_baseline_is_rejected_before_fixed_sql(self):
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "beforeSql": "UPDATE users SET display_name='Changed after baseline'"}, {"kind": "snapshot"}])
        self.assertFalse(rows[1]["ok"], rows[1]); self.assertIn("053_STOPPED_BASELINE_DRIFT", rows[1]["message"])
        self.assertEqual(rows[0]["snapshot"]["migrations"], rows[2]["snapshot"]["migrations"])
        self.assertEqual(rows[2]["snapshot"]["designChatSeeds"], {name: [] for name in operator.SEEDS})

    def test_completed_migration_cannot_replay_or_overwrite_later_admin_selection(self):
        rows = self.execute([{"kind": "migration"}, {"sql": "UPDATE tool_api_configurations SET model_config_id=NULL,configuration_version=2,updated_by='05300000-0000-4000-8000-000000000001' WHERE tool_key='canvas-design-chat'"},
                             {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(rows[0]["ok"], rows[0]); self.assertTrue(rows[1]["ok"], rows[1])
        self.assertFalse(rows[3]["ok"], rows[3]); self.assertEqual(rows[2]["snapshot"], rows[4]["snapshot"])


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--sql-builder":
        request = json.load(sys.stdin); catalog = copy.deepcopy(CATALOG)
        if request.get("wrongCatalog"): catalog["replacements"][0]["after"]["definition"] = "CHECK (false)"
        source = (ROOT / operator.SQL_PATH).read_text(encoding="utf-8")
        query = operator.migration_sql(json.loads(request["beforeJson"]), catalog, source + ";\n" + request.get("inject", "") + ";\n")
        sys.stdout.buffer.write(query.encode("utf-8"))
    else: unittest.main()
