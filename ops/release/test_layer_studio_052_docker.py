"""Explicit CI PostgreSQL 17, owned networkless tmpfs fixture; never production."""
import copy
import json
import os
import unittest
import uuid
import test_usage_048_docker as fixture
import test_layer_studio_052 as checks

operator, CATALOG = checks.operator, checks.CATALOG


@unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "requires explicit CI Docker opt-in; PostgreSQL 17 was not run")
class LayerStudio052DockerPostgres17(unittest.TestCase):
    docker = classmethod(fixture.Usage048DockerPostgres17.docker.__func__)
    remove_owned_container = classmethod(fixture.Usage048DockerPostgres17.remove_owned_container.__func__)
    setUpClass = classmethod(fixture.Usage048DockerPostgres17.setUpClass.__func__)
    tearDownClass = classmethod(fixture.Usage048DockerPostgres17.tearDownClass.__func__)
    psql = classmethod(fixture.Usage048DockerPostgres17.psql.__func__)

    def setUp(self):
        self.database = "usage048_" + uuid.uuid4().hex
        self.psql('CREATE DATABASE "' + self.database + '";', "postgres")
        bootstrap = ["CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());"]
        names = sorted(path.name for path in fixture.MIGRATIONS.glob("*.sql") if path.name < operator.MIGRATION)
        self.assertEqual(names[-1], operator.PREVIOUS)
        for name in names:
            self.assertRegex(name, r"^[0-9]{3}_[a-z0-9_]+\.sql$")
            bootstrap += ["BEGIN;", (fixture.MIGRATIONS / name).read_text(encoding="utf-8"), "INSERT INTO schema_migrations(name) VALUES('" + name + "');", "COMMIT;"]
        bootstrap.append((checks.HERE / "layer-studio-052-test-fixture.sql").read_text(encoding="utf-8"))
        self.psql("\n".join(bootstrap), self.database)

    def snapshot(self):
        return json.loads(self.psql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; SET LOCAL row_security=off; " + operator.snapshot_query() + "; COMMIT;", self.database).stdout)

    def migrate(self, before, injection="", catalog=None):
        source = (fixture.ROOT / operator.SQL_PATH).read_text(encoding="utf-8")
        return self.psql(operator.migration_sql(before, CATALOG if catalog is None else catalog, source + "\n" + injection), self.database, check=False)

    def assert_task_outputs_appended(self, before, after, previous_relnatts):
        operator.assert_delta(before, after, CATALOG)
        old_column_ids = {(row["table_name"], row["ordinal_position"]) for row in before["columns"]}
        self.assertEqual([row for row in after["columns"] if (row["table_name"], row["ordinal_position"]) in old_column_ids], before["columns"])
        old_task_columns = [row for row in before["columns"] if row["table_name"] == "tasks"]
        new_task_columns = [row for row in after["columns"] if row["table_name"] == "tasks"]
        self.assertEqual(new_task_columns[:-2], old_task_columns)
        self.assertEqual([(row["column_name"], row["ordinal_position"]) for row in new_task_columns[-2:]],
                         [("result_document", previous_relnatts + 1), ("upstream_result_document", previous_relnatts + 2)])
        self.assertEqual(before["layerStudioTaskLayout"]["relnatts"], previous_relnatts)
        self.assertEqual(after["layerStudioTaskLayout"], {
            "relnatts": previous_relnatts + 2,
            "attributes": before["layerStudioTaskLayout"]["attributes"] + [
                {"attnum": previous_relnatts + 1, "attname": "result_document", "attisdropped": False},
                {"attnum": previous_relnatts + 2, "attname": "upstream_result_document", "attisdropped": False},
            ],
        })
        self.assertEqual(before["layerStudioOriginalTasks"], after["layerStudioOriginalTasks"])

    def test_pg17_exact_catalog_old_task_projection_and_disabled_unbound_seeds(self):
        before = self.snapshot(); result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = self.snapshot(); operator.assert_delta(before, after, CATALOG)
        self.assertEqual(before["layerStudioOriginalTasks"], after["layerStudioOriginalTasks"])
        self.assertNotEqual(next(row for row in before["tables"] if row["name"] == "tasks")["sha256"], next(row for row in after["tables"] if row["name"] == "tasks")["sha256"])
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state; SELECT count(*) FROM layer_studio_prices;", self.database).stdout.strip().splitlines(), ["f", "0"])

    def test_pg17_historical_task_column_is_preserved_and_outputs_append_at_38_39(self):
        clean = self.snapshot()
        self.assertEqual(len([row for row in clean["columns"] if row["table_name"] == "tasks"]), 36)
        self.assertEqual(clean["layerStudioTaskLayout"]["relnatts"], 36)
        self.psql("ALTER TABLE tasks ADD COLUMN layer052_historical_note text; UPDATE tasks SET layer052_historical_note='Original historical value';", self.database)
        before = self.snapshot()
        self.assertEqual(before["layerStudioTaskLayout"]["attributes"][-1],
                         {"attnum": 37, "attname": "layer052_historical_note", "attisdropped": False})
        result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_task_outputs_appended(before, self.snapshot(), 37)

    def test_pg17_dropped_tail_slot_is_retained_and_outputs_append_after_relnatts(self):
        self.psql("ALTER TABLE tasks ADD COLUMN layer052_historical_note text; UPDATE tasks SET layer052_historical_note='Original historical value'; "
                  "ALTER TABLE tasks ADD COLUMN layer052_dropped_tail text; ALTER TABLE tasks DROP COLUMN layer052_dropped_tail;", self.database)
        before = self.snapshot()
        task_columns = [row for row in before["columns"] if row["table_name"] == "tasks"]
        self.assertEqual(len(task_columns), 37)
        self.assertEqual(max(row["ordinal_position"] for row in task_columns), 37)
        layout = before["layerStudioTaskLayout"]
        self.assertEqual(layout["relnatts"], 38)
        self.assertEqual([row["attnum"] for row in layout["attributes"]], list(range(1, 39)))
        self.assertTrue(layout["attributes"][-1]["attisdropped"])
        result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assert_task_outputs_appended(before, self.snapshot(), 38)

    def test_pg17_add_drop_tail_after_baseline_is_detected_before_migration(self):
        before = self.snapshot()
        self.psql("ALTER TABLE tasks ADD COLUMN layer052_late_tail text; ALTER TABLE tasks DROP COLUMN layer052_late_tail;", self.database)
        drifted = self.snapshot()
        self.assertEqual(drifted["columns"], before["columns"])
        self.assertEqual({key: value for key, value in drifted.items() if key != "layerStudioTaskLayout"},
                         {key: value for key, value in before.items() if key != "layerStudioTaskLayout"})
        self.assertEqual(drifted["layerStudioTaskLayout"]["relnatts"], before["layerStudioTaskLayout"]["relnatts"] + 1)
        self.assertEqual(drifted["layerStudioTaskLayout"]["attributes"][:-1], before["layerStudioTaskLayout"]["attributes"])
        self.assertTrue(drifted["layerStudioTaskLayout"]["attributes"][-1]["attisdropped"])
        result = self.migrate(before)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("052_STOPPED_BASELINE_DRIFT", result.stderr)
        self.assertEqual(self.snapshot(), drifted)

    def test_pg17_add_drop_tail_inside_migration_rolls_back_whole_transaction(self):
        before = self.snapshot()
        result = self.migrate(before, "ALTER TABLE tasks ADD COLUMN layer052_injected_tail text; ALTER TABLE tasks DROP COLUMN layer052_injected_tail;")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)

    def test_pg17_old_task_and_config_changes_roll_back_whole_migration(self):
        for injection in ["UPDATE tasks SET parameters='{\"prompt\":\"changed\"}';", "UPDATE tool_api_configurations SET rmb_cost_override=99 WHERE tool_key='image';", "UPDATE providers SET enabled=false;"]:
            with self.subTest(injection=injection):
                before = self.snapshot(); result = self.migrate(before, injection)
                self.assertNotEqual(result.returncode, 0); self.assertEqual(self.snapshot(), before)

    def test_pg17_seed_output_and_price_writes_roll_back_whole_migration(self):
        for injection in ["UPDATE tasks SET result_document='{}';", "UPDATE module_flags SET enabled=true WHERE module_key='layer-studio';",
                          "UPDATE tool_api_configurations SET model_config_id='05200000-0000-4000-8000-000000000003' WHERE tool_key='layer-studio';",
                          "INSERT INTO layer_studio_prices(model_config_id,input_rmb,low_output_rmb,high_output_rmb,source_note) VALUES('05200000-0000-4000-8000-000000000003',0,1,2,'injected');"]:
            with self.subTest(injection=injection):
                before = self.snapshot(); result = self.migrate(before, injection)
                self.assertNotEqual(result.returncode, 0); self.assertEqual(self.snapshot(), before)

    def test_pg17_wrong_catalog_rolls_back_and_success_is_not_replayed(self):
        before = self.snapshot(); wrong = copy.deepcopy(CATALOG)
        wrong["additions"]["columns"][1]["numeric_precision"] = 13
        self.assertNotEqual(self.migrate(before, catalog=wrong).returncode, 0); self.assertEqual(self.snapshot(), before)
        result = self.migrate(before); self.assertEqual(result.returncode, 0, result.stderr)
        after = self.snapshot()
        with self.assertRaises(operator.Rejected): self.migrate(after)
        self.assertEqual(self.snapshot(), after)


if __name__ == "__main__": unittest.main()
