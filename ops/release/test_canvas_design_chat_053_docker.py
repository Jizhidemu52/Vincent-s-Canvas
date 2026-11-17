import copy
import json
import os
import unittest
import uuid
import test_usage_048_docker as fixture
import test_canvas_design_chat_053 as checks

operator, CATALOG = checks.operator, checks.CATALOG


@unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "requires explicit CI Docker opt-in; PostgreSQL 17 was not run")
class CanvasDesignChat053DockerPostgres17(unittest.TestCase):
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
        bootstrap.append((checks.HERE / "canvas-design-chat-053-test-fixture.sql").read_text(encoding="utf-8"))
        self.psql("\n".join(bootstrap), self.database)

    def snapshot(self):
        return json.loads(self.psql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; SET LOCAL row_security=off; " + operator.snapshot_query() + "; COMMIT;", self.database).stdout)

    def migrate(self, before, injection="", catalog=None):
        source = (fixture.ROOT / operator.SQL_PATH).read_text(encoding="utf-8")
        return self.psql(operator.migration_sql(before, CATALOG if catalog is None else catalog, source + "\n" + injection), self.database, check=False)

    def test_pg17_exact_catalog_and_independent_carbon_binding_leave_all_old_rows_unchanged(self):
        before = self.snapshot(); result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = self.snapshot(); operator.assert_delta(before, after, CATALOG)
        self.assertEqual(after["designChatSeeds"]["tool_api_configurations"][0]["model_config_id"], checks.MODEL_UUID)
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state;", self.database).stdout.strip(), "f")

    def test_pg17_old_chat_provider_prices_business_and_schema_tampering_roll_back(self):
        injections = ["UPDATE users SET credit_balance=99;", "UPDATE tasks SET parameters='{}';",
                      "UPDATE providers SET encrypted_credentials='changed';", "UPDATE model_configs SET enabled=false;",
                      "UPDATE tool_api_configurations SET enabled=true WHERE tool_key IN ('gpt-chat','canvas-chat');",
                      "UPDATE tool_api_configurations SET rmb_cost_override=99 WHERE tool_key='image';",
                      "UPDATE usage_rollup_state SET processing_enabled=true;", "UPDATE schema_migrations SET applied_at=now();",
                      "CREATE TABLE unrelated(id int);", "ALTER TABLE tasks ADD COLUMN unwanted text;", "CREATE SEQUENCE unexpected_seq;"]
        for injection in injections:
            with self.subTest(injection=injection):
                before = self.snapshot(); result = self.migrate(before, injection)
                self.assertNotEqual(result.returncode, 0); self.assertEqual(self.snapshot(), before)

    def test_pg17_new_seed_binding_and_catalog_tampering_roll_back(self):
        injections = ["UPDATE module_flags SET enabled=false WHERE module_key='canvas-design-chat';",
                      "UPDATE tool_api_configurations SET model_config_id=NULL WHERE tool_key='canvas-design-chat';",
                      "UPDATE tool_api_configurations SET allow_raw_prompt=true WHERE tool_key='canvas-design-chat';",
                      "UPDATE tool_api_configurations SET credit_cost_override=7 WHERE tool_key='canvas-design-chat';"]
        for injection in injections:
            with self.subTest(injection=injection):
                before = self.snapshot(); result = self.migrate(before, injection)
                self.assertNotEqual(result.returncode, 0); self.assertEqual(self.snapshot(), before)
        before = self.snapshot(); wrong = copy.deepcopy(CATALOG); wrong["replacements"][0]["after"]["definition"] = "CHECK (false)"
        self.assertNotEqual(self.migrate(before, catalog=wrong).returncode, 0); self.assertEqual(self.snapshot(), before)

    def test_pg17_unavailable_dependency_is_rejected_and_replay_preserves_admin_clearing(self):
        self.psql("UPDATE providers SET encrypted_credentials=NULL;", self.database)
        before = self.snapshot()
        with self.assertRaises(operator.Rejected): self.migrate(before)
        self.assertEqual(self.snapshot(), before)
        self.psql("UPDATE providers SET encrypted_credentials='synthetic-not-a-key';", self.database)
        self.assertEqual(self.migrate(self.snapshot()).returncode, 0)
        self.psql("UPDATE tool_api_configurations SET model_config_id=NULL,configuration_version=2,updated_by='05300000-0000-4000-8000-000000000001' WHERE tool_key='canvas-design-chat';", self.database)
        after = self.snapshot()
        with self.assertRaises(operator.Rejected): self.migrate(after)
        self.assertEqual(self.snapshot(), after)

    def test_pg17_stopped_baseline_drift_prevents_any_migration(self):
        before = self.snapshot()
        self.psql("UPDATE users SET display_name='Changed after stopped baseline';", self.database)
        drifted = self.snapshot(); result = self.migrate(before)
        self.assertNotEqual(result.returncode, 0); self.assertIn("053_STOPPED_BASELINE_DRIFT", result.stderr)
        self.assertEqual(self.snapshot(), drifted)


if __name__ == "__main__": unittest.main()
