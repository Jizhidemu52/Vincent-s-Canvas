#!/usr/bin/env python3
"""Fixed 054/055 preparation, separate from zero-database-change deployment."""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import uuid

from contract import (Rejected, assert_database_layout, assert_idle, assert_protected,
                      container_map, digest, digest_file, read_json, require, verify_package, write_new_json)
from deploy import assert_rollback_source, compose_literals, private_directory, require_unchanged, sha_file

TOOLS = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("image_conversations_054_055_support", TOOLS / "usage-048.py")
support = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(support)
MIGRATIONS = ("054_image_conversations.sql", "055_mai27_model_catalog.sql")
PREVIOUS = "053_canvas_design_chat.sql"
SQL_PATHS = ["server/src/migrations/" + name for name in MIGRATIONS]
CATALOG_PATH = "ops/release/image-conversations-054-055-catalog.json"
STATE_PATH = "ops/release/image-conversations-054-055-state.sql"
PROVIDER_ID = "9567f5da-bb4d-4e4b-b680-c7184d00a001"
SOURCE_MODEL = "mai-image-2.6-flash"
TARGET_MODEL = "mai-image-2.7-flash"
NUMBER_SEQUENCE = "model_public_number_seq"
NEW_TABLES = {"image_conversations", "image_conversation_turns", "image_conversation_versions",
              "image_conversation_messages", "image_conversation_events"}
CHANGED_TABLES = {"schema_migrations", "model_configs"}
COPY_FIELDS = ("provider_id", "credit_cost", "rmb_cost", "concurrency_limit", "enabled", "created_by")
MODEL_FIELDS = {"id", "provider_id", "name", "model_id", "capabilities", "credit_cost", "rmb_cost",
                "concurrency_limit", "enabled", "created_by", "created_at", "updated_at",
                "workflow_config_id", "replacement_model_config_id", "public_number"}
SORT_KEYS = support.SORT_KEYS
SAFETY = {"enabledEventTriggers": 0, "seedTableTriggers": 1, "seedTableRules": 0, "seedTableRls": 0}
STABLE_FIELDS = ("identity", "mai27OtherModels", "mai27Source", "mai27Provider", "mai27Safety")
DEPENDENCY_FIELDS = ("functions", "triggers", "mai27Source", "mai27Provider", "mai27Safety")
RUNTIME_PATHS = ["ops/release/image-conversations-054-055.py", CATALOG_PATH, STATE_PATH,
                 "ops/release/usage-048.py", "ops/release/usage-048-state.sql", "ops/release/database-state.sql",
                 "ops/release/contract.py", "ops/release/deploy.py", "ops/release/activity.sql", "ops/release/maintenance.sql"]
EMPTY_HASH = digest(b"")


def snapshot_query():
    extra = (TOOLS / Path(STATE_PATH).name).read_text(encoding="utf-8").strip().rstrip(";")
    return f"WITH b(snapshot) AS ({support.snapshot_query()}), s(snapshot) AS ({extra}) SELECT b.snapshot||s.snapshot FROM b,s"


def validate_catalog(catalog):
    require(isinstance(catalog, dict) and set(catalog) == {"schema", "additions", "seedColumns", "modelTrigger", "modelFunction", "numberSequence"}
            and type(catalog["schema"]) is int and catalog["schema"] == 1, "054_055_FIXED_CATALOG_REQUIRED")
    additions = catalog["additions"]
    support.catalog_union({field: [] for field in SORT_KEYS}, additions)
    for field, key in [("columns", "table_name"), ("indexes", "tablename"), ("constraints", "relation")]:
        require({row[key] for row in additions[field]} == NEW_TABLES, "054_055_EXACT_FIVE_TABLE_CATALOG_REQUIRED")
    require(not additions["functions"] and not additions["triggers"], "054_055_NO_NEW_FUNCTION_OR_TRIGGER_ALLOWED")
    require(isinstance(catalog["seedColumns"], list) and {row["table_name"] for row in catalog["seedColumns"]} == CHANGED_TABLES
            and {row["column_name"] for row in catalog["seedColumns"] if row["table_name"] == "model_configs"} == MODEL_FIELDS,
            "054_055_EXACT_SEED_COLUMNS_REQUIRED")
    require(len(catalog["modelTrigger"]) == len(catalog["modelFunction"]) == 1
            and catalog["modelTrigger"][0]["relation"] == "model_configs"
            and catalog["modelTrigger"][0]["name"] == "model_public_number_before_write"
            and catalog["modelTrigger"][0]["enabled"] == "O"
            and catalog["modelFunction"][0]["identity"] == "assign_model_public_number()", "054_055_FIXED_NUMBER_TRIGGER_REQUIRED")
    require_unchanged(catalog["numberSequence"], {"sequencename": NUMBER_SEQUENCE, "start_value": "1", "min_value": "1",
                      "max_value": "9223372036854775807", "increment_by": "1", "cycle": False, "cache_size": "1"},
                      "054_055_FIXED_NUMBER_SEQUENCE_REQUIRED")


