"""PG17 opt-in: same owned networkless tmpfs fixture, never production."""
import json
import os
import unittest
import uuid

import test_usage_048_docker as fixture
import test_creative_050_051 as checks

operator, CATALOG = checks.operator, checks.CATALOG


@unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "requires explicit CI Docker opt-in; PostgreSQL 17 was not run")
class Creative050051DockerPostgres17(unittest.TestCase):
    docker = classmethod(fixture.Usage048DockerPostgres17.docker.__func__)
    remove_owned_container = classmethod(fixture.Usage048DockerPostgres17.remove_owned_container.__func__)
    setUpClass = classmethod(fixture.Usage048DockerPostgres17.setUpClass.__func__)
    tearDownClass = classmethod(fixture.Usage048DockerPostgres17.tearDownClass.__func__)
    psql = classmethod(fixture.Usage048DockerPostgres17.psql.__func__)

    def setUp(self):
        self.database = "usage048_" + uuid.uuid4().hex
        self.psql('CREATE DATABASE "' + self.database + '";', "postgres")
        bootstrap = ["CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());"]
        names = sorted(path.name for path in fixture.MIGRATIONS.glob("*.sql") if path.name < operator.MIGRATIONS[0])
        self.assertEqual(names[-1], "049_quick_image_configurations.sql")
        for name in names:
            self.assertRegex(name, r"^[0-9]{3}_[a-z0-9_]+\.sql$")
            bootstrap += ["BEGIN;", (fixture.MIGRATIONS / name).read_text(encoding="utf-8"), "INSERT INTO schema_migrations(name) VALUES('" + name + "');", "COMMIT;"]
        bootstrap.append((checks.HERE / "creative-050-051-test-fixture.sql").read_text(encoding="utf-8"))
        self.psql("\n".join(bootstrap), self.database)

    def snapshot(self):
        return json.loads(self.psql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; " + operator.snapshot_query() + "; COMMIT;", self.database).stdout)

    def migrate(self, before, injected="", after_seed=""):
        source = "\n".join((fixture.MIGRATIONS / name).read_text(encoding="utf-8") for name in operator.MIGRATIONS)
        sql = operator.migration_sql(before, CATALOG, source + "\n" + injected, checks.source_seed(), checks.OPTIONS)
        if after_seed: sql = sql.replace("DO $creative051guard$", after_seed + ";\nDO $creative051guard$", 1)
        return self.psql(sql, self.database, check=False)

    def test_exact_pg17_catalog_rows_recipes_and_disabled_statistics(self):
        before = self.snapshot()
        result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        operator.assert_delta(before, self.snapshot(), CATALOG)
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state;", self.database).stdout.strip(), "f")
        self.assertEqual(self.psql("SELECT count(*) FROM prompt_recipes WHERE key IN ('virtual-try-on','sketch-to-photo') AND current_version_id IS NOT NULL;", self.database).stdout.strip(), "2")

    def test_existing_draft_and_all_legacy_content_are_preserved(self):
        self.psql("INSERT INTO prompt_recipes(key,settings,updated_at) VALUES('virtual-try-on','{\"name\":\"Private draft\",\"enabled\":false,\"modelConfigId\":null,\"failurePolicy\":\"stop\"}','original');", self.database)
        before = self.snapshot()
        result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = self.snapshot(); operator.assert_delta(before, after, CATALOG)
        for table in ["prompt_recipes", "prompt_recipe_versions"]:
            self.assertEqual(operator.scope_map(before)[(table, "virtual-try-on")], operator.scope_map(after)[(table, "virtual-try-on")])

    def test_employee_or_private_recipe_write_rolls_back_all_changes(self):
        for injected in ["UPDATE users SET display_name='Unauthorized';", "UPDATE prompt_recipe_versions SET content='{}' WHERE recipe_key='text-to-style';"]:
            with self.subTest(injected=injected):
                before = self.snapshot(); result = self.migrate(before, injected)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(), before)

    def test_invalid_new_recipe_or_statistics_rolls_back_all_changes(self):
        for injected in ["UPDATE prompt_recipe_versions SET content='{}' WHERE recipe_key='virtual-try-on'", "UPDATE usage_rollup_state SET processing_enabled=true"]:
            with self.subTest(injected=injected):
                before = self.snapshot(); result = self.migrate(before, after_seed=injected)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(), before)


if __name__ == "__main__": unittest.main()
