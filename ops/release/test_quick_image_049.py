"""Fixed additive schema contracts and disposable PostgreSQL execution checks."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from contract import Rejected

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("quick_image_049", HERE / "quick-image-049.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
CATALOG = json.loads((HERE / "quick-image-049-catalog.json").read_text(encoding="utf-8"))


def before_state():
    return {"identity": {"database": "canvas", "systemIdentifier": "same"},
            "migrations": [{"name": "048_usage_daily_facts.sql", "applied_at": "old"}],
            "sequences": [{"sequencename": "audit_logs_id_seq", "last_value": 7}],
            "sequenceStates": [{"name": "audit_logs_id_seq", "lastValue": "7", "isCalled": True}],
            "tables": [{"name": "business", "count": 3, "sha256": "a" * 64}, {"name": "schema_migrations", "count": 1, "sha256": "b" * 64}],
            **{field: [] for field in operator.SORT_KEYS}}


def after_state():
    before = before_state()
    value = copy.deepcopy(before)
    value.update(operator.support.catalog_union(before, CATALOG))
    value["migrations"].append({"name": operator.MIGRATION, "applied_at": "new"})
    value["tables"][1].update(count=2, sha256="c" * 64)
    value["tables"].append({"name": operator.NEW_TABLE, "count": 0, "sha256": "d" * 64})
    return value


class QuickImage049Contracts(unittest.TestCase):
    def test_only_empty_configuration_table_and_one_migration_row_can_change(self):
        operator.assert_049_delta(before_state(), after_state(), CATALOG)
        mutations = [lambda s: s["identity"].update(database="other"),
                     lambda s: s["sequences"][0].update(last_value=8),
                     lambda s: s["sequenceStates"][0].update(isCalled=False),
                     lambda s: s["tables"][0].update(sha256="changed"),
                     lambda s: s["tables"][2].update(count=1),
                     lambda s: s["migrations"][0].update(applied_at="changed"),
                     lambda s: s["tables"].append({"name": "unexpected", "count": 0, "sha256": "e" * 64})]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                value = after_state(); mutation(value)
                with self.assertRaises(Rejected): operator.assert_049_delta(before_state(), value, CATALOG)
        for field in operator.SORT_KEYS:
            value = after_state(); value[field].append({"unexpected": True})
            with self.subTest(field=field), self.assertRaises(Rejected): operator.assert_049_delta(before_state(), value, CATALOG)

    def test_no_replay_or_unreviewed_previous_migration_is_accepted(self):
        release = {"migrations": [{"name": "048_usage_daily_facts.sql"}, {"name": operator.MIGRATION}]}
        operator.validate_source_migrations(before_state(), release, {"retainedMigrationNames": []})
        for names in [[], [operator.MIGRATION], ["048_usage_daily_facts.sql", operator.MIGRATION], ["unexpected.sql"]]:
            with self.subTest(names=names), self.assertRaises(Rejected):
                operator.validate_source_migrations({"migrations": [{"name": name} for name in names]}, release, {"retainedMigrationNames": []})

    def test_transaction_checks_original_data_before_commit_without_enabling_statistics(self):
        sql = operator.migration_sql(before_state(), CATALOG, "-- fixed reviewed 049")
        self.assertEqual(sql.count("COMMIT;"), 1)
        for token in ["LOCK TABLE", "049_STOPPED_BASELINE_DRIFT", "INSERT INTO schema_migrations", "049_ORIGINAL_BUSINESS_ROWS_CHANGED", "049_SETTINGS_MUST_REMAIN_EMPTY"]:
            self.assertLess(sql.index(token), sql.index("COMMIT;"))
        self.assertNotIn("UPDATE usage_rollup_state", sql)
        self.assertNotIn("DROP TABLE", sql)
        source = (HERE / "quick-image-049.py").read_text(encoding="utf-8")
        self.assertIn('choices=["preflight", "migrate"]', source)
        self.assertNotIn(".migrate_048(", source)
        self.assertNotIn(".control_048(", source)
        self.assertIn('"automaticRetry": False', source)
        self.assertIn('"automaticRestore": False', source)


@unittest.skipUnless(os.environ.get("PGLITE_RUNTIME_PATH"), "requires explicit disposable PGlite runtime; no network PostgreSQL")
class QuickImage049IsolatedSql(unittest.TestCase):
    def execute(self, operations):
        environment = dict(os.environ, QUICK_IMAGE_049_TEST_PYTHON=sys.executable)
        result = subprocess.run(["node", str(HERE / "test_quick_image_049_sql.mjs")], input=json.dumps(operations),
                                text=True, encoding="utf-8", capture_output=True, timeout=60, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        values = json.loads(result.stdout)
        for value in values:
            if "snapshotJson" in value: value["snapshot"] = json.loads(value.pop("snapshotJson"))
        return values

    def test_catalog_matches_real_migration_and_commits_only_empty_settings(self):
        result = subprocess.run(["node", str(HERE / "test_quick_image_049_sql.mjs"), "catalog"], text=True, encoding="utf-8", capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), CATALOG)
        values = self.execute([{"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}, {"sql": "SELECT processing_enabled FROM usage_rollup_state"}])
        self.assertTrue(values[1]["ok"], values[1])
        operator.assert_049_delta(values[0]["snapshot"], values[2]["snapshot"], CATALOG)
        self.assertEqual(values[3]["values"][0]["rows"], [{"processing_enabled": False}])

    def test_changed_business_schema_or_statistics_rolls_back_the_whole_migration(self):
        for injected in ["UPDATE module_flags SET enabled=NOT enabled", "UPDATE usage_rollup_state SET processing_enabled=true",
                         "UPDATE schema_migrations SET applied_at=now()", "ALTER TABLE users ADD COLUMN unwanted text",
                         "CREATE TABLE unrelated(id int)", "CREATE SEQUENCE unexpected_seq"]:
            with self.subTest(injected=injected):
                values = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(values[1]["ok"], values[1])
                self.assertEqual(values[0]["snapshot"], values[2]["snapshot"])

    def test_existing_049_cannot_be_reapplied(self):
        values = self.execute([{"kind": "migration"}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(values[0]["ok"], values[0]); self.assertFalse(values[2]["ok"], values[2])
        self.assertEqual(values[1]["snapshot"], values[3]["snapshot"])


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--sql-builder":
        request = json.load(sys.stdin)
        source = (HERE.parent.parent / operator.SQL_PATH).read_text(encoding="utf-8")
        value = operator.migration_sql(json.loads(request["beforeJson"]), CATALOG, source + ";\n" + request.get("inject", "") + ";\n")
        sys.stdout.buffer.write(value.encode("utf-8"))
    else: unittest.main()