def expected_catalog(before, catalog):
    validate_catalog(catalog)
    require_unchanged([row for row in before["columns"] if row["table_name"] in CHANGED_TABLES], catalog["seedColumns"],
                      "054_055_SEED_SCHEMA_OR_DEFAULTS_CHANGED")
    require_unchanged([row for row in before["triggers"] if row["relation"] == "model_configs"], catalog["modelTrigger"],
                      "054_055_NUMBER_TRIGGER_CHANGED")
    require_unchanged([row for row in before["functions"] if row["identity"] == "assign_model_public_number()"], catalog["modelFunction"],
                      "054_055_NUMBER_FUNCTION_CHANGED")
    return support.catalog_union(before, catalog["additions"])


def source_model(before):
    rows = before["mai27Source"]
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) and set(rows[0]) == MODEL_FIELDS,
            "054_055_ONE_EXISTING_MAI26_SOURCE_REQUIRED")
    source = rows[0]
    require(isinstance(source["id"], str) and str(uuid.UUID(source["id"])) == source["id"]
            and source["provider_id"] == PROVIDER_ID and source["model_id"] == SOURCE_MODEL
            and isinstance(source["rmb_cost"], str) and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", source["rmb_cost"])
            and type(source["enabled"]) is bool and type(source["credit_cost"]) is int and source["credit_cost"] >= 0
            and type(source["concurrency_limit"]) is int and source["concurrency_limit"] > 0,
            "054_055_SOURCE_IDENTITY_OR_PRICE_INVALID")
    require_unchanged(before["mai27Provider"], [{"id": PROVIDER_ID, "protocol": "apimart"}], "054_055_ORIGINAL_APIMART_PROVIDER_REQUIRED")
    return source


def expected_number_state(before, catalog):
    sequences = [row for row in before["sequences"] if row["sequencename"] == NUMBER_SEQUENCE]
    states = [row for row in before["sequenceStates"] if row["name"] == NUMBER_SEQUENCE]
    require(len(sequences) == len(states) == 1, "054_055_ONE_NUMBER_SEQUENCE_REQUIRED")
    sequence, state = sequences[0], states[0]
    require(set(sequence) == set(catalog["numberSequence"]) | {"last_value"}, "054_055_NUMBER_SEQUENCE_FIELDS_INVALID")
    normalized = {key: str(value) if type(value) is int else value for key, value in sequence.items() if key != "last_value"}
    require_unchanged(normalized, catalog["numberSequence"], "054_055_NUMBER_SEQUENCE_CONFIGURATION_CHANGED")
    require(set(state) == {"name", "lastValue", "isCalled"} and type(state["isCalled"]) is bool
            and isinstance(state["lastValue"], str) and re.fullmatch(r"[1-9][0-9]*", state["lastValue"]),
            "054_055_NUMBER_SEQUENCE_STATE_INVALID")
    last = int(state["lastValue"])
    require(sequence["last_value"] == (last if state["isCalled"] else None), "054_055_NUMBER_SEQUENCE_STATE_INCONSISTENT")
    number = last + (1 if state["isCalled"] else 0)
    require(type(before["mai27MaximumPublicNumber"]) is int and 0 <= before["mai27MaximumPublicNumber"] < number <= 2147483647,
            "054_055_NEXT_PUBLIC_NUMBER_MUST_BE_UNUSED_AND_VALID")
    expected = {field: copy.deepcopy(before[field]) for field in ["sequences", "sequenceStates"]}
    next(row for row in expected["sequences"] if row["sequencename"] == NUMBER_SEQUENCE)["last_value"] = number
    next(row for row in expected["sequenceStates"] if row["name"] == NUMBER_SEQUENCE).update(lastValue=str(number), isCalled=True)
    return number, expected


