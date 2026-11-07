"""Fixed 050/051 contracts and disposable SQL execution; no live database."""
import copy
from functools import lru_cache
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from contract import Rejected
from creative_seed import build_source_seed, validate_seed

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
spec = importlib.util.spec_from_file_location("creative_050_051", HERE / "creative-050-051.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
CATALOG = json.loads((HERE / "creative-050-051-catalog.json").read_text(encoding="utf-8"))
OPTIONS = {"actorId": "05100000-0000-4000-8000-000000000001", "optimizerModelConfigId": "05100000-0000-4000-8000-000000000002"}


@lru_cache(maxsize=1)
def source_seed():
    return build_source_seed(ROOT)


def before_state():
    scopes = [{"table": table, "key": key, "count": 0, "sha256": "0" * 64} for table, (_, keys) in operator.SCOPES.items() for key in keys]
    return {"identity": {"database": "canvas", "systemIdentifier": "same"},
            "migrations": [{"name": "049_quick_image_configurations.sql", "applied_at": "old"}],
            "sequences": [{"sequencename": "audit_logs_id_seq", "last_value": 7}],
            "sequenceStates": [{"name": "audit_logs_id_seq", "lastValue": "7", "isCalled": True}],
            "tables": [{"name": name, "count": 3, "sha256": "a" * 64} for name in sorted(operator.CHANGED_TABLES | {"users", "quick_image_configurations"})],
            **{field: [] for field in operator.SORT_KEYS},
            "constraints": [copy.deepcopy(row["before"]) for row in CATALOG["constraints"]],
            "creativeScopes": sorted(scopes, key=lambda row: (row["table"], row["key"])),
            "creativeOtherRows": [{"name": table, "count": 3, "sha256": "b" * 64} for table in sorted(operator.SCOPES)]}


def after_state(before=None):
    before = before_state() if before is None else before
    value = copy.deepcopy(before)
    value.update(operator.expected_catalog(before, CATALOG))
    value["migrations"] += [{"name": name, "applied_at": "new"} for name in operator.MIGRATIONS]
    missing = operator.missing_scopes(before)
    for row in value["tables"]:
        if row["name"] in operator.CHANGED_TABLES:
            row["count"] += 2 if row["name"] == "schema_migrations" else len(missing[row["name"]])
            row["sha256"] = "c" * 64
    for row in value["creativeScopes"]:
        if row["key"] in missing[row["table"]]: row.update(count=1, sha256="d" * 64)
    return value


class Creative050051Contracts(unittest.TestCase):
    def test_only_reviewed_three_constraints_and_missing_scopes_can_change(self):
        operator.assert_delta(before_state(), after_state(), CATALOG)
        changes = [lambda v: v["identity"].update(database="other"),
                   lambda v: v["sequences"][0].update(last_value=8),
                   lambda v: v["sequenceStates"][0].update(isCalled=False),
                   lambda v: v["creativeOtherRows"][0].update(sha256="changed"),
                   lambda v: next(row for row in v["tables"] if row["name"] == "users").update(sha256="changed"),
                   lambda v: v["creativeScopes"][0].update(count=2),
                   lambda v: v["migrations"][0].update(applied_at="changed"),
                   lambda v: v["migrations"].pop(),
                   lambda v: v["tables"].append({"name": "unexpected", "count": 0, "sha256": "0" * 64}),
                   lambda v: v.update(unexpected=True)]
        for change in changes:
            value = after_state(); change(value)
            with self.subTest(change=change), self.assertRaises(Rejected): operator.assert_delta(before_state(), value, CATALOG)
        for field in operator.SORT_KEYS:
            value = after_state(); value[field].append({"unexpected": True})
            with self.subTest(field=field), self.assertRaises(Rejected): operator.assert_delta(before_state(), value, CATALOG)

    def test_existing_draft_without_version_is_not_installed_or_activated(self):
        before = before_state()
        old = next(row for row in before["creativeScopes"] if row["table"] == "prompt_recipes" and row["key"] == "virtual-try-on")
        old.update(count=1, sha256="existing-draft")
        missing = operator.missing_scopes(before)
        self.assertEqual(missing["prompt_recipes"], ["sketch-to-photo"])
        self.assertEqual(missing["prompt_recipe_versions"], ["sketch-to-photo"])
        after = after_state(before)
        operator.assert_delta(before, after, CATALOG)
        next(row for row in after["creativeScopes"] if row["table"] == "prompt_recipes" and row["key"] == "virtual-try-on")["sha256"] = "changed"
        with self.assertRaisesRegex(Rejected, "EXISTING_SCOPED_ROW_CHANGED"): operator.assert_delta(before, after, CATALOG)

    def test_catalog_cannot_target_other_constraints_or_accept_a_partial_upgrade(self):
        for change in [lambda c: c["constraints"].pop(), lambda c: c["constraints"][0]["after"].update(name="unexpected"),
                       lambda c: c["constraints"][0]["before"].update(type="f")]:
            catalog = copy.deepcopy(CATALOG); change(catalog)
            with self.assertRaises(Rejected): operator.expected_catalog(before_state(), catalog)
        before = before_state(); before["constraints"][0]["definition"] = "CHECK (true)"
        with self.assertRaisesRegex(Rejected, "EXACT_PREVIOUS_CHECK_REQUIRED"): operator.expected_catalog(before, CATALOG)

    def test_no_replay_missing_049_or_unreviewed_migration_is_accepted(self):
        release = {"migrations": [{"name": "049_quick_image_configurations.sql"}, *[{"name": name} for name in operator.MIGRATIONS]]}
        operator.validate_source_migrations(before_state(), release, {"retainedMigrationNames": []})
        for names in [[], [operator.MIGRATIONS[0]], ["049_quick_image_configurations.sql", operator.MIGRATIONS[1]], ["unexpected.sql"]]:
            with self.subTest(names=names), self.assertRaises(Rejected):
                operator.validate_source_migrations({"migrations": [{"name": name} for name in names]}, release, {"retainedMigrationNames": []})

    def test_source_export_is_exactly_two_public_defaults_and_hashes_match_store(self):
        seed = source_seed()
        self.assertEqual([row["key"] for row in seed["recipes"]], ["virtual-try-on", "sketch-to-photo"])
        self.assertEqual(seed["source"]["sha256"], operator.digest_file(ROOT / "server/src/new-creative-recipes.ts"))
        for change in [lambda s: s.update(database="export"), lambda s: s["recipes"].append(s["recipes"][0]),
                       lambda s: s["recipes"][0].update(key="text-to-style"),
                       lambda s: s["recipes"][0]["content"].update(systemPrompt="tampered"),
                       lambda s: s["recipes"][0]["content"].update(extra="hidden"),
                       lambda s: s["source"].update(path="private-recipes.json")]:
            value = copy.deepcopy(seed); change(value)
            with self.subTest(change=change), self.assertRaises(Rejected): validate_seed(value)
        source = (HERE / "build-creative-050-051-seed.ts").read_text(encoding="utf-8")
        for forbidden in ["DATABASE_URL", "createDatabase", "readFile", "private", "installNewCreativeRecipes"]: self.assertNotIn(forbidden, source)

    def test_preflight_binds_same_instance_package_seed_actor_model_and_15_minutes(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            instance = package / "instance.json"; instance.write_text("{}", encoding="utf-8")
            (package / "release-manifest.json").write_text("{}", encoding="utf-8")
            for relative in [operator.SEED_PATH, operator.CATALOG_PATH, *["server/src/migrations/" + name for name in operator.MIGRATIONS]]:
                path = package / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixed", encoding="utf-8")
            prior = {"kind": "creative-050-051-preflight", "createdAt": 1000, "instanceSha256": operator.sha_file(instance),
                     "manifestSha256": operator.sha_file(package / "release-manifest.json"), "payloadHashes": operator.payload_hashes(package),
                     "package": str(package), "options": OPTIONS}
            operator.validate_preflight(prior, package, instance, OPTIONS, now=1900)
            for now in [999, 1900.001]:
                with self.assertRaisesRegex(Rejected, "FRESH_PREFLIGHT_REQUIRED"): operator.validate_preflight(prior, package, instance, OPTIONS, now=now)
            for field in ["kind", "instanceSha256", "manifestSha256", "payloadHashes", "package", "options"]:
                value = copy.deepcopy(prior); value[field] = "changed"
                with self.subTest(field=field), self.assertRaises(Rejected): operator.validate_preflight(value, package, instance, OPTIONS, now=1001)
            (package / operator.SEED_PATH).write_text("changed", encoding="utf-8")
            with self.assertRaisesRegex(Rejected, "TARGET_CHANGED"): operator.validate_preflight(prior, package, instance, OPTIONS, now=1001)

    def test_exact_sql_bytes_are_rehashed_immediately_before_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory)
            rows = []
            for name in operator.MIGRATIONS:
                path = package / "server/src/migrations" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("-- reviewed " + name, encoding="utf-8")
                rows.append({"name": name, "sha256": operator.digest_file(path)})
            self.assertIn(operator.MIGRATIONS[0], operator.read_migration_sql(package, {"migrations": rows}))
            (package / "server/src/migrations" / operator.MIGRATIONS[0]).write_text("ALTER TABLE users ADD COLUMN malicious text;", encoding="utf-8")
            with self.assertRaisesRegex(Rejected, "SQL_CHANGED_BEFORE_EXECUTION"):
                operator.read_migration_sql(package, {"migrations": rows})

    def test_transaction_locks_full_baseline_and_checks_every_delta_before_commit(self):
        sql = operator.migration_sql(before_state(), CATALOG, "-- reviewed fixed SQL", source_seed(), OPTIONS)
        self.assertEqual(sql.count("COMMIT;"), 1)
        for token in ["LOCK TABLE", "051_STOPPED_BASELINE_DRIFT", "051_DEPENDENCIES_OR_STATISTICS_INVALID", "INSERT INTO schema_migrations",
                      "051_ORIGINAL_BUSINESS_ROWS_CHANGED", "051_NEW_TOOL_ROW_INVALID", "051_NEW_RECIPE_ROW_INVALID", "051_NEW_VERSION_ROW_INVALID"]:
            self.assertLess(sql.index(token), sql.index("COMMIT;"))
        self.assertNotIn("UPDATE usage_rollup_state", sql)
        source = (HERE / "creative-050-051.py").read_text(encoding="utf-8")
        for token in ['choices=["preflight", "migrate"]', '"automaticRetry": False', '"automaticRestore": False', 'self.start_original(baseline)']:
            self.assertIn(token, source)
        for token in [".migrate_048(", ".control_048(", ".start_app(", "pg_restore\", \"--clean"]: self.assertNotIn(token, source)


@unittest.skipUnless(os.environ.get("PGLITE_RUNTIME_PATH"), "requires explicit disposable PGlite runtime; no network PostgreSQL")
class Creative050051IsolatedSql(unittest.TestCase):
    def execute(self, operations):
        environment = dict(os.environ, CREATIVE_051_TEST_PYTHON=sys.executable)
        result = subprocess.run(["node", str(HERE / "test_creative_050_051_sql.mjs")], input=json.dumps(operations),
                                text=True, encoding="utf-8", capture_output=True, timeout=90, env=environment)
        self.assertEqual(result.returncode, 0, result.stderr)
        values = json.loads(result.stdout)
        for value in values:
            if "snapshotJson" in value: value["snapshot"] = json.loads(value.pop("snapshotJson"))
        return values

    def test_real_catalog_exact_committed_rows_and_disabled_statistics(self):
        catalog = subprocess.run(["node", str(HERE / "test_creative_050_051_sql.mjs"), "catalog"], text=True, encoding="utf-8", capture_output=True, timeout=60)
        self.assertEqual(catalog.returncode, 0, catalog.stderr)
        self.assertEqual(json.loads(catalog.stdout), CATALOG)
        values = self.execute([{"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"},
                               {"sql": "SELECT processing_enabled FROM usage_rollup_state; SELECT key,current_version_id IS NOT NULL AS activated,settings->>'modelConfigId' AS optimizer FROM prompt_recipes WHERE key IN ('virtual-try-on','sketch-to-photo') ORDER BY key"}])
        self.assertTrue(values[1]["ok"], values[1])
        operator.assert_delta(values[0]["snapshot"], values[2]["snapshot"], CATALOG)
        self.assertEqual(values[3]["values"][0]["rows"], [{"processing_enabled": False}])
        self.assertTrue(all(row["activated"] and row["optimizer"] == OPTIONS["optimizerModelConfigId"] for row in values[3]["values"][1]["rows"]))

    def test_existing_draft_and_published_custom_recipe_versions_are_byte_preserved(self):
        setup = """INSERT INTO prompt_recipes(key,settings,updated_at) VALUES
        ('virtual-try-on','{"name":"Existing draft","enabled":false,"modelConfigId":null,"failurePolicy":"fallback"}','original'),
        ('sketch-to-photo','{"name":"Existing custom published","enabled":true,"modelConfigId":null,"failurePolicy":"stop"}','original');
        INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at)
        VALUES('custom-version','sketch-to-photo',7,'custom-hash','{"systemPrompt":"Private custom text"}','custom-author','original');
        UPDATE prompt_recipes SET current_version_id='custom-version' WHERE key='sketch-to-photo';"""
        values = self.execute([{"sql": setup}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(values[0]["ok"], values[0]); self.assertTrue(values[2]["ok"], values[2])
        operator.assert_delta(values[1]["snapshot"], values[3]["snapshot"], CATALOG)
        for table in ["prompt_recipes", "prompt_recipe_versions"]:
            self.assertEqual(next(row for row in values[1]["snapshot"]["tables"] if row["name"] == table),
                             next(row for row in values[3]["snapshot"]["tables"] if row["name"] == table))

    def test_unrelated_data_schema_and_statistics_writes_roll_back_everything(self):
        injections = ["UPDATE users SET display_name='Changed'", "UPDATE module_flags SET enabled=NOT enabled WHERE module_key='image'",
                      "UPDATE prompt_recipe_versions SET content='{}' WHERE recipe_key='text-to-style'",
                      "UPDATE usage_rollup_state SET processing_enabled=true", "UPDATE schema_migrations SET applied_at=now()",
                      "ALTER TABLE users ADD COLUMN unwanted text", "CREATE TABLE unrelated(id int)", "CREATE SEQUENCE unexpected_seq",
                      "ALTER TABLE quick_image_configurations DROP CONSTRAINT quick_image_configurations_prompt_check"]
        for injected in injections:
            with self.subTest(injected=injected):
                values = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(values[1]["ok"], values[1])
                self.assertEqual(values[0]["snapshot"], values[2]["snapshot"])

    def test_new_rows_are_exact_not_merely_allowed_table_writes(self):
        for injected in ["UPDATE module_flags SET enabled=false WHERE module_key='creative-virtual-try-on'",
                         "UPDATE tool_api_configurations SET allow_raw_prompt=true WHERE tool_key='creative-sketch-to-photo'",
                         "UPDATE prompt_recipe_versions SET content='{}' WHERE recipe_key='virtual-try-on'",
                         "UPDATE prompt_recipes SET current_version_id=NULL WHERE key='sketch-to-photo'"]:
            with self.subTest(injected=injected):
                values = self.execute([{"kind": "snapshot"}, {"kind": "migration", "injectAfterSeed": injected}, {"kind": "snapshot"}])
                self.assertFalse(values[1]["ok"], values[1])
                self.assertEqual(values[0]["snapshot"], values[2]["snapshot"])

    def test_missing_or_disabled_dependencies_reject_before_any_migration(self):
        for setup in ["UPDATE users SET role='designer' WHERE username='creative051-fixture'",
                      "UPDATE model_configs SET enabled=false WHERE model_id='fixture-chat'",
                      "UPDATE model_configs SET enabled=false WHERE model_id='gpt-image-2.6-flare'",
                      "UPDATE usage_rollup_state SET processing_enabled=true"]:
            with self.subTest(setup=setup):
                values = self.execute([{"sql": setup}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
                self.assertTrue(values[0]["ok"], values[0]); self.assertFalse(values[2]["ok"], values[2])
                self.assertEqual(values[1]["snapshot"], values[3]["snapshot"])

    def test_success_cannot_be_replayed_or_reinstall_existing_recipes(self):
        values = self.execute([{"kind": "migration"}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(values[0]["ok"], values[0]); self.assertFalse(values[2]["ok"], values[2])
        self.assertEqual(values[1]["snapshot"], values[3]["snapshot"])


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--sql-builder":
        request = json.load(sys.stdin)
        sql = "\n".join((ROOT / "server/src/migrations" / name).read_text(encoding="utf-8") for name in operator.MIGRATIONS)
        value = operator.migration_sql(json.loads(request["beforeJson"]), CATALOG, sql + ";\n" + request.get("inject", "") + ";\n", source_seed(), OPTIONS)
        if request.get("injectAfterSeed"):
            value = value.replace("DO $creative051guard$", request["injectAfterSeed"] + ";\nDO $creative051guard$", 1)
        sys.stdout.buffer.write(value.encode("utf-8"))
    else: unittest.main()
