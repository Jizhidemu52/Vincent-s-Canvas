import copy
import json
import os
import unittest
import uuid
import test_usage_048_docker as fixture
import test_image_conversations_054_055 as checks

operator, CATALOG = checks.operator, checks.CATALOG


@unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "requires explicit CI Docker opt-in; PostgreSQL 17 was not run")
class ImageConversations054055DockerPostgres17(unittest.TestCase):
    docker = classmethod(fixture.Usage048DockerPostgres17.docker.__func__)
    remove_owned_container = classmethod(fixture.Usage048DockerPostgres17.remove_owned_container.__func__)
    setUpClass = classmethod(fixture.Usage048DockerPostgres17.setUpClass.__func__)
    tearDownClass = classmethod(fixture.Usage048DockerPostgres17.tearDownClass.__func__)
    psql = classmethod(fixture.Usage048DockerPostgres17.psql.__func__)

    def setUp(self):
        self.database = "usage048_" + uuid.uuid4().hex
        self.psql('CREATE DATABASE "' + self.database + '";', "postgres")
        self.database_identity = self.read_database_identity()
        self.assertEqual(self.database_identity["name"], self.database)
        self.assertTrue(self.database_identity["owned"])
        self.addCleanup(self.remove_owned_database)
        bootstrap = ["CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());"]
        names = sorted(path.name for path in fixture.MIGRATIONS.glob("*.sql") if path.name < operator.MIGRATIONS[0])
        self.assertEqual(names[-1], operator.PREVIOUS)
        for name in names:
            self.assertRegex(name, r"^[0-9]{3}_[a-z0-9_]+\.sql$")
            bootstrap += ["BEGIN;", (fixture.MIGRATIONS / name).read_text(encoding="utf-8"), "INSERT INTO schema_migrations(name) VALUES('" + name + "');", "COMMIT;"]
        bootstrap += [(checks.HERE / name).read_text(encoding="utf-8") for name in ["canvas-design-chat-053-test-fixture.sql", "image-conversations-054-055-test-fixture.sql"]]
        self.psql("\n".join(bootstrap), self.database)

    def read_database_identity(self):
        self.assertRegex(self.database, r"^usage048_[0-9a-f]{32}$")
        return json.loads(self.psql("SELECT jsonb_build_object('oid',oid,'name',datname,'owner',datdba,'owned',datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user)) FROM pg_database WHERE datname='" + self.database + "';", "postgres").stdout)

    def remove_owned_database(self):
        self.assertEqual(self.read_database_identity(), self.database_identity, "Refusing to remove a changed fixture database")
        self.psql('DROP DATABASE "' + self.database + '";', "postgres")

    def snapshot(self):
        return json.loads(self.psql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; SET LOCAL row_security=off; " + operator.snapshot_query() + "; COMMIT;", self.database).stdout)

    def migrate(self, before, injection="", catalog=None):
        sources = [(fixture.ROOT / path).read_text(encoding="utf-8") for path in operator.SQL_PATHS]
        sources[-1] += "\n" + injection
        return self.psql(operator.migration_sql(before, CATALOG if catalog is None else catalog, sources), self.database, check=False)

    def test_pg17_exact_catalog_source_prices_five_empty_tables_and_one_native_number(self):
        before = self.snapshot(); result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = self.snapshot(); operator.assert_delta(before, after, CATALOG)
        self.assertEqual(after["mai27Target"][0]["rmb_cost"], "1.234567")
        self.assertEqual(after["mai27Target"][0]["credit_cost"], 17)
        self.assertEqual(after["mai27Target"][0]["concurrency_limit"], 11)
        self.assertFalse(after["mai27Target"][0]["enabled"])
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state;", self.database).stdout.strip(), "f")

    def test_pg17_old_business_prices_credentials_configuration_and_schema_tampering_roll_back_except_native_number(self):
        injections = ["UPDATE users SET credit_balance=99;", "UPDATE tasks SET parameters='{}';",
                      "UPDATE providers SET encrypted_credentials='changed';", "UPDATE model_configs SET rmb_cost=99 WHERE model_id='mai-image-2.6-flash';",
                      "UPDATE tool_api_configurations SET model_config_id=NULL WHERE tool_key='image';",
                      "UPDATE quick_image_configurations SET prompt='changed' WHERE action='remove-background';",
                      "UPDATE usage_rollup_state SET processing_enabled=true;", "UPDATE schema_migrations SET applied_at=now();",
                      "CREATE TABLE unrelated(id int);", "ALTER TABLE tasks ADD COLUMN unwanted text;", "CREATE SEQUENCE unexpected_seq;"]
        for injection in injections:
            with self.subTest(injection=injection):
                before = self.snapshot(); result = self.migrate(before, injection)
                self.assertNotEqual(result.returncode, 0); checks.assert_native_gap_only(self, before, self.snapshot())

    def test_pg17_target_price_enabled_concurrency_new_data_and_wrong_catalog_roll_back_except_native_number(self):
        injections = ["UPDATE model_configs SET rmb_cost=0 WHERE model_id='mai-image-2.7-flash';",
                      "UPDATE model_configs SET enabled=true WHERE model_id='mai-image-2.7-flash';",
                      "UPDATE model_configs SET concurrency_limit=1 WHERE model_id='mai-image-2.7-flash';",
                      "INSERT INTO image_conversations(id,owner_user_id,entrypoint,create_request_id,create_request_hash) VALUES(gen_random_uuid(),'05300000-0000-4000-8000-000000000001','standalone','unexpected',repeat('a',64));"]
        for injection in injections:
            with self.subTest(injection=injection):
                before = self.snapshot(); result = self.migrate(before, injection)
                self.assertNotEqual(result.returncode, 0); checks.assert_native_gap_only(self, before, self.snapshot())
        before = self.snapshot(); wrong = copy.deepcopy(CATALOG); wrong["additions"]["columns"][0]["column_default"] = "wrong-default"
        self.assertNotEqual(self.migrate(before, catalog=wrong).returncode, 0)
        checks.assert_native_gap_only(self, before, self.snapshot())

    def test_pg17_missing_source_raw_migration_is_noop_operator_rejects_and_prices_are_never_invented(self):
        self.psql("UPDATE model_configs SET model_id='not-configured' WHERE model_id='mai-image-2.6-flash';", self.database)
        before = self.snapshot()
        self.psql((fixture.ROOT / operator.SQL_PATHS[1]).read_text(encoding="utf-8"), self.database)
        self.assertEqual(self.snapshot(), before)
        with self.assertRaises(operator.Rejected): self.migrate(before)
        self.assertEqual(self.snapshot(), before)

    def test_pg17_completed_raw_migration_does_not_allocate_again_or_overwrite_administrator(self):
        self.assertEqual(self.migrate(self.snapshot()).returncode, 0)
        self.psql("UPDATE model_configs SET rmb_cost=2.765432,enabled=true,concurrency_limit=3 WHERE model_id='mai-image-2.7-flash';", self.database)
        before = self.snapshot()
        self.psql((fixture.ROOT / operator.SQL_PATHS[1]).read_text(encoding="utf-8"), self.database)
        self.assertEqual(self.snapshot(), before)
        with self.assertRaises(operator.Rejected): self.migrate(before)
        self.assertEqual(self.snapshot(), before)

    def test_pg17_unreviewed_insert_trigger_rejects_before_allocation(self):
        self.psql("CREATE FUNCTION extra_model_hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER extra_hook BEFORE INSERT ON model_configs FOR EACH ROW EXECUTE FUNCTION extra_model_hook();", self.database)
        before = self.snapshot()
        with self.assertRaises(operator.Rejected): self.migrate(before)
        self.assertEqual(self.snapshot(), before)

    def test_pg17_exhausted_public_number_rejects_without_touching_any_row(self):
        self.psql("SELECT setval('model_public_number_seq',2147483647,true);", self.database)
        before = self.snapshot()
        with self.assertRaises(operator.Rejected): self.migrate(before)
        self.assertEqual(self.snapshot(), before)

    def test_pg17_stopped_baseline_drift_prevents_ddl_or_sequence_allocation(self):
        before = self.snapshot()
        self.psql("UPDATE users SET display_name='Changed after stopped baseline';", self.database)
        drifted = self.snapshot(); result = self.migrate(before)
        self.assertNotEqual(result.returncode, 0); self.assertIn("054_055_STOPPED_BASELINE_DRIFT", result.stderr)
        self.assertEqual(self.snapshot(), drifted)


if __name__ == "__main__": unittest.main()