def expected_model_values(before):
    source = source_model(before)
    return {**{field: source[field] for field in COPY_FIELDS}, "name": "aplmart-mai2.7-flash", "model_id": TARGET_MODEL,
            "capabilities": ["generate", "edit", "batch"], "workflow_config_id": None, "replacement_model_config_id": None}


def validate_before(before, catalog):
    expected_catalog(before, catalog)
    source_model(before)
    expected_number_state(before, catalog)
    tables = {row["name"]: row for row in before["tables"]}
    require(len(tables) == len(before["tables"]) and CHANGED_TABLES | {"usage_rollup_state", "providers"} <= set(tables)
            and not set(tables) & NEW_TABLES, "054_055_EXACT_PREVIOUS_TABLE_SET_REQUIRED")
    require_unchanged(before["mai27Safety"], SAFETY, "054_055_UNREVIEWED_INSERT_OR_DDL_HOOKS")
    require_unchanged(before["mai27Target"], [], "054_055_TARGET_MODEL_ALREADY_PRESENT")
    require_unchanged(before["mai27OtherModels"], tables["model_configs"], "054_055_OLD_MODEL_PROJECTION_INCOMPLETE")
    require(not set(MIGRATIONS) & {row["name"] for row in before["migrations"]}, "054_055_MIGRATION_ALREADY_PRESENT")


def assert_delta(before, after, catalog):
    validate_before(before, catalog)
    require(set(after) == set(before), "054_055_SNAPSHOT_FIELDS_CHANGED")
    for field in STABLE_FIELDS:
        require_unchanged(before[field], after[field], "054_055_ORIGINAL_" + field.upper() + "_CHANGED")
    number, sequences = expected_number_state(before, catalog)
    for field, expected in {**expected_catalog(before, catalog), **sequences}.items():
        require_unchanged(expected, after[field], "054_055_UNEXPECTED_" + field.upper() + "_DELTA")
    require(after["mai27MaximumPublicNumber"] == number, "054_055_PUBLIC_NUMBER_DELTA_INVALID")
    prior, current = ({row["name"]: row for row in value["tables"]} for value in [before, after])
    require(set(current) == set(prior) | NEW_TABLES and len(current) == len(after["tables"]), "054_055_UNEXPECTED_TABLE_DELTA")
    for name, row in prior.items():
        if name not in CHANGED_TABLES: require_unchanged(row, current[name], "054_055_ORIGINAL_BUSINESS_ROWS_CHANGED")
        else: require(current[name]["count"] == row["count"] + (2 if name == "schema_migrations" else 1), "054_055_SCOPED_TABLE_COUNT_INVALID")
    for name in NEW_TABLES:
        require_unchanged(current[name], {"name": name, "count": 0, "sha256": EMPTY_HASH}, "054_055_CONVERSATIONS_MUST_REMAIN_EMPTY")
    require_unchanged(before["migrations"], [row for row in after["migrations"] if row["name"] not in MIGRATIONS], "054_055_OLD_MIGRATION_ROWS_CHANGED")
    registrations = [row for row in after["migrations"] if row["name"] in MIGRATIONS]
    require(len(registrations) == 2 and [row["name"] for row in registrations] == list(MIGRATIONS)
            and all(set(row) == {"name", "applied_at"} for row in registrations)
            and registrations[0]["applied_at"] == registrations[1]["applied_at"], "054_055_EXACT_MIGRATION_REGISTRATIONS_REQUIRED")
    targets = after["mai27Target"]
    require(isinstance(targets, list) and len(targets) == 1 and isinstance(targets[0], dict), "054_055_ONE_TARGET_MODEL_REQUIRED")
    target, stamp = targets[0], registrations[0]["applied_at"]
    require(isinstance(target.get("id"), str) and str(uuid.UUID(target["id"])) == target["id"], "054_055_NEW_MODEL_UUID_REQUIRED")
    require_unchanged(target, {**expected_model_values(before), "id": target["id"], "public_number": number,
                             "created_at": stamp, "updated_at": stamp}, "054_055_EXACT_SOURCE_PRICE_COPY_REQUIRED")


