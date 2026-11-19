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
spec = importlib.util.spec_from_file_location("image_conversations_054_055", HERE / "image-conversations-054-055.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
CATALOG = json.loads((HERE / "image-conversations-054-055-catalog.json").read_text(encoding="utf-8"))
SOURCE_UUID = "05400000-0000-4000-8000-000000000026"
TARGET_UUID = "05400000-0000-4000-8000-000000000027"


def before_state():
    names = operator.CHANGED_TABLES | {"users", "tasks", "providers", "usage_rollup_state", "tool_api_configurations", "quick_image_configurations", "prompt_recipes"}
    tables = [{"name": name, "count": 3, "sha256": "a" * 64} for name in sorted(names)]
    sequence = {key: int(value) if isinstance(value, str) and value.isdigit() else value for key, value in CATALOG["numberSequence"].items()}
    source = {"id": SOURCE_UUID, "provider_id": operator.PROVIDER_ID, "name": "Existing custom MAI 2.6", "model_id": operator.SOURCE_MODEL,
              "capabilities": ["generate", "edit", "batch"], "credit_cost": 17, "rmb_cost": "1.234567", "concurrency_limit": 11,
              "enabled": False, "created_by": None, "created_at": "old", "updated_at": "old", "workflow_config_id": None,
              "replacement_model_config_id": None, "public_number": 7}
    return {"identity": {"database": "canvas", "systemIdentifier": "same"},
            "migrations": [{"name": operator.PREVIOUS, "applied_at": "old"}],
            "sequences": [{"sequencename": "audit_logs_id_seq", "last_value": 77}, {**sequence, "last_value": 41}],
            "sequenceStates": [{"name": "audit_logs_id_seq", "lastValue": "77", "isCalled": True}, {"name": operator.NUMBER_SEQUENCE, "lastValue": "41", "isCalled": True}],
            "tables": tables, **{field: [] for field in operator.SORT_KEYS},
            "columns": copy.deepcopy(CATALOG["seedColumns"]), "functions": copy.deepcopy(CATALOG["modelFunction"]),
            "triggers": copy.deepcopy(CATALOG["modelTrigger"]), "mai27Safety": copy.deepcopy(operator.SAFETY),
            "mai27OtherModels": copy.deepcopy(next(row for row in tables if row["name"] == "model_configs")),
            "mai27Source": [source], "mai27Target": [], "mai27Provider": [{"id": operator.PROVIDER_ID, "protocol": "apimart"}],
            "mai27MaximumPublicNumber": 41}


def after_state(before=None):
    before = before_state() if before is None else before
    value = copy.deepcopy(before)
    value.update(operator.expected_catalog(before, CATALOG))
    number, sequences = operator.expected_number_state(before, CATALOG)
    value.update(sequences)
    value["mai27MaximumPublicNumber"] = number
    value["migrations"] += [{"name": name, "applied_at": "new"} for name in operator.MIGRATIONS]
    for row in value["tables"]:
        if row["name"] in operator.CHANGED_TABLES:
            row["count"] += 2 if row["name"] == "schema_migrations" else 1
            row["sha256"] = "b" * 64
    value["tables"] = sorted(value["tables"] + [{"name": name, "count": 0, "sha256": operator.EMPTY_HASH} for name in operator.NEW_TABLES], key=lambda row: row["name"])
    value["mai27Target"] = [{**operator.expected_model_values(before), "id": TARGET_UUID, "public_number": number, "created_at": "new", "updated_at": "new"}]
    return value


def assert_native_gap_only(case, before, after, steps=1):
    expected = copy.deepcopy(before)
    sequence = next(row for row in expected["sequences"] if row["sequencename"] == operator.NUMBER_SEQUENCE)
    state = next(row for row in expected["sequenceStates"] if row["name"] == operator.NUMBER_SEQUENCE)
    number = int(state["lastValue"]) + (1 if state["isCalled"] else 0) + steps - 1
    sequence["last_value"] = number
    state.update(lastValue=str(number), isCalled=True)
    case.assertEqual(after, expected, "Only the native model number sequence may retain a rolled-back allocation")


class ImageConversations054055Contracts(unittest.TestCase):
    def test_only_five_empty_tables_one_source_priced_model_two_registrations_and_one_native_number_change(self):
        before = before_state()
        operator.assert_delta(before, after_state(), CATALOG)
        self.assertFalse(after_state()["mai27Target"][0]["enabled"])
        self.assertEqual(after_state()["mai27Target"][0]["rmb_cost"], "1.234567")
        mutations = [lambda a: a["identity"].update(database="other"),
                     lambda a: a["mai27OtherModels"].update(sha256="changed"),
                     lambda a: a["mai27Source"][0].update(rmb_cost="9.000000"),
                     lambda a: a["mai27Target"][0].update(rmb_cost="0.000000"),
                     lambda a: a["mai27Target"][0].update(enabled=True),
                     lambda a: a["mai27Target"][0].update(concurrency_limit=5),
                     lambda a: a["mai27Target"][0].update(workflow_config_id=SOURCE_UUID),
                     lambda a: a["mai27Target"][0].update(public_number=43),
                     lambda a: a["mai27Target"][0].update(created_at="other"),
                     lambda a: a["mai27Target"][0].update(extra=True),
                     lambda a: a["mai27Target"].append(copy.deepcopy(a["mai27Target"][0])),
                     lambda a: a.update(mai27MaximumPublicNumber=43),
                     lambda a: a["migrations"][0].update(applied_at="changed"),
                     lambda a: a["migrations"][-1].update(applied_at="different-transaction"),
                     lambda a: a["migrations"].pop(),
                     lambda a: a["sequences"][0].update(last_value=78),
                     lambda a: a["sequenceStates"][0].update(isCalled=False),
                     lambda a: a["sequences"][1].update(last_value=43),
                     lambda a: a["sequenceStates"][1].update(lastValue="43"),
                     lambda a: a.update(unexpected=True)]
        for name in set(row["name"] for row in before["tables"]) - operator.CHANGED_TABLES:
            mutations.append(lambda a, name=name: next(row for row in a["tables"] if row["name"] == name).update(sha256="changed"))
        for name in operator.NEW_TABLES:
            mutations.append(lambda a, name=name: next(row for row in a["tables"] if row["name"] == name).update(count=1))
        for change in mutations:
            with self.subTest(change=change), self.assertRaises(Rejected):
                after = after_state(); change(after); operator.assert_delta(before, after, CATALOG)
        for field in operator.SORT_KEYS:
            with self.subTest(field=field), self.assertRaises(Rejected):
                after = after_state(); after[field].append({"unexpected": True}); operator.assert_delta(before, after, CATALOG)

    def test_no_source_existing_target_partial_schema_and_unreviewed_hooks_fail_closed(self):
        changes = [lambda b: b.update(mai27Source=[]), lambda b: b["mai27Source"].append(b["mai27Source"][0]),
                   lambda b: b["mai27Provider"][0].update(protocol="openai"),
                   lambda b: b["mai27Target"].append({"id": "admin-choice"}),
                   lambda b: b["mai27Safety"].update(seedTableTriggers=2),
                   lambda b: b["triggers"][0].update(enabled="D"),
                   lambda b: b["functions"][0].update(definition="different function"),
                   lambda b: b["columns"][0].update(column_default="changed"),
                   lambda b: b["mai27OtherModels"].update(sha256="incomplete"),
                   lambda b: b["tables"].append({"name": "image_conversations", "count": 0, "sha256": operator.EMPTY_HASH}),
                   lambda b: b["migrations"].append({"name": operator.MIGRATIONS[0], "applied_at": "old"})]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(Rejected):
                before = before_state(); change(before); operator.validate_before(before, CATALOG)

    def test_only_exact_noncycling_cache_one_sequence_with_unused_integer_number_is_accepted(self):
        before = before_state(); before["sequences"][1]["last_value"] = None
        before["sequenceStates"][1].update(lastValue="42", isCalled=False)
        operator.assert_delta(before, after_state(before), CATALOG)
        changes = [lambda b: b["sequences"][1].update(cache_size=2), lambda b: b["sequences"][1].update(cycle=True),
                   lambda b: b["sequences"][1].update(increment_by=2), lambda b: b["sequences"].pop(),
                   lambda b: b["sequenceStates"][1].update(isCalled=False),
                   lambda b: b.update(mai27MaximumPublicNumber=42),
                   lambda b: (b["sequences"][1].update(last_value=2147483647), b["sequenceStates"][1].update(lastValue="2147483647"))]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(Rejected):
                before = before_state(); change(before); operator.validate_before(before, CATALOG)

    def test_exact_previous_release_and_retained_names_reject_missing_duplicate_partial_and_future_state(self):
        names = [operator.PREVIOUS, *operator.MIGRATIONS]
        release = {"migrations": [{"name": name} for name in names]}
        operator.validate_source_migrations(before_state(), release, {"retainedMigrationNames": []})
        before = before_state(); before["migrations"].append({"name": "legacy-retained.sql", "applied_at": "old"})
        operator.validate_source_migrations(before, release, {"retainedMigrationNames": ["legacy-retained.sql"]})
        for actual in [[], [operator.PREVIOUS] * 2, names, [operator.PREVIOUS, operator.MIGRATIONS[0]], [operator.PREVIOUS, "other.sql"]]:
            with self.assertRaises(Rejected):
                operator.validate_source_migrations({"migrations": [{"name": name} for name in actual]}, release, {"retainedMigrationNames": []})
        for tail in [names[:-1], [*names, "056_future.sql"], [names[0], names[2], names[1]]]:
            with self.assertRaises(Rejected): operator.validate_source_migrations(before_state(), {"migrations": [{"name": name} for name in tail]}, {"retainedMigrationNames": []})

    def test_preflight_binds_all_bytes_and_rechecks_the_exact_fifteen_minute_window(self):
        with tempfile.TemporaryDirectory() as directory:
            package = Path(directory); instance = package / "instance.json"; instance.write_text("{}", encoding="utf-8")
            for relative in ["release-manifest.json", *operator.SQL_PATHS, *operator.RUNTIME_PATHS]:
                path = package / relative; path.parent.mkdir(parents=True, exist_ok=True); path.write_text("fixed", encoding="utf-8")
            prior = {"kind": "image-conversations-054-055-preflight", "createdAt": 1000, "instanceSha256": operator.sha_file(instance),
                     "manifestSha256": operator.sha_file(package / "release-manifest.json"), "payloadHashes": operator.payload_hashes(package), "package": str(package)}
            operator.validate_preflight(prior, package, instance, now=1900)
            for now in [999, 1900.001]:
                with self.assertRaises(Rejected): operator.validate_preflight(prior, package, instance, now=now)
            for field in ["kind", "instanceSha256", "manifestSha256", "payloadHashes", "package"]:
                with self.assertRaises(Rejected):
                    changed = copy.deepcopy(prior); changed[field] = "wrong"; operator.validate_preflight(changed, package, instance, now=1001)
            release = {"migrations": [{"name": name, "sha256": operator.digest_file(package / relative)} for name, relative in zip(operator.MIGRATIONS, operator.SQL_PATHS)]}
            self.assertEqual(operator.read_migration_sql(package, release), ["fixed", "fixed"])
            for relative in operator.SQL_PATHS:
                path = package / relative; path.write_text("tampered", encoding="utf-8")
                with self.assertRaises(Rejected): operator.read_migration_sql(package, release)
                with self.assertRaises(Rejected): operator.validate_preflight(prior, package, instance, now=1001)
                path.write_text("fixed", encoding="utf-8")

    def test_fixed_transaction_has_precommit_full_guards_and_no_trigger_bypass_or_sequence_reset(self):
        sql = operator.migration_sql(before_state(), CATALOG, ["-- fixed 054", "-- fixed 055"])
        self.assertEqual(sql.count("COMMIT;"), 1)
        for token in ["LOCK TABLE", "054_055_STOPPED_BASELINE_DRIFT", "054_055_STATISTICS_MUST_REMAIN_DISABLED",
                      "054_055_CATALOG_OR_ORIGINAL_ROWS_CHANGED", "054_055_CONVERSATIONS_MUST_REMAIN_EMPTY", "054_055_EXACT_SOURCE_PRICE_COPY_REQUIRED"]:
            self.assertLess(sql.index(token), sql.index("COMMIT;"))
        source = (HERE / "image-conversations-054-055.py").read_text(encoding="utf-8")
        for token in [".migrate_048(", ".control_048(", ".start_app(", "DISABLE TRIGGER", "ALTER SEQUENCE", "setval(", "UPDATE providers", "UPDATE usage_rollup_state"]:
            self.assertNotIn(token, source)
        from contract import assert_migrations
        with self.assertRaisesRegex(Rejected, "ZERO_MIGRATION_BASELINE_MISMATCH"):
            assert_migrations([operator.PREVIOUS], {"migrations": [{"name": name} for name in [operator.PREVIOUS, *operator.MIGRATIONS]]}, {"retainedMigrationNames": []})


@unittest.skipUnless(os.environ.get("PGLITE_RUNTIME_PATH"), "requires explicit disposable PGlite runtime; no network PostgreSQL")
class ImageConversations054055IsolatedSql(unittest.TestCase):
    def execute(self, operations):
        result = subprocess.run(["node", str(HERE / "test_image_conversations_054_055_sql.mjs")], input=json.dumps(operations),
                                text=True, encoding="utf-8", capture_output=True, timeout=90,
                                env=dict(os.environ, IMAGE_CONVERSATIONS_054_055_TEST_PYTHON=sys.executable))
        self.assertEqual(result.returncode, 0, result.stderr)
        values = json.loads(result.stdout)
        for row in values:
            if "snapshotJson" in row: row["snapshot"] = json.loads(row.pop("snapshotJson"))
        return values

    def test_actual_catalog_five_empty_tables_exact_source_copy_and_single_native_number(self):
        result = subprocess.run(["node", str(HERE / "test_image_conversations_054_055_sql.mjs"), "catalog"], text=True, encoding="utf-8", capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(json.loads(result.stdout), CATALOG)
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(rows[1]["ok"], rows[1]); operator.assert_delta(rows[0]["snapshot"], rows[2]["snapshot"], CATALOG)
        target = rows[2]["snapshot"]["mai27Target"][0]
        self.assertEqual(target["credit_cost"], 17); self.assertEqual(target["rmb_cost"], "1.234567")
        self.assertEqual(target["concurrency_limit"], 11); self.assertFalse(target["enabled"])

    def test_existing_target_raw_sql_is_noop_and_protected_operator_refuses_replay(self):
        rows = self.execute([{"kind": "migration"}, {"kind": "snapshot"}, {"kind": "raw-migration-055"}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(rows[0]["ok"], rows[0]); self.assertTrue(rows[2]["ok"], rows[2]); self.assertFalse(rows[4]["ok"], rows[4])
        self.assertEqual(rows[1]["snapshot"], rows[3]["snapshot"]); self.assertEqual(rows[3]["snapshot"], rows[5]["snapshot"])

    def test_missing_source_never_creates_default_price_and_operator_rejects_before_mutation(self):
        rows = self.execute([{"sql": "UPDATE model_configs SET model_id='source-is-not-configured' WHERE model_id='mai-image-2.6-flash'"},
                             {"kind": "snapshot"}, {"kind": "raw-migration-055"}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(rows[0]["ok"], rows[0]); self.assertTrue(rows[2]["ok"], rows[2]); self.assertFalse(rows[4]["ok"], rows[4])
        self.assertEqual(rows[1]["snapshot"], rows[3]["snapshot"]); self.assertEqual(rows[3]["snapshot"], rows[5]["snapshot"])
        self.assertEqual(rows[5]["snapshot"]["mai27Target"], [])

    def test_failed_transaction_rolls_back_business_and_schema_but_reports_native_number_gap(self):
        injections = ["UPDATE users SET credit_balance=99", "UPDATE tasks SET parameters='{}'",
                      "UPDATE providers SET encrypted_credentials='changed'", "UPDATE model_configs SET rmb_cost=99 WHERE model_id='mai-image-2.6-flash'",
                      "UPDATE tool_api_configurations SET model_config_id=NULL WHERE tool_key='image'",
                      "UPDATE quick_image_configurations SET prompt='changed' WHERE action='remove-background'",
                      "UPDATE usage_rollup_state SET processing_enabled=true", "UPDATE schema_migrations SET applied_at=now()",
                      "ALTER TABLE tasks ADD COLUMN unrelated text", "CREATE TABLE unrelated(id int)"]
        for injected in injections:
            with self.subTest(injected=injected):
                rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(rows[1]["ok"], rows[1]); assert_native_gap_only(self, rows[0]["snapshot"], rows[2]["snapshot"])

    def test_target_copy_tampering_nonempty_new_tables_and_wrong_catalog_roll_back(self):
        injections = ["UPDATE model_configs SET rmb_cost=0 WHERE model_id='mai-image-2.7-flash'",
                      "UPDATE model_configs SET enabled=true WHERE model_id='mai-image-2.7-flash'",
                      "UPDATE model_configs SET concurrency_limit=1 WHERE model_id='mai-image-2.7-flash'",
                      "INSERT INTO image_conversations(id,owner_user_id,entrypoint,create_request_id,create_request_hash) VALUES(gen_random_uuid(),'05300000-0000-4000-8000-000000000001','standalone','unexpected',repeat('a',64))"]
        for injected in injections:
            with self.subTest(injected=injected):
                rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "inject": injected}, {"kind": "snapshot"}])
                self.assertFalse(rows[1]["ok"], rows[1]); assert_native_gap_only(self, rows[0]["snapshot"], rows[2]["snapshot"])
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "wrongCatalog": True}, {"kind": "snapshot"}])
        self.assertFalse(rows[1]["ok"], rows[1]); assert_native_gap_only(self, rows[0]["snapshot"], rows[2]["snapshot"])

    def test_high_precision_original_price_is_compared_without_json_float_rounding(self):
        rows = self.execute([{"sql": "UPDATE model_configs SET rmb_cost=9999999999.999999 WHERE model_id='mai-image-2.6-flash'"},
                             {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
        self.assertTrue(rows[0]["ok"], rows[0]); self.assertTrue(rows[2]["ok"], rows[2])
        operator.assert_delta(rows[1]["snapshot"], rows[3]["snapshot"], CATALOG)
        self.assertEqual(rows[3]["snapshot"]["mai27Target"][0]["rmb_cost"], "9999999999.999999")

    def test_unreviewed_hooks_and_exhausted_number_reject_without_consuming_a_number(self):
        setups = ["CREATE FUNCTION extra_model_hook() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER extra_model_hook BEFORE INSERT ON model_configs FOR EACH ROW EXECUTE FUNCTION extra_model_hook()",
                  "SELECT setval('model_public_number_seq',2147483647,true)"]
        for setup in setups:
            with self.subTest(setup=setup):
                rows = self.execute([{"sql": setup}, {"kind": "snapshot"}, {"kind": "migration"}, {"kind": "snapshot"}])
                self.assertTrue(rows[0]["ok"], rows[0]); self.assertFalse(rows[2]["ok"], rows[2]); self.assertEqual(rows[1]["snapshot"], rows[3]["snapshot"])

    def test_stopped_baseline_drift_rejects_before_ddl_or_sequence_allocation(self):
        rows = self.execute([{"kind": "snapshot"}, {"kind": "migration", "beforeSql": "UPDATE users SET display_name='Changed after baseline'"}, {"kind": "snapshot"}])
        self.assertFalse(rows[1]["ok"], rows[1]); self.assertIn("054_055_STOPPED_BASELINE_DRIFT", rows[1]["message"])
        self.assertEqual(rows[0]["snapshot"]["migrations"], rows[2]["snapshot"]["migrations"])
        self.assertEqual(rows[0]["snapshot"]["sequenceStates"], rows[2]["snapshot"]["sequenceStates"])
        self.assertEqual(rows[2]["snapshot"]["mai27Target"], [])


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--sql-builder":
        request = json.load(sys.stdin); catalog = copy.deepcopy(CATALOG)
        if request.get("wrongCatalog"): catalog["additions"]["columns"][0]["column_default"] = "wrong-default"
        sources = [(ROOT / path).read_text(encoding="utf-8") for path in operator.SQL_PATHS]
        sources[-1] += ";\n" + request.get("inject", "") + ";\n"
        query = operator.migration_sql(json.loads(request["beforeJson"]), catalog, sources)
        sys.stdout.buffer.write(query.encode("utf-8"))
    else: unittest.main()
