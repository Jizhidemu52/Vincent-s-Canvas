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

    def test_pg17_exact_catalog_old_task_projection_and_disabled_unbound_seeds(self):
        before = self.snapshot(); result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = self.snapshot(); operator.assert_delta(before, after, CATALOG)
        self.assertEqual(before["layerStudioOriginalTasks"], after["layerStudioOriginalTasks"])
        self.assertNotEqual(next(row for row in before["tables"] if row["name"] == "tasks")["sha256"], next(row for row in after["tables"] if row["name"] == "tasks")["sha256"])
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state; SELECT count(*) FROM layer_studio_prices;", self.database).stdout.strip().splitlines(), ["f", "0"])

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