def validate_source_migrations(database, release, instance):
    names = [row["name"] for row in release["migrations"]]
    require(names[-3:] == [PREVIOUS, *MIGRATIONS] and len(names) == len(set(names)), "054_055_RELEASE_MUST_END_IN_053_054_055")
    retained = instance["retainedMigrationNames"]
    require(not set(retained) & set(MIGRATIONS), "054_055_NEW_MIGRATIONS_CANNOT_BE_RETAINED")
    actual = [row["name"] for row in database["migrations"]]
    require(PREVIOUS in actual and not set(actual) & set(MIGRATIONS) and len(actual) == len(set(actual))
            and set(actual) == set(names[:-2]) | set(retained), "054_055_EXACT_PREVIOUS_MIGRATIONS_REQUIRED")


def verify_package_054_055(package):
    release = verify_package(package)
    rows = release["migrations"]
    require([row["name"] for row in rows[-3:]] == [PREVIOUS, *MIGRATIONS], "054_055_RELEASE_MUST_END_IN_053_054_055")
    for path, row in zip(SQL_PATHS, rows[-2:]):
        require(digest_file(package / path) == row["sha256"], "054_055_SQL_MANIFEST_HASH_MISMATCH")
    for relative in RUNTIME_PATHS:
        require(digest_file(package / relative) == digest_file(TOOLS / Path(relative).name), "054_055_RUNNING_TOOL_DIFFERS_FROM_PACKAGE")
    catalog = read_json(package / CATALOG_PATH)
    validate_catalog(catalog)
    return release, catalog


def payload_hashes(package):
    return {relative: digest_file(package / relative) for relative in [*SQL_PATHS, *RUNTIME_PATHS]}


def validate_preflight(prior, package, instance_path, now=None):
    require(prior.get("kind") == "image-conversations-054-055-preflight"
            and 0 <= (time.time() if now is None else now) - prior.get("createdAt", 0) <= 900, "054_055_FRESH_PREFLIGHT_REQUIRED")
    require(prior.get("instanceSha256") == sha_file(instance_path) and prior.get("manifestSha256") == sha_file(package / "release-manifest.json")
            and prior.get("payloadHashes") == payload_hashes(package) and prior.get("package") == str(package), "054_055_PREFLIGHT_TARGET_CHANGED")


def read_migration_sql(package, release):
    result = []
    for relative, row in zip(SQL_PATHS, release["migrations"][-2:]):
        path = package / relative
        require(path.is_file() and not path.is_symlink() and path.name == row["name"], "054_055_REGULAR_ORDERED_SQL_REQUIRED")
        content = path.read_bytes()
        require(digest(content) == row["sha256"], "054_055_SQL_CHANGED_BEFORE_EXECUTION")
        result.append(content.decode("utf-8"))
    require(len(result) == 2, "054_055_TWO_SQL_PAYLOADS_REQUIRED")
    return result


