"""Real PostgreSQL 17 catalog/rollback checks using the existing isolated fixture."""
import json
import os
import unittest
import uuid

import test_usage_048_docker as fixture
import test_quick_image_049 as checks

operator = checks.operator
CATALOG = checks.CATALOG


@unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "requires explicit CI Docker opt-in; PostgreSQL 17 was not run")
class QuickImage049DockerPostgres17(unittest.TestCase):
    # Reuse container ownership checks, no-network/tmpfs isolation, and cleanup.
    # Do not inherit the older migration's business tests or setup data.
    docker = classmethod(fixture.Usage048DockerPostgres17.docker.__func__)
    remove_owned_container = classmethod(fixture.Usage048DockerPostgres17.remove_owned_container.__func__)
    setUpClass = classmethod(fixture.Usage048DockerPostgres17.setUpClass.__func__)
    tearDownClass = classmethod(fixture.Usage048DockerPostgres17.tearDownClass.__func__)
    psql = classmethod(fixture.Usage048DockerPostgres17.psql.__func__)

    def setUp(self):
        self.database = "usage048_" + uuid.uuid4().hex
        self.psql('CREATE DATABASE "' + self.database + '";', "postgres")
        bootstrap = ["CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());"]
        names = sorted(path.name for path in fixture.MIGRATIONS.glob("*.sql"))
        self.assertEqual(names[-1], operator.MIGRATION)
        for name in names[:-1]:
            self.assertRegex(name, r"^[0-9]{3}_[a-z0-9_]+\.sql$")
            bootstrap += ["BEGIN;", (fixture.MIGRATIONS / name).read_text(encoding="utf-8"), "INSERT INTO schema_migrations(name) VALUES('" + name + "');", "COMMIT;"]
        bootstrap += ["INSERT INTO users(id,username,display_name,role,must_change_password,credit_balance) VALUES('04900000-0000-4000-8000-000000000001','quick049-fixture','Unchanged employee','super_admin',false,73);"]
        self.psql("\n".join(bootstrap), self.database)

    def snapshot(self):
        return json.loads(self.psql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; " + operator.support.snapshot_query() + "; COMMIT;", self.database).stdout)

    def migrate(self, before, injected=""):
        source = (fixture.ROOT / operator.SQL_PATH).read_text(encoding="utf-8")
        return self.psql(operator.migration_sql(before, CATALOG, source + "\n" + injected), self.database, check=False)

    def test_exact_pg17_catalog_empty_settings_and_original_business_hashes(self):
        before = self.snapshot()
        result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = self.snapshot()
        operator.assert_049_delta(before, after, CATALOG)
        self.assertEqual(self.psql("SELECT count(*) FROM quick_image_configurations;", self.database).stdout.strip(), "0")
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state;", self.database).stdout.strip(), "f")

    def test_injected_employee_write_rolls_back_schema_and_registration(self):
        before = self.snapshot()
        result = self.migrate(before, "UPDATE users SET display_name='Unauthorized mutation' WHERE username='quick049-fixture';")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("049_ORIGINAL_BUSINESS_ROWS_CHANGED", result.stderr)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__": unittest.main()
