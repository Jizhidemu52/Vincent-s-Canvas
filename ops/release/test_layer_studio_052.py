"""052 contracts and disposable transaction tests; never a network database."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from contract import Rejected

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
spec = importlib.util.spec_from_file_location("layer_studio_052", HERE / "layer-studio-052.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
CATALOG = json.loads((HERE / "layer-studio-052-catalog.json").read_text(encoding="utf-8"))


def with_task_layout(value, physical_count=36, dropped=()):
    columns = [row for row in value["columns"] if row["table_name"] != "tasks"]
    attributes = []
    for position in range(1, physical_count + 1):
        name = {35: "user_input", 36: "prompt_compilation_id", 37: "prompt_optimized"}.get(position, f"prior_task_{position}")
        attributes.append({"attnum": position, "attname": name, "attisdropped": position in dropped})
        if position not in dropped:
            kind = {35: ("jsonb", "jsonb"), 37: ("boolean", "bool")}.get(position, ("text", "text"))
            columns.append({"table_name": "tasks", "column_name": name, "ordinal_position": position,
                            "data_type": kind[0], "udt_name": kind[1], "is_nullable": "YES", "column_default": None,
                            "numeric_precision": None, "numeric_scale": None})
    value["columns"] = sorted(columns, key=lambda row: (row["table_name"], row["ordinal_position"]))
    value["layerStudioTaskLayout"] = {"relnatts": physical_count, "attributes": attributes}
    return value


def before_state():
    tables = [{"name": name, "count": 3, "sha256": "a" * 64} for name in sorted(operator.CHANGED_TABLES | {"users", "providers", "model_configs", "usage_rollup_state"})]
    return with_task_layout({"identity": {"database": "canvas", "systemIdentifier": "same"},
            "migrations": [{"name": operator.PREVIOUS, "applied_at": "old"}],
            "sequences": [{"sequencename": "audit_logs_id_seq", "last_value": 7}],
            "sequenceStates": [{"name": "audit_logs_id_seq", "lastValue": "7", "isCalled": True}],
            "tables": tables, **{field: [] for field in operator.SORT_KEYS},
            "columns": copy.deepcopy(CATALOG["seedColumns"]),
            "constraints": [copy.deepcopy(row["before"]) for row in CATALOG["replacements"]],
            "layerStudioOriginalTasks": copy.deepcopy(next(row for row in tables if row["name"] == "tasks")),
            "layerStudioNonNullOutputs": 0, "layerStudioSafety": copy.deepcopy(operator.SAFETY),
            "layerStudioOtherRows": [copy.deepcopy(row) for row in tables if row["name"] in operator.SEEDS],
            "layerStudioSeeds": {name: [] for name in operator.SEEDS}})


def after_state(before=None):
    before = before_state() if before is None else before; value = copy.deepcopy(before)
    value.update(operator.expected_catalog(before, CATALOG))
    count = before["layerStudioTaskLayout"]["relnatts"]
    value["layerStudioTaskLayout"]["attributes"] += [
        {"attnum": count + 1, "attname": "result_document", "attisdropped": False},
        {"attnum": count + 2, "attname": "upstream_result_document", "attisdropped": False}]
    value["layerStudioTaskLayout"]["relnatts"] = count + 2
    value["migrations"].append({"name": operator.MIGRATION, "applied_at": "new"})
    for row in value["tables"]:
        if row["name"] in operator.CHANGED_TABLES:
            row["count"] += 0 if row["name"] == "tasks" else 1
            row["sha256"] = "b" * 64
    value["tables"].append({"name": operator.NEW_TABLE, "count": 0, "sha256": "e" * 64})
    value["layerStudioSeeds"] = {name: [{**seed["values"], **{key: "new" for key in seed["timestamps"]}}] for name, seed in operator.SEEDS.items()}
    return value


class LayerStudio052Contracts(unittest.TestCase):
    def test_existing_37th_task_column_is_preserved_and_outputs_append_at_38_39(self):
        before = with_task_layout(before_state(), 37); original = copy.deepcopy(before)
        catalog = copy.deepcopy(CATALOG)
        expected = operator.expected_catalog(before, catalog)
        old = [row for row in expected["columns"] if row["table_name"] == "tasks" and row["column_name"] not in operator.OUTPUT_COLUMNS]
        self.assertEqual(old, [row for row in before["columns"] if row["table_name"] == "tasks"])
        self.assertEqual([(row["column_name"], row["ordinal_position"]) for row in expected["columns"] if row["table_name"] == "tasks" and row["column_name"] in operator.OUTPUT_COLUMNS],
                         [("result_document", 38), ("upstream_result_document", 39)])
        self.assertEqual(before, original); self.assertEqual(catalog, CATALOG)

    def test_dropped_tail_slot_is_not_reused_for_new_outputs(self):
        before = with_task_layout(before_state(), 38, dropped=(38,))
        self.assertEqual(max(row["ordinal_position"] for row in before["columns"] if row["table_name"] == "tasks"), 37)
        expected = operator.expected_catalog(before, CATALOG)
        self.assertEqual([(row["column_name"], row["ordinal_position"]) for row in expected["columns"] if row["table_name"] == "tasks" and row["column_name"] in operator.OUTPUT_COLUMNS],
                         [("result_document", 39), ("upstream_result_document", 40)])

    def test_incomplete_or_visible_inconsistent_physical_layout_is_rejected(self):
        mutations = [lambda b: b.pop("layerStudioTaskLayout"),
                     lambda b: b["layerStudioTaskLayout"].update(relnatts=37),
                     lambda b: b["layerStudioTaskLayout"].update(relnatts=True),
                     lambda b: b["layerStudioTaskLayout"]["attributes"].pop(),
                     lambda b: b["layerStudioTaskLayout"]["attributes"][-1].update(attnum=35),
                     lambda b: b["layerStudioTaskLayout"]["attributes"][-1].update(attname="wrong"),
                     lambda b: b["layerStudioTaskLayout"]["attributes"][-1].update(attisdropped=True),
                     lambda b: b["layerStudioTaskLayout"]["attributes"][-1].update(attisdropped=0),
                     lambda b: b["layerStudioTaskLayout"]["attributes"].reverse()]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaisesRegex(Rejected, "052_TASK_PHYSICAL"):
                before = before_state(); mutation(before); operator.expected_catalog(before, CATALOG)

    def test_append_delta_preserves_dropped_slots_and_every_existing_column_field(self):
        before = with_task_layout(before_state(), 38, dropped=(4, 38))
        operator.assert_delta(before, after_state(before), CATALOG)
        mutations = [lambda a: a["layerStudioTaskLayout"]["attributes"][3].update(attname="changed dropped slot"),
                     lambda a: a["layerStudioTaskLayout"].update(relnatts=41),
                     lambda a: a["layerStudioTaskLayout"]["attributes"][-1].update(attnum=38),
                     lambda a: a["layerStudioTaskLayout"]["attributes"][-1].update(attisdropped=True),
                     lambda a: next(row for row in a["columns"] if row["table_name"] == "tasks" and row["column_name"] == "prompt_optimized").update(column_default="true"),
                     lambda a: a["columns"].append(copy.deepcopy(a["columns"][-1]))]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(Rejected):
                after = after_state(before); mutation(after); operator.assert_delta(before, after, CATALOG)

    def test_unrelated_catalog_identity_collisions_are_still_rejected(self):
        for field, row in [("indexes", CATALOG["additions"]["indexes"][0]),
                           ("constraints", CATALOG["additions"]["constraints"][0])]:
            with self.subTest(field=field), self.assertRaisesRegex(Rejected, "048_OBJECT_ALREADY_PRESENT"):
                before = before_state(); before[field].append(copy.deepcopy(row)); operator.expected_catalog(before, CATALOG)

    def test_only_fixed_catalog_disabled_seeds_empty_prices_and_null_outputs_change(self):
        operator.assert_delta(before_state(), after_state(), CATALOG)
        mutations = [lambda s: s["identity"].update(database="other"), lambda s: s["sequences"][0].update(last_value=8),
                     lambda s: s["sequenceStates"][0].update(isCalled=False), lambda s: s["layerStudioOtherRows"][0].update(sha256="changed"),
                     lambda s: s["layerStudioOriginalTasks"].update(sha256="changed"), lambda s: s.update(layerStudioNonNullOutputs=1),
                     lambda s: s["layerStudioSeeds"]["module_flags"][0].update(enabled=True),
                     lambda s: s["layerStudioSeeds"]["tool_api_configurations"][0].update(model_config_id="bound"),
                     lambda s: s["layerStudioSeeds"]["tool_api_configurations"][0].update(allow_raw_prompt=True),
                     lambda s: s["layerStudioSeeds"]["tool_api_configurations"][0].update(updated_at="other"),
                     lambda s: s["migrations"][0].update(applied_at="changed"),
                     lambda s: next(row for row in s["tables"] if row["name"] == "providers").update(sha256="changed"),
                     lambda s: next(row for row in s["tables"] if row["name"] == operator.NEW_TABLE).update(count=1),
                     lambda s: s["tables"].append({"name": "extra", "count": 0, "sha256": "x"}), lambda s: s.update(extra=True)]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(Rejected):
                after = after_state(); mutation(after); operator.assert_delta(before_state(), after, CATALOG)
        for field in operator.SORT_KEYS:
            with self.subTest(field=field), self.assertRaises(Rejected):
                after = after_state(); after[field].append({"unexpected": True}); operator.assert_delta(before_state(), after, CATALOG)

    def test_task_full_row_hash_changes_but_old_projection_is_required_and_cannot_be_skipped(self):
        before, after = before_state(), after_state()
        self.assertNotEqual(next(row for row in before["tables"] if row["name"] == "tasks")["sha256"], next(row for row in after["tables"] if row["name"] == "tasks")["sha256"])
        operator.assert_delta(before, after, CATALOG)
        after["layerStudioOriginalTasks"]["count"] += 1
        with self.assertRaises(Rejected): operator.assert_delta(before, after, CATALOG)
        before["layerStudioOriginalTasks"]["sha256"] = "incomplete"
        with self.assertRaisesRegex(Rejected, "TASK_PROJECTION_INCOMPLETE"): operator.validate_before(before, CATALOG)

    def test_no_preexisting_052_objects_seeds_or_unreviewed_hooks(self):
        mutations = [lambda b: b["tables"].append({"name": operator.NEW_TABLE, "count": 0, "sha256": "x"}),
                     lambda b: b["columns"].append(copy.deepcopy(CATALOG["additions"]["columns"][-1])),
                     lambda b: b["layerStudioSeeds"]["module_flags"].append({"enabled": False}),
                     lambda b: b["layerStudioSafety"].update(enabledEventTriggers=1),
                     lambda b: b["layerStudioSafety"].update(seedTableTriggers=1),
                     lambda b: b["columns"][1].update(column_default="nextval('unreviewed')")]
        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(Rejected):
                before = before_state(); mutation(before); operator.validate_before(before, CATALOG)

    def test_exact_previous_051_registration_and_fixed_release_tail_are_required(self):
        release = {"migrations": [{"name": operator.PREVIOUS}, {"name": operator.MIGRATION}]}
        operator.validate_source_migrations(before_state(), release, {"retainedMigrationNames": []})
        for names in [[], [operator.MIGRATION], [operator.PREVIOUS, operator.MIGRATION], [operator.PREVIOUS, operator.PREVIOUS], [operator.PREVIOUS, "future.sql"]]:
            with self.subTest(names=names), self.assertRaises(Rejected):
                operator.validate_source_migrations({"migrations": [{"name": name} for name in names]}, release, {"retainedMigrationNames": []})
        with self.assertRaises(Rejected): operator.validate_source_migrations(before_state(), {"migrations": release["migrations"] + [{"name": "053_future.sql"}]}, {"retainedMigrationNames": []})

    def test_catalog_cannot_omit_checks_change_seed_meaning_or_add_unsafe_columns(self):
        for mutation in [lambda c: c["replacements"].pop(), lambda c: c["replacements"][0]["before"].update(name="other"),
                         lambda c: c["seeds"]["module_flags"]["values"].update(enabled=True),
                         lambda c: c["additions"]["columns"][-1].update(column_default="'{}'::jsonb")]:
            with self.subTest(mutation=mutation), self.assertRaises(Rejected):
                catalog = copy.deepcopy(CATALOG); mutation(catalog); operator.expected_catalog(before_state(), catalog)

    def test_preflight_binds_all_runtime_files_sql_catalog_instance_and_15_minutes(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory); instance = package / "instance.json"; instance.write_text("{}", encoding="utf-8")
            (package / "release-manifest.json").write_text("{}", encoding="utf-8")
            for relative in [operator.SQL_PATH, *operator.RUNTIME_PATHS]:
                path = package / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixed", encoding="utf-8")
            prior = {"kind": "layer-studio-052-preflight", "createdAt": 1000, "instanceSha256": operator.sha_file(instance),
                     "manifestSha256": operator.sha_file(package / "release-manifest.json"), "payloadHashes": operator.payload_hashes(package), "package": str(package)}
            operator.validate_preflight(prior, package, instance, now=1900)
            for now in [999, 1900.001]:
                with self.assertRaisesRegex(Rejected, "FRESH_PREFLIGHT_REQUIRED"): operator.validate_preflight(prior, package, instance, now=now)
            for field in ["kind", "instanceSha256", "manifestSha256", "payloadHashes", "package"]:
                with self.subTest(field=field), self.assertRaises(Rejected):
                    changed = copy.deepcopy(prior); changed[field] = "changed"; operator.validate_preflight(changed, package, instance, now=1001)
            for relative in [operator.SQL_PATH, operator.CATALOG_PATH, operator.STATE_PATH, "ops/release/activity.sql"]:
                path = package / relative; path.write_text("changed", encoding="utf-8")
                with self.assertRaisesRegex(Rejected, "TARGET_CHANGED"): operator.validate_preflight(prior, package, instance, now=1001)
                path.write_text("fixed", encoding="utf-8")

    def test_sql_is_read_and_rehashed_in_memory_immediately_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory); path = package / operator.SQL_PATH; path.parent.mkdir(parents=True)
            path.write_text("-- fixed", encoding="utf-8"); release = {"migrations": [{"name": operator.MIGRATION, "sha256": operator.digest_file(path)}]}
            self.assertEqual(operator.read_migration_sql(package, release), "-- fixed")
            path.write_text("ALTER TABLE users ADD COLUMN unknown text", encoding="utf-8")
            with self.assertRaisesRegex(Rejected, "SQL_CHANGED_BEFORE_EXECUTION"): operator.read_migration_sql(package, release)

    def test_running_tool_and_sql_are_bound_to_verified_package_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            for relative in operator.RUNTIME_PATHS:
                path = package / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes((HERE / Path(relative).name).read_bytes())
            sql = package / operator.SQL_PATH; sql.parent.mkdir(parents=True); sql.write_bytes((ROOT / operator.SQL_PATH).read_bytes())
            release = {"migrations": [{"name": operator.PREVIOUS}, {"name": operator.MIGRATION, "sha256": operator.digest_file(sql)}]}
            with patch.object(operator, "verify_package", return_value=release):
                operator.verify_052_package(package)
                (package / operator.CATALOG_PATH).write_text("{}", encoding="utf-8")
                with self.assertRaisesRegex(Rejected, "RUNNING_TOOL_DIFFERS"): operator.verify_052_package(package)

    def test_one_transaction_locks_all_old_tables_and_guards_every_delta_before_commit(self):
        sql = operator.migration_sql(before_state(), CATALOG, "-- reviewed fixed 052")
        self.assertEqual(sql.count("COMMIT;"), 1)
        for token in ["LOCK TABLE", "052_STOPPED_BASELINE_DRIFT", "052_STATISTICS_MUST_REMAIN_DISABLED", "INSERT INTO schema_migrations", "052_CATALOG_OR_ORIGINAL_ROWS_CHANGED", "052_EXACT_DISABLED_UNBOUND_SEEDS_REQUIRED", "052_OUTPUTS_OR_PRICES_NOT_EMPTY"]:
            self.assertLess(sql.index(token), sql.index("COMMIT;"))
        self.assertIn("SET LOCAL row_security=off", sql)
        source = (HERE / "layer-studio-052.py").read_text(encoding="utf-8")
        for forbidden in [".migrate_048(", ".control_048(", ".start_app(", "UPDATE usage_rollup_state", "pg_restore\", \"-d"]: self.assertNotIn(forbidden, source)
        for required in ['choices=["preflight", "migrate"]', '"automaticRetry": False', '"automaticRestore": False']: self.assertIn(required, source)


@unittest.skipUnless(os.environ.get("PGLITE_RUNTIME_PATH"), "requires explicit disposable PGlite runtime; no network PostgreSQL")
class LayerStudio052IsolatedSql(unittest.TestCase):
    def execute(self, operations):
        result = subprocess.run(["node", str(HERE / "test_layer_studio_052_sql.mjs")], input=json.dumps(operations), text=True, encoding="utf-8", capture_output=True, timeout=90,
                                env=dict(os.environ, LAYER_STUDIO_052_TEST_PYTHON=sys.executable))
        self.assertEqual(result.returncode, 0, result.stderr)
        values = json.loads(result.stdout)
        for row in values:
            if "snapshotJson" in row: row["snapshot"] = json.loads(row.pop("snapshotJson"))
        return values

    def test_actual_catalog_commits_only_null_output_columns_empty_prices_and_disabled_seeds(self):
        result = subprocess.run(["node", str(HERE / "test_layer_studio_052_sql.mjs"), "catalog"], text=True, encoding="utf-8", capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(json.loads(result.stdout), CATALOG)
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(rows[1]["ok"], rows[1]); before, after = rows[0]["snapshot"], rows[2]["snapshot"]
        operator.assert_delta(before, after, CATALOG)
        self.assertGreater(before["layerStudioOriginalTasks"]["count"], 0)
        self.assertNotEqual(next(row for row in before["tables"] if row["name"] == "tasks")["sha256"], next(row for row in after["tables"] if row["name"] == "tasks")["sha256"])
        self.assertEqual(before["layerStudioOriginalTasks"], after["layerStudioOriginalTasks"])

    def test_existing_37_columns_and_dropped_tail_append_at_physical_high_water(self):
        for suffix, positions in [("", [38, 39]), ("ALTER TABLE tasks ADD COLUMN discarded_tail text; ALTER TABLE tasks DROP COLUMN discarded_tail;", [39, 40])]:
            with self.subTest(positions=positions):
                rows = self.execute([{"sql": "ALTER TABLE tasks ADD COLUMN historical_task_field text;" + suffix},
                                     {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
                self.assertTrue(rows[0]["ok"], rows[0]); self.assertTrue(rows[2]["ok"], rows[2])
                before, after = rows[1]["snapshot"], rows[3]["snapshot"]
                operator.assert_delta(before, after, CATALOG)
                self.assertEqual([row["ordinal_position"] for row in after["columns"] if row["table_name"] == "tasks" and row["column_name"] in operator.OUTPUT_COLUMNS], positions)
                self.assertEqual([row for row in after["columns"] if row["table_name"] == "tasks" and row["column_name"] not in operator.OUTPUT_COLUMNS],
                                 [row for row in before["columns"] if row["table_name"] == "tasks"])
                self.assertEqual(before["layerStudioTaskLayout"]["attributes"], after["layerStudioTaskLayout"]["attributes"][:-2])

    def test_physical_only_drift_before_sql_is_rejected_and_in_transaction_rolls_back(self):
        drift = "ALTER TABLE tasks ADD COLUMN physical_only_drift text; ALTER TABLE tasks DROP COLUMN physical_only_drift;"
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "beforeSql": drift}, {"kind": "snapshot"}])
        self.assertFalse(rows[1]["ok"], rows[1]); self.assertIn("052_STOPPED_BASELINE_DRIFT", rows[1]["message"])
        before, after = rows[0]["snapshot"], rows[2]["snapshot"]
        self.assertEqual(before["columns"], after["columns"])
        self.assertEqual(before["migrations"], after["migrations"])
        self.assertEqual(after["layerStudioTaskLayout"]["relnatts"], before["layerStudioTaskLayout"]["relnatts"] + 1)
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": drift}, {"kind": "snapshot"}])
        self.assertFalse(rows[1]["ok"], rows[1]); self.assertIn("052_CATALOG_OR_ORIGINAL_ROWS_CHANGED", rows[1]["message"])
        self.assertEqual(rows[0]["snapshot"], rows[2]["snapshot"])

    def test_old_task_rows_config_prices_provider_and_business_changes_roll_back_entire_052(self):
        injections = ["UPDATE tasks SET parameters='{\"prompt\":\"changed\"}'", "UPDATE users SET display_name='Changed'",
                      "UPDATE providers SET base_url='https://other.invalid'", "UPDATE model_configs SET enabled=false",
                      "UPDATE tool_api_configurations SET rmb_cost_override=99 WHERE tool_key='image'",
                      "UPDATE module_flags SET enabled=NOT enabled WHERE module_key='image'", "UPDATE prompt_recipe_versions SET content='{}' WHERE id='layer052-prior-version'",
                      "UPDATE usage_rollup_state SET processing_enabled=true", "UPDATE schema_migrations SET applied_at=now()"]
        for injected in injections:
            with self.subTest(injected=injected):
                rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(rows[1]["ok"], rows[1]); self.assertEqual(rows[0]["snapshot"], rows[2]["snapshot"])

    def test_new_result_values_prices_seed_binding_and_wrong_catalog_roll_back(self):
        injections = ["UPDATE tasks SET result_document='{}'", "UPDATE tasks SET upstream_result_document='{}'",
                      "INSERT INTO layer_studio_prices(model_config_id,input_rmb,low_output_rmb,high_output_rmb,source_note) VALUES('05200000-0000-4000-8000-000000000003',0,1,2,'injected')",
                      "UPDATE module_flags SET enabled=true WHERE module_key='layer-studio'",
                      "UPDATE tool_api_configurations SET model_config_id='05200000-0000-4000-8000-000000000003' WHERE tool_key='layer-studio'",
                      "UPDATE tool_api_configurations SET allow_raw_prompt=true WHERE tool_key='layer-studio'",
                      "ALTER TABLE tasks ALTER COLUMN result_document SET DEFAULT '{}'::jsonb", "CREATE TABLE unrelated(id int)", "CREATE SEQUENCE unexpected_seq"]
        for injected in injections:
            with self.subTest(injected=injected):
                rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(rows[1]["ok"], rows[1]); self.assertEqual(rows[0]["snapshot"], rows[2]["snapshot"])
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "wrongCatalog": True}, {"kind": "snapshot"}])
        self.assertFalse(rows[1]["ok"], rows[1]); self.assertEqual(rows[0]["snapshot"], rows[2]["snapshot"])

    def test_partial_state_processing_enabled_or_custom_insert_hook_rejects_before_mutation(self):
        setups = ["CREATE TABLE layer_studio_prices(id int)", "ALTER TABLE tasks ADD COLUMN result_document jsonb",
                  "UPDATE usage_rollup_state SET processing_enabled=true",
                  "CREATE FUNCTION layer052_hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER layer052_unreviewed BEFORE INSERT ON module_flags FOR EACH ROW EXECUTE FUNCTION layer052_hook()"]
        for setup in setups:
            with self.subTest(setup=setup):
                rows = self.execute([{"sql": setup}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
                self.assertTrue(rows[0]["ok"], rows[0]); self.assertFalse(rows[2]["ok"], rows[2]); self.assertEqual(rows[1]["snapshot"], rows[3]["snapshot"])

    def test_success_is_not_replayed_and_committed_data_remains_intact(self):
        rows = self.execute([{"kind": "migration"}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(rows[0]["ok"], rows[0]); self.assertFalse(rows[2]["ok"], rows[2]); self.assertEqual(rows[1]["snapshot"], rows[3]["snapshot"])


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--sql-builder":
        request = json.load(sys.stdin); catalog = copy.deepcopy(CATALOG)
        if request.get("wrongCatalog"): catalog["additions"]["columns"][1]["numeric_precision"] = 13
        source = (ROOT / operator.SQL_PATH).read_text(encoding="utf-8")
        query = operator.migration_sql(json.loads(request["beforeJson"]), catalog, source + ";\n" + request.get("inject", "") + ";\n")
        sys.stdout.buffer.write(query.encode("utf-8"))
    else: unittest.main()