def guard_sql(before, catalog):
    number, sequences = expected_number_state(before, catalog)
    expected = {**{field: before[field] for field in STABLE_FIELDS}, **expected_catalog(before, catalog), **sequences,
                "mai27MaximumPublicNumber": number}
    checks = " OR ".join(f"actual->'{field}' IS DISTINCT FROM expected->'{field}'" for field in expected)
    migration_names = ",".join("'" + name + "'" for name in MIGRATIONS)
    guards = [f"IF {checks} THEN RAISE EXCEPTION '054_055_CATALOG_OR_ORIGINAL_ROWS_CHANGED'; END IF;",
              f"""IF (SELECT coalesce(jsonb_agg(v ORDER BY v->>'name'),'[]'::jsonb) FROM jsonb_array_elements(actual->'migrations') v WHERE v->>'name' NOT IN ({migration_names})) IS DISTINCT FROM prior->'migrations'
 OR (SELECT count(*) FROM schema_migrations WHERE name IN ({migration_names}) AND applied_at=now())<>2
 THEN RAISE EXCEPTION '054_055_MIGRATION_DELTA_REJECTED'; END IF;""",
              "IF NOT (SELECT count(*)=1 AND bool_and(singleton AND NOT processing_enabled) FROM usage_rollup_state) THEN RAISE EXCEPTION '054_055_STATISTICS_MUST_REMAIN_DISABLED'; END IF;"]
    prior = {row["name"]: row for row in before["tables"]}
    guards.append(f"IF (SELECT jsonb_agg(v->>'name' ORDER BY v->>'name') FROM jsonb_array_elements(actual->'tables') v) IS DISTINCT FROM {support.json_sql(sorted(set(prior) | NEW_TABLES))} THEN RAISE EXCEPTION '054_055_TABLE_SET_CHANGED'; END IF;")
    for name, row in prior.items():
        predicate = f"v->>'name'={support.json_sql(name)}#>>'{{}}'"
        if name not in CHANGED_TABLES:
            guards.append(f"IF (SELECT v FROM jsonb_array_elements(actual->'tables') v WHERE {predicate}) IS DISTINCT FROM {support.json_sql(row)} THEN RAISE EXCEPTION '054_055_ORIGINAL_BUSINESS_ROWS_CHANGED'; END IF;")
        else:
            delta = 2 if name == "schema_migrations" else 1
            guards.append(f"IF (SELECT (v->>'count')::bigint FROM jsonb_array_elements(actual->'tables') v WHERE {predicate}) IS DISTINCT FROM {row['count'] + delta} THEN RAISE EXCEPTION '054_055_SCOPED_TABLE_COUNT_INVALID'; END IF;")
    for name in sorted(NEW_TABLES):
        guards.append(f"IF EXISTS(SELECT 1 FROM public.{name}) THEN RAISE EXCEPTION '054_055_CONVERSATIONS_MUST_REMAIN_EMPTY'; END IF;")
    target = (f"jsonb_build_array({support.json_sql(expected_model_values(before))}||jsonb_build_object("
              f"'id',actual->'mai27Target'->0->'id','public_number',{number},'created_at',now(),'updated_at',now()))")
    guards.append(f"IF actual->'mai27Target' IS DISTINCT FROM {target} THEN RAISE EXCEPTION '054_055_EXACT_SOURCE_PRICE_COPY_REQUIRED'; END IF;")
    return f"DO $conversations054055guard$ DECLARE actual jsonb; prior jsonb := {support.json_sql(before)}; expected jsonb := {support.json_sql(expected)}; BEGIN actual := ({snapshot_query()});\n" + "\n".join(guards) + "\nEND $conversations054055guard$;"


def migration_sql(before, catalog, sqls):
    validate_before(before, catalog)
    require(isinstance(sqls, list) and len(sqls) == 2 and all(isinstance(sql, str) and sql.strip() for sql in sqls), "054_055_TWO_FIXED_SQL_PAYLOADS_REQUIRED")
    identifiers = ",".join('public."' + row["name"].replace('"', '""') + '"' for row in before["tables"])
    body = "\n".join(sql + f"\nINSERT INTO schema_migrations(name) VALUES('{name}');" for name, sql in zip(MIGRATIONS, sqls))
    return ("BEGIN; SET LOCAL search_path=public; SET LOCAL row_security=off; SET LOCAL standard_conforming_strings=on; "
            "SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='300s'; SET LOCAL idle_in_transaction_session_timeout='330s';\n"
            f"LOCK TABLE {identifiers} IN SHARE MODE;\n"
            f"DO $conversations054055before$ DECLARE actual jsonb; prior jsonb := {support.json_sql(before)}; BEGIN actual := ({snapshot_query()}); "
            "IF actual IS DISTINCT FROM prior THEN RAISE EXCEPTION '054_055_STOPPED_BASELINE_DRIFT'; END IF; "
            "IF NOT (SELECT count(*)=1 AND bool_and(singleton AND NOT processing_enabled) FROM usage_rollup_state) THEN RAISE EXCEPTION '054_055_STATISTICS_MUST_REMAIN_DISABLED'; END IF; END $conversations054055before$;\n"
            + body + "\n" + guard_sql(before, catalog) + "\nCOMMIT;\n")


