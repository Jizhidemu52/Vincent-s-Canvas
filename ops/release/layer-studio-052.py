#!/usr/bin/env python3
"""Fixed 052 preparation only; zero-DB application image deployment is unchanged.

No arbitrary SQL input, model binding, price configuration, statistics enablement,
automatic retry, database restore or image/container replacement.
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from contract import (Rejected, assert_database_layout, assert_idle, assert_protected,
                      container_map, digest, digest_file, read_json, require, verify_package, write_new_json)
from deploy import assert_rollback_source, compose_literals, private_directory, require_unchanged, sha_file

TOOLS = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("layer_studio_052_support", TOOLS / "usage-048.py")
support = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(support)
MIGRATION = "052_layer_studio.sql"
PREVIOUS = "051_new_creative_scenes.sql"
SQL_PATH = "server/src/migrations/" + MIGRATION
CATALOG_PATH = "ops/release/layer-studio-052-catalog.json"
STATE_PATH = "ops/release/layer-studio-052-state.sql"
NEW_TABLE = "layer_studio_prices"
OUTPUT_COLUMNS = {"result_document", "upstream_result_document"}
SORT_KEYS = support.SORT_KEYS
REPLACEMENTS = {("module_flags", "module_flags_module_key_check"),
                ("tool_api_configurations", "tool_api_configurations_tool_key_check")}
SEEDS = {
    "module_flags": {"values": {"module_key": "layer-studio", "enabled": False, "updated_by": None}, "timestamps": ["updated_at"]},
    "tool_api_configurations": {"values": {"tool_key": "layer-studio", "model_config_id": None, "enabled": False,
        "updated_by": None, "credit_cost_override": None, "rmb_cost_override": None,
        "configuration_version": 1, "allow_raw_prompt": False}, "timestamps": ["created_at", "updated_at"]},
}
CHANGED_TABLES = {"tasks", "schema_migrations", *SEEDS}
SAFETY = {"enabledEventTriggers": 0, "seedTableTriggers": 0, "seedTableRules": 0, "seedTableRls": 0}
RUNTIME_PATHS = ["ops/release/layer-studio-052.py", CATALOG_PATH, STATE_PATH,
                 "ops/release/usage-048.py", "ops/release/usage-048-state.sql", "ops/release/database-state.sql",
                 "ops/release/contract.py", "ops/release/deploy.py", "ops/release/activity.sql", "ops/release/maintenance.sql"]


def snapshot_query():
    extra = (TOOLS / Path(STATE_PATH).name).read_text(encoding="utf-8").strip().rstrip(";")
    return f"WITH b(snapshot) AS ({support.snapshot_query()}), s(snapshot) AS ({extra}) SELECT b.snapshot||s.snapshot FROM b,s"


def validate_catalog(catalog):
    require(isinstance(catalog, dict) and set(catalog) == {"schema", "replacements", "additions", "seedColumns", "seeds"}
            and catalog["schema"] == 1 and catalog["seeds"] == SEEDS, "052_FIXED_CATALOG_REQUIRED")
    rows = catalog["replacements"]
    require(isinstance(rows, list) and len(rows) == 2, "052_TWO_CHECK_REPLACEMENTS_REQUIRED")
    for side in ["before", "after"]:
        require(all(isinstance(row, dict) and set(row) == {"before", "after"} and isinstance(row[side], dict)
                    and set(row[side]) == {"relation", "name", "type", "definition"} and row[side]["type"] == "c"
                    and isinstance(row[side]["definition"], str) for row in rows), "052_CHECK_CATALOG_INVALID")
        require({(row[side]["relation"], row[side]["name"]) for row in rows} == REPLACEMENTS, "052_CHECK_IDENTITIES_INVALID")
    added = catalog["additions"]
    support.catalog_union({field: [] for field in SORT_KEYS}, added)
    require({row["table_name"] for row in added["columns"]} == {"tasks", NEW_TABLE}
            and {row["column_name"] for row in added["columns"] if row["table_name"] == "tasks"} == OUTPUT_COLUMNS
            and {row["tablename"] for row in added["indexes"]} == {NEW_TABLE}
            and {row["relation"] for row in added["constraints"]} == {"tasks", NEW_TABLE}
            and not added["functions"] and not added["triggers"], "052_ADDITIVE_CATALOG_SURFACE_INVALID")
    require(all(row["data_type"] == "jsonb" and row["udt_name"] == "jsonb" and row["is_nullable"] == "YES"
                and row["column_default"] is None for row in added["columns"] if row["table_name"] == "tasks"), "052_NULL_OUTPUT_COLUMNS_REQUIRED")
    require(isinstance(catalog["seedColumns"], list) and {row["table_name"] for row in catalog["seedColumns"]} == set(SEEDS) | {"schema_migrations"}, "052_SEED_COLUMN_CATALOG_REQUIRED")


def expected_catalog(before, catalog):
    validate_catalog(catalog)
    result = {field: copy.deepcopy(before[field]) for field in SORT_KEYS}
    for replacement in catalog["replacements"]:
        identity = (replacement["before"]["relation"], replacement["before"]["name"])
        require(identity == (replacement["after"]["relation"], replacement["after"]["name"]), "052_CHECK_REPLACEMENT_IDENTITY_CHANGED")
        matches = [index for index, row in enumerate(result["constraints"]) if (row["relation"], row["name"]) == identity]
        require(len(matches) == 1 and result["constraints"][matches[0]] == replacement["before"], "052_EXACT_051_CHECK_REQUIRED")
        result["constraints"][matches[0]] = copy.deepcopy(replacement["after"])
    seed_columns = [row for row in before["columns"] if row["table_name"] in set(SEEDS) | {"schema_migrations"}]
    require_unchanged(seed_columns, catalog["seedColumns"], "052_SEED_TABLE_SCHEMA_OR_DEFAULTS_CHANGED")
    require(not any(row["table_name"] == "tasks" and row["column_name"] in OUTPUT_COLUMNS for row in before["columns"]), "052_OUTPUT_COLUMN_ALREADY_PRESENT")
    return support.catalog_union(result, catalog["additions"])


def validate_before(before, catalog):
    expected_catalog(before, catalog)
    tables = {row["name"]: row for row in before["tables"]}
    require(NEW_TABLE not in tables and CHANGED_TABLES | {"usage_rollup_state"} <= set(tables), "052_EXACT_PREVIOUS_TABLE_SET_REQUIRED")
    require_unchanged(before["layerStudioSafety"], SAFETY, "052_UNREVIEWED_INSERT_OR_DDL_HOOKS")
    require_unchanged(before["layerStudioSeeds"], {name: [] for name in SEEDS}, "052_SEED_ALREADY_PRESENT")
    require(before["layerStudioNonNullOutputs"] == 0, "052_NEW_OUTPUTS_MUST_BE_NULL")
    require_unchanged(before["layerStudioOriginalTasks"], tables["tasks"], "052_ORIGINAL_TASK_PROJECTION_INCOMPLETE")
    require_unchanged(before["layerStudioOtherRows"], [tables[name] for name in sorted(SEEDS)], "052_OLD_CONFIG_PROJECTION_INCOMPLETE")
    require(MIGRATION not in {row["name"] for row in before["migrations"]}, "052_MIGRATION_ALREADY_PRESENT")


def assert_delta(before, after, catalog):
    validate_before(before, catalog)
    require(set(after) == set(before), "052_SNAPSHOT_FIELDS_CHANGED")
    for field in ["identity", "sequences", "sequenceStates", "layerStudioSafety", "layerStudioOriginalTasks", "layerStudioOtherRows"]:
        require_unchanged(before[field], after[field], "052_ORIGINAL_" + field.upper() + "_CHANGED")
    for field, expected in expected_catalog(before, catalog).items():
        require_unchanged(expected, after[field], "052_UNEXPECTED_" + field.upper() + "_DELTA")
    prior, current = ({row["name"]: row for row in value["tables"]} for value in [before, after])
    require(set(current) == set(prior) | {NEW_TABLE} and len(current) == len(after["tables"]), "052_UNEXPECTED_TABLE_DELTA")
    for name, row in prior.items():
        if name not in CHANGED_TABLES: require_unchanged(row, current[name], "052_ORIGINAL_BUSINESS_ROWS_CHANGED")
        else: require(current[name]["count"] == row["count"] + (0 if name == "tasks" else 1), "052_SCOPED_TABLE_COUNT_INVALID")
    require(after["layerStudioNonNullOutputs"] == 0 and current[NEW_TABLE]["count"] == 0, "052_OUTPUTS_OR_PRICES_NOT_EMPTY")
    require_unchanged(before["migrations"], [row for row in after["migrations"] if row["name"] != MIGRATION], "052_OLD_MIGRATION_ROWS_CHANGED")
    registrations = [row for row in after["migrations"] if row["name"] == MIGRATION]
    require(len(registrations) == 1 and set(registrations[0]) == {"name", "applied_at"}, "052_EXACT_MIGRATION_REGISTRATION_REQUIRED")
    stamp = registrations[0]["applied_at"]
    expected_seeds = {name: [{**seed["values"], **{key: stamp for key in seed["timestamps"]}}] for name, seed in SEEDS.items()}
    require_unchanged(expected_seeds, after["layerStudioSeeds"], "052_EXACT_DISABLED_UNBOUND_SEEDS_REQUIRED")


def validate_source_migrations(database, release, instance):
    names = [row["name"] for row in release["migrations"]]
    require(names[-2:] == [PREVIOUS, MIGRATION], "052_RELEASE_MUST_END_IN_051_052")
    expected = set(names[:-1]) | set(instance["retainedMigrationNames"])
    actual = [row["name"] for row in database["migrations"]]
    require(PREVIOUS in actual and MIGRATION not in actual and len(actual) == len(set(actual)) and set(actual) == expected, "052_EXACT_PREVIOUS_MIGRATIONS_REQUIRED")


def verify_052_package(package):
    release = verify_package(package)
    rows = release["migrations"]
    require([row["name"] for row in rows[-2:]] == [PREVIOUS, MIGRATION], "052_RELEASE_MUST_END_IN_051_052")
    require(digest_file(package / SQL_PATH) == rows[-1]["sha256"], "052_SQL_MANIFEST_HASH_MISMATCH")
    for relative in RUNTIME_PATHS:
        require(digest_file(package / relative) == digest_file(TOOLS / Path(relative).name), "052_RUNNING_TOOL_DIFFERS_FROM_PACKAGE")
    catalog = read_json(package / CATALOG_PATH)
    validate_catalog(catalog)
    return release, catalog


def payload_hashes(package):
    return {relative: digest_file(package / relative) for relative in [SQL_PATH, *RUNTIME_PATHS]}


def validate_preflight(prior, package, instance_path, now=None):
    require(prior.get("kind") == "layer-studio-052-preflight" and 0 <= (time.time() if now is None else now) - prior.get("createdAt", 0) <= 900, "052_FRESH_PREFLIGHT_REQUIRED")
    require(prior.get("instanceSha256") == sha_file(instance_path) and prior.get("manifestSha256") == sha_file(package / "release-manifest.json")
            and prior.get("payloadHashes") == payload_hashes(package) and prior.get("package") == str(package), "052_PREFLIGHT_TARGET_CHANGED")


def read_migration_sql(package, release):
    path = package / SQL_PATH
    require(path.is_file() and not path.is_symlink(), "052_REGULAR_SQL_REQUIRED")
    content = path.read_bytes()
    require(digest(content) == release["migrations"][-1]["sha256"], "052_SQL_CHANGED_BEFORE_EXECUTION")
    return content.decode("utf-8")


def guard_sql(before, catalog):
    fields = [*SORT_KEYS, "identity", "sequences", "sequenceStates", "layerStudioOriginalTasks", "layerStudioOtherRows", "layerStudioSafety"]
    expected = {**{field: before[field] for field in fields}, **expected_catalog(before, catalog)}
    checks = " OR ".join(f"actual->'{field}' IS DISTINCT FROM expected->'{field}'" for field in fields)
    guards = [f"IF {checks} THEN RAISE EXCEPTION '052_CATALOG_OR_ORIGINAL_ROWS_CHANGED'; END IF;",
              f"IF actual->'layerStudioNonNullOutputs' IS DISTINCT FROM '0'::jsonb OR EXISTS(SELECT 1 FROM {NEW_TABLE}) THEN RAISE EXCEPTION '052_OUTPUTS_OR_PRICES_NOT_EMPTY'; END IF;",
              f"""IF (SELECT coalesce(jsonb_agg(v ORDER BY v->>'name'),'[]'::jsonb) FROM jsonb_array_elements(actual->'migrations') v WHERE v->>'name'<>'{MIGRATION}') IS DISTINCT FROM prior->'migrations'
 OR (SELECT count(*) FROM schema_migrations WHERE name='{MIGRATION}' AND applied_at=now())<>1
 THEN RAISE EXCEPTION '052_MIGRATION_DELTA_REJECTED'; END IF;""",
              "IF NOT (SELECT count(*)=1 AND bool_and(singleton AND NOT processing_enabled) FROM usage_rollup_state) THEN RAISE EXCEPTION '052_STATISTICS_MUST_REMAIN_DISABLED'; END IF;"]
    prior = {row["name"]: row for row in before["tables"]}
    expected_names = sorted([*prior, NEW_TABLE])
    guards.append(f"IF (SELECT jsonb_agg(v->>'name' ORDER BY v->>'name') FROM jsonb_array_elements(actual->'tables') v) IS DISTINCT FROM {support.json_sql(expected_names)} THEN RAISE EXCEPTION '052_TABLE_SET_CHANGED'; END IF;")
    for name, row in prior.items():
        predicate = f"v->>'name'={support.json_sql(name)}#>>'{{}}'"
        if name not in CHANGED_TABLES:
            guards.append(f"IF (SELECT v FROM jsonb_array_elements(actual->'tables') v WHERE {predicate}) IS DISTINCT FROM {support.json_sql(row)} THEN RAISE EXCEPTION '052_ORIGINAL_BUSINESS_ROWS_CHANGED'; END IF;")
        else:
            count = row["count"] + (0 if name == "tasks" else 1)
            guards.append(f"IF (SELECT (v->>'count')::bigint FROM jsonb_array_elements(actual->'tables') v WHERE {predicate}) IS DISTINCT FROM {count} THEN RAISE EXCEPTION '052_SCOPED_TABLE_COUNT_INVALID'; END IF;")
    for name, seed in SEEDS.items():
        stamp_fields = ",".join("'" + key + "',now()" for key in seed["timestamps"])
        desired = f"jsonb_build_array({support.json_sql(seed['values'])}||jsonb_build_object({stamp_fields}))"
        guards.append(f"IF actual->'layerStudioSeeds'->'{name}' IS DISTINCT FROM {desired} THEN RAISE EXCEPTION '052_EXACT_DISABLED_UNBOUND_SEEDS_REQUIRED'; END IF;")
    return f"DO $layer052guard$ DECLARE actual jsonb; prior jsonb := {support.json_sql(before)}; expected jsonb := {support.json_sql(expected)}; BEGIN actual := ({snapshot_query()});\n" + "\n".join(guards) + "\nEND $layer052guard$;"


def migration_sql(before, catalog, sql):
    validate_before(before, catalog)
    tables = [row["name"] for row in before["tables"]]
    identifiers = ",".join('public."' + name.replace('"', '""') + '"' for name in tables)
    return ("BEGIN; SET LOCAL search_path=public; SET LOCAL row_security=off; SET LOCAL standard_conforming_strings=on; "
            "SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='300s'; SET LOCAL idle_in_transaction_session_timeout='330s';\n"
            f"LOCK TABLE {identifiers} IN SHARE MODE;\n"
            f"DO $layer052before$ DECLARE actual jsonb; prior jsonb := {support.json_sql(before)}; BEGIN actual := ({snapshot_query()}); "
            "IF actual IS DISTINCT FROM prior THEN RAISE EXCEPTION '052_STOPPED_BASELINE_DRIFT'; END IF; "
            "IF NOT (SELECT count(*)=1 AND bool_and(singleton AND NOT processing_enabled) FROM usage_rollup_state) THEN RAISE EXCEPTION '052_STATISTICS_MUST_REMAIN_DISABLED'; END IF; END $layer052before$;\n"
            + sql + f"\nINSERT INTO schema_migrations(name) VALUES('{MIGRATION}');\n" + guard_sql(before, catalog) + "\nCOMMIT;\n")


class LayerStudio052(support.Usage048):
    def sql(self, name, label):
        if name != "database-state.sql": return super().sql(name, label)
        value = self.raw_sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; SET LOCAL row_security=off; SET LOCAL statement_timeout='60s';\n" + snapshot_query() + ";\nCOMMIT;", label)
        return json.loads(value)

    def preflight_052(self, package):
        release, catalog = verify_052_package(package)
        self.new_audit("layer-studio-052-preflight")
        self.assert_platform(release)
        current = self.capture("052-preflight")
        require(current["database"]["identity"]["database"] == self.instance["database"]["name"], "052_DATABASE_NAME_MISMATCH")
        validate_source_migrations(current["database"], release, self.instance)
        validate_before(current["database"], catalog)
        self.disabled("052-preflight-statistics-unchanged")
        self.gate("verify-open")
        write_new_json(self.audit / "preflight.json", {"schema": 1, "kind": "layer-studio-052-preflight", "createdAt": time.time(),
                       "instanceSha256": sha_file(self.instance_path), "manifestSha256": sha_file(package / "release-manifest.json"),
                       "payloadHashes": payload_hashes(package), "package": str(package), "baseline": current})
        return {"status": "052-preflight-passed", "audit": str(self.audit), "mutations": False}

    def migrate_052(self, package, preflight):
        release, catalog = verify_052_package(package)
        prior = read_json(private_directory(preflight) / "preflight.json")
        validate_preflight(prior, package, self.instance_path)
        self.new_audit("layer-studio-052-migrate")
        phase = "preparation"
        try:
            current = self.capture("052-migrate")
            require_unchanged(prior["baseline"]["configurationHashes"], current["configurationHashes"], "052_CONFIGURATION_DRIFT")
            assert_database_layout(prior["baseline"]["database"], current["database"])
            for field in ["functions", "triggers", "layerStudioSafety"]:
                require_unchanged(prior["baseline"]["database"][field], current["database"][field], "052_CATALOG_DRIFT_SINCE_PREFLIGHT")
            assert_rollback_source(current["model"], prior["baseline"]["model"], current["containers"], prior["baseline"]["containers"], self.instance)
            validate_source_migrations(current["database"], release, self.instance)
            validate_before(current["database"], catalog)
            self.assert_platform(release)
            self.disabled("052-before-maintenance-statistics-unchanged")
            require(shutil.disk_usage(self.root).free >= self.instance["minimumFreeBytes"], "INSUFFICIENT_DISK_SPACE")
            self.preparation_unchanged(current)
            self.gate("verify-open")
            phase = "maintenance"
            self.gate("close"); self.gate("verify-closed")
            self.wait_for_drain()
            model = self.audit / "original.private.json"
            write_new_json(model, compose_literals(current["model"]))
            baseline = self.freeze_stopped_baseline(current, self.stop_app(model))
            for field in ["functions", "triggers", "layerStudioSafety"]:
                require_unchanged(current["database"][field], baseline["database"][field], "052_CATALOG_DRIFT_DURING_DRAIN")
            validate_before(baseline["database"], catalog)
            self.disabled("052-stopped-statistics-unchanged")
            self.backup_048()
            self.protected_and_database(baseline, "052-before-sql")
            # Rebind every runtime source and the exact SQL bytes after drain/backup.
            validate_preflight(prior, package, self.instance_path)
            sql = read_migration_sql(package, release)
            phase = "sql-outcome-unknown-until-verified"
            self.raw_sql(migration_sql(baseline["database"], catalog, sql), "052-transaction", timeout=360)
            after = self.sql("database-state.sql", "052-after-sql")
            assert_delta(baseline["database"], after, catalog)
            self.disabled("052-after-sql-statistics-unchanged")
            assert_protected(baseline["containers"], self.inventory("052-after-sql"), self.instance)
            write_new_json(self.audit / "schema-after.private.json", after)
            phase = "schema-committed-original-start-pending"
            self.application_configuration_unchanged(baseline)
            self.start_original(baseline)
            self.wait_health(self.instance["localBaseUrl"])
            self.command(["docker", "exec", self.instance["containers"]["worker"], "bun", "src/worker-healthcheck.ts"])
            running = self.inventory("052-original-started")
            support.assert_same_original(baseline["containers"], running, baseline["model"], self.instance, True)
            assert_protected(baseline["containers"], running, self.instance)
            require_unchanged(after, self.sql("database-state.sql", "052-original-verified"), "052_DATABASE_CHANGED_DURING_ORIGINAL_RESTART")
            self.disabled("052-original-statistics-unchanged")
            assert_idle(self.sql("activity.sql", "052-original-idle"))
            self.application_configuration_unchanged(baseline)
            phase = "verified-gate-reopen-pending"
            self.gate("open"); self.gate("verify-open")
            self.wait_health(self.instance["publicBaseUrl"])
            receipt = {"schema": 1, "status": "052-migrated-disabled-unbound", "audit": str(self.audit),
                       "instanceSha256": sha_file(self.instance_path), "manifestSha256": sha_file(package / "release-manifest.json"),
                       "payloadHashes": payload_hashes(package), "databaseIdentity": after["identity"],
                       "originalContainerIds": {role: container_map(running)[name]["Id"] for role, name in self.instance["containers"].items()},
                       "existingBusinessRowsPreserved": True, "originalTaskColumnsPreserved": True, "newOutputColumnsNull": True,
                       "pricesEmpty": True, "featureEnabled": False, "modelBound": False, "processingEnabled": False, "normalIngressRestored": True}
            write_new_json(self.audit / "receipt.json", receipt)
            return receipt
        except Exception:
            write_new_json(self.audit / "failure.json", {"status": "failed", "phase": phase, "manualReviewRequired": True,
                           "automaticRetry": False, "automaticRestore": False, "maintenanceMayBeClosed": phase != "preparation"})
            raise


def main():
    parser = argparse.ArgumentParser(description="Fixed 052 schema preparation only; never bind models, set prices or enable statistics")
    parser.add_argument("operation", choices=["preflight", "migrate"])
    parser.add_argument("instance"); parser.add_argument("package"); parser.add_argument("prior_audit", nargs="?")
    args = parser.parse_args()
    require(sys.platform == "linux", "LINUX_DEPLOYMENT_HOST_REQUIRED")
    require(not os.environ.get("DOCKER_HOST"), "EXPLICIT_LOCAL_DOCKER_REQUIRED")
    os.umask(0o077)
    package = Path(args.package)
    require(package.is_absolute() and package.is_dir() and not package.is_symlink(), "ABSOLUTE_PACKAGE_REQUIRED")
    require((args.prior_audit is not None) == (args.operation == "migrate"), "EXACT_PRIOR_AUDIT_ARGUMENT_REQUIRED")
    runner = LayerStudio052(args.instance)
    result = runner.preflight_052(package) if args.operation == "preflight" else runner.migrate_052(package, Path(args.prior_audit))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try: main()
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        error = sys.exc_info()[1]
        print("LAYER_STUDIO_052_REJECTED " + (str(error) if isinstance(error, Rejected) else "PRIVATE_OPERATION_FAILED"), file=sys.stderr)
        sys.exit(1)