class ImageConversations054055(support.Usage048):
    def sql(self, name, label):
        if name != "database-state.sql": return super().sql(name, label)
        value = self.raw_sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; SET LOCAL row_security=off; SET LOCAL statement_timeout='60s';\n" + snapshot_query() + ";\nCOMMIT;", label)
        return json.loads(value)

    def preflight_054_055(self, package):
        release, catalog = verify_package_054_055(package)
        self.new_audit("image-conversations-054-055-preflight")
        self.assert_platform(release)
        current = self.capture("054-055-preflight")
        require(current["database"]["identity"]["database"] == self.instance["database"]["name"], "054_055_DATABASE_NAME_MISMATCH")
        validate_source_migrations(current["database"], release, self.instance)
        validate_before(current["database"], catalog)
        self.disabled("054-055-preflight-statistics-unchanged")
        self.gate("verify-open")
        write_new_json(self.audit / "preflight.json", {"schema": 1, "kind": "image-conversations-054-055-preflight", "createdAt": time.time(),
                       "instanceSha256": sha_file(self.instance_path), "manifestSha256": sha_file(package / "release-manifest.json"),
                       "payloadHashes": payload_hashes(package), "package": str(package), "baseline": current})
        return {"status": "054-055-preflight-passed", "audit": str(self.audit), "mutations": False,
                "nativeSequenceAdvance": {"name": NUMBER_SEQUENCE, "steps": 1, "transactional": False}}

    def migrate_054_055(self, package, preflight):
        release, catalog = verify_package_054_055(package)
        prior = read_json(private_directory(preflight) / "preflight.json")
        validate_preflight(prior, package, self.instance_path)
        self.new_audit("image-conversations-054-055-migrate")
        phase = "preparation"
        try:
            current = self.capture("054-055-migrate")
            require_unchanged(prior["baseline"]["configurationHashes"], current["configurationHashes"], "054_055_CONFIGURATION_DRIFT")
            assert_database_layout(prior["baseline"]["database"], current["database"])
            for field in DEPENDENCY_FIELDS:
                require_unchanged(prior["baseline"]["database"][field], current["database"][field], "054_055_DEPENDENCY_DRIFT_SINCE_PREFLIGHT")
            assert_rollback_source(current["model"], prior["baseline"]["model"], current["containers"], prior["baseline"]["containers"], self.instance)
            validate_source_migrations(current["database"], release, self.instance)
            validate_before(current["database"], catalog)
            self.assert_platform(release)
            self.disabled("054-055-before-maintenance-statistics-unchanged")
            require(shutil.disk_usage(self.root).free >= self.instance["minimumFreeBytes"], "INSUFFICIENT_DISK_SPACE")
            self.preparation_unchanged(current)
            self.gate("verify-open")
            phase = "maintenance"
            self.gate("close"); self.gate("verify-closed")
            self.wait_for_drain()
            model = self.audit / "original.private.json"
            write_new_json(model, compose_literals(current["model"]))
            baseline = self.freeze_stopped_baseline(current, self.stop_app(model))
            for field in DEPENDENCY_FIELDS:
                require_unchanged(current["database"][field], baseline["database"][field], "054_055_DEPENDENCY_DRIFT_DURING_DRAIN")
            validate_before(baseline["database"], catalog)
            self.disabled("054-055-stopped-statistics-unchanged")
            self.backup_048()
            self.protected_and_database(baseline, "054-055-before-sql")
            validate_preflight(prior, package, self.instance_path)
            sqls = read_migration_sql(package, release)
            phase = "sql-outcome-unknown-until-verified"
            self.raw_sql(migration_sql(baseline["database"], catalog, sqls), "054-055-transaction", timeout=360)
            after = self.sql("database-state.sql", "054-055-after-sql")
            assert_delta(baseline["database"], after, catalog)
            self.disabled("054-055-after-sql-statistics-unchanged")
            assert_protected(baseline["containers"], self.inventory("054-055-after-sql"), self.instance)
            write_new_json(self.audit / "schema-after.private.json", after)
            phase = "schema-committed-original-start-pending"
            self.application_configuration_unchanged(baseline)
            self.start_original(baseline)
            self.wait_health(self.instance["localBaseUrl"])
            self.command(["docker", "exec", self.instance["containers"]["worker"], "bun", "src/worker-healthcheck.ts"])
            running = self.inventory("054-055-original-started")
            support.assert_same_original(baseline["containers"], running, baseline["model"], self.instance, True)
            assert_protected(baseline["containers"], running, self.instance)
            require_unchanged(after, self.sql("database-state.sql", "054-055-original-verified"), "054_055_DATABASE_CHANGED_DURING_ORIGINAL_RESTART")
            self.disabled("054-055-original-statistics-unchanged")
            assert_idle(self.sql("activity.sql", "054-055-original-idle"))
            self.application_configuration_unchanged(baseline)
            phase = "verified-gate-reopen-pending"
            self.gate("open"); self.gate("verify-open")
            self.wait_health(self.instance["publicBaseUrl"])
            receipt = {"schema": 1, "status": "054-055-migrated-empty-conversations-source-priced-model", "audit": str(self.audit),
                       "instanceSha256": sha_file(self.instance_path), "manifestSha256": sha_file(package / "release-manifest.json"),
                       "payloadHashes": payload_hashes(package), "databaseIdentity": after["identity"],
                       "originalContainerIds": {role: container_map(running)[name]["Id"] for role, name in self.instance["containers"].items()},
                       "existingBusinessRowsPreserved": True, "emptyConversationTables": sorted(NEW_TABLES),
                       "newModelConfigId": after["mai27Target"][0]["id"], "newModelPublicNumber": after["mai27Target"][0]["public_number"],
                       "nativeSequenceAdvance": {"name": NUMBER_SEQUENCE, "steps": 1, "transactional": False},
                       "featureFlagChanged": False, "plannerConfigurationChanged": False, "processingEnabled": False, "normalIngressRestored": True}
            write_new_json(self.audit / "receipt.json", receipt)
            return receipt
        except Exception:
            write_new_json(self.audit / "failure.json", {"status": "failed", "phase": phase, "manualReviewRequired": True,
                           "automaticRetry": False, "automaticRestore": False, "automaticSequenceReset": False,
                           "nativeSequenceMayHaveAdvanced": phase not in ("preparation", "maintenance"),
                           "nativeSequenceName": NUMBER_SEQUENCE, "maintenanceMayBeClosed": phase != "preparation"})
            raise


def main():
    parser = argparse.ArgumentParser(description="Fixed 054/055 only; no feature flag, planner binding, old model or price changes")
    parser.add_argument("operation", choices=["preflight", "migrate"])
    parser.add_argument("instance"); parser.add_argument("package"); parser.add_argument("prior_audit", nargs="?")
    args = parser.parse_args()
    require(sys.platform == "linux", "LINUX_DEPLOYMENT_HOST_REQUIRED")
    require(not os.environ.get("DOCKER_HOST"), "EXPLICIT_LOCAL_DOCKER_REQUIRED")
    os.umask(0o077)
    package = Path(args.package)
    require(package.is_absolute() and package.is_dir() and not package.is_symlink(), "ABSOLUTE_PACKAGE_REQUIRED")
    require((args.prior_audit is not None) == (args.operation == "migrate"), "EXACT_PRIOR_AUDIT_ARGUMENT_REQUIRED")
    runner = ImageConversations054055(args.instance)
    result = runner.preflight_054_055(package) if args.operation == "preflight" else runner.migrate_054_055(package, Path(args.prior_audit))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try: main()
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        error = sys.exc_info()[1]
        print("IMAGE_CONVERSATIONS_054_055_REJECTED " + (str(error) if isinstance(error, Rejected) else "PRIVATE_OPERATION_FAILED"), file=sys.stderr)
        sys.exit(1)
