#!/usr/bin/env python3
"""Fixed, additive quick-image configuration schema preparation.

No arbitrary SQL, config writes, analytics enablement or image switching. The
existing zero-database-change application deployment contract is unchanged.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from contract import (Rejected, assert_database_layout, assert_idle, assert_protected,
                      container_map, digest_file, read_json, require, verify_package, write_new_json)
from deploy import (assert_rollback_source, compose_literals, private_directory,
                    require_unchanged, sha_file)

TOOLS = Path(__file__).resolve().parent
# Reuse the audited snapshot, backup and same-container restart helpers only.
# Neither the 048 migration method nor its processing-control method is called.
_spec = importlib.util.spec_from_file_location("quick_image_schema_support", TOOLS / "usage-048.py")
support = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(support)

MIGRATION = "049_quick_image_configurations.sql"
SQL_PATH = "server/src/migrations/" + MIGRATION
CATALOG_PATH = "ops/release/quick-image-049-catalog.json"
NEW_TABLE = "quick_image_configurations"
SORT_KEYS = support.SORT_KEYS


def assert_049_delta(before, after, catalog):
    for field in ["identity", "sequences", "sequenceStates"]:
        require_unchanged(before[field], after[field], "049_ORIGINAL_" + field.upper() + "_CHANGED")
    for field, expected in support.catalog_union(before, catalog).items():
        require_unchanged(expected, after[field], "049_UNEXPECTED_" + field.upper() + "_DELTA")
    prior = {row["name"]: row for row in before["tables"]}
    current = {row["name"]: row for row in after["tables"]}
    require(NEW_TABLE not in prior and set(current) == set(prior) | {NEW_TABLE}, "049_UNEXPECTED_TABLE_DELTA")
    for name, row in prior.items():
        if name != "schema_migrations": require_unchanged(row, current[name], "049_ORIGINAL_BUSINESS_ROWS_CHANGED")
    require_unchanged(before["migrations"], [row for row in after["migrations"] if row["name"] != MIGRATION], "049_OLD_MIGRATION_ROWS_CHANGED")
    require(sum(row["name"] == MIGRATION for row in after["migrations"]) == 1, "049_MIGRATION_REGISTRATION_REQUIRED")
    require(current["schema_migrations"]["count"] == prior["schema_migrations"]["count"] + 1, "049_MIGRATION_ROW_DELTA_INVALID")
    require(current[NEW_TABLE]["count"] == 0, "049_SETTINGS_MUST_REMAIN_EMPTY")


def verify_049_package(package):
    release = verify_package(package)
    rows = [row for row in release["migrations"] if row["name"] == MIGRATION]
    require(len(rows) == 1 and release["migrations"][-1]["name"] == MIGRATION, "ONLY_RELEASE_ENDING_IN_049_SUPPORTED")
    require(digest_file(package / SQL_PATH) == rows[0]["sha256"], "049_SQL_MANIFEST_HASH_MISMATCH")
    for relative in ["ops/release/quick-image-049.py", CATALOG_PATH, "ops/release/usage-048.py",
                     "ops/release/usage-048-state.sql", "ops/release/database-state.sql",
                     "ops/release/contract.py", "ops/release/deploy.py"]:
        require(digest_file(package / relative) == digest_file(TOOLS / Path(relative).name), "049_RUNNING_TOOL_DIFFERS_FROM_PACKAGE")
    catalog = read_json(package / CATALOG_PATH)
    support.catalog_union({field: [] for field in SORT_KEYS}, catalog)
    require({row["table_name"] for row in catalog["columns"]} == {NEW_TABLE}
            and {row["tablename"] for row in catalog["indexes"]} == {NEW_TABLE}
            and {row["relation"] for row in catalog["constraints"]} == {NEW_TABLE}
            and not catalog["functions"] and not catalog["triggers"], "049_FIXED_TABLE_CATALOG_REQUIRED")
    return release, catalog


def validate_source_migrations(database, release, instance):
    expected = {row["name"] for row in release["migrations"] if row["name"] != MIGRATION} | set(instance["retainedMigrationNames"])
    actual = [row["name"] for row in database["migrations"]]
    require(MIGRATION not in actual and len(actual) == len(set(actual)) and set(actual) == expected, "049_EXACT_PREVIOUS_MIGRATIONS_REQUIRED")


def guard_sql(before, catalog):
    fields = " OR ".join(f"actual->'{key}' IS DISTINCT FROM expected->'{key}'" for key in SORT_KEYS)
    return f"""DO $canvas049guard$
DECLARE actual jsonb; prior jsonb := {support.json_sql(before)}; expected jsonb := {support.json_sql(support.catalog_union(before, catalog))};
BEGIN
 actual := ({support.snapshot_query()});
 IF actual->'identity' IS DISTINCT FROM prior->'identity' OR actual->'sequences' IS DISTINCT FROM prior->'sequences'
    OR actual->'sequenceStates' IS DISTINCT FROM prior->'sequenceStates' OR {fields}
 THEN RAISE EXCEPTION '049_CATALOG_IDENTITY_OR_SEQUENCE_DELTA_REJECTED'; END IF;
 IF (SELECT coalesce(jsonb_agg(v ORDER BY v->>'name'),'[]'::jsonb) FROM jsonb_array_elements(actual->'migrations') v WHERE v->>'name'<>'{MIGRATION}') IS DISTINCT FROM prior->'migrations'
    OR (SELECT count(*) FROM jsonb_array_elements(actual->'migrations') v WHERE v->>'name'='{MIGRATION}')<>1
 THEN RAISE EXCEPTION '049_MIGRATION_DELTA_REJECTED'; END IF;
 IF (SELECT jsonb_agg(v ORDER BY v->>'name') FROM jsonb_array_elements(actual->'tables') v WHERE v->>'name' NOT IN ('schema_migrations','{NEW_TABLE}'))
    IS DISTINCT FROM (SELECT jsonb_agg(v ORDER BY v->>'name') FROM jsonb_array_elements(prior->'tables') v WHERE v->>'name'<>'schema_migrations')
    OR (SELECT count(*) FROM jsonb_array_elements(actual->'tables'))<>(SELECT count(*)+1 FROM jsonb_array_elements(prior->'tables'))
 THEN RAISE EXCEPTION '049_ORIGINAL_BUSINESS_ROWS_CHANGED'; END IF;
 IF EXISTS(SELECT 1 FROM {NEW_TABLE}) THEN RAISE EXCEPTION '049_SETTINGS_MUST_REMAIN_EMPTY'; END IF;
END $canvas049guard$;"""


def migration_sql(before, catalog, sql):
    tables = [row["name"] for row in before["tables"]]
    require(NEW_TABLE not in tables and "schema_migrations" in tables, "049_PREVIOUS_TABLE_SET_REQUIRED")
    identifiers = ",".join('public."' + name.replace('"', '""') + '"' for name in tables)
    return ("BEGIN; SET LOCAL search_path=public; SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='300s'; "
            "SET LOCAL idle_in_transaction_session_timeout='330s';\n"
            f"LOCK TABLE {identifiers} IN SHARE MODE;\n"
            f"DO $canvas049before$ DECLARE actual jsonb; prior jsonb := {support.json_sql(before)}; BEGIN actual := ({support.snapshot_query()}); "
            "IF actual IS DISTINCT FROM prior THEN RAISE EXCEPTION '049_STOPPED_BASELINE_DRIFT'; END IF; END $canvas049before$;\n"
            + sql + f"\nINSERT INTO schema_migrations(name) VALUES('{MIGRATION}');\n"
            + guard_sql(before, catalog) + "\nCOMMIT;\n")


class QuickImage049(support.Usage048):
    def preflight_049(self, package):
        release, catalog = verify_049_package(package)
        self.new_audit("quick-image-049-preflight")
        self.assert_platform(release)
        current = self.capture("049-preflight")
        require(current["database"]["identity"]["database"] == self.instance["database"]["name"], "049_DATABASE_NAME_MISMATCH")
        validate_source_migrations(current["database"], release, self.instance)
        support.catalog_union(current["database"], catalog)
        require(NEW_TABLE not in {row["name"] for row in current["database"]["tables"]}, "049_TABLE_ALREADY_PRESENT")
        self.disabled("049-preflight-statistics-unchanged")
        self.gate("verify-open")
        write_new_json(self.audit / "preflight.json", {"schema": 1, "kind": "quick-image-049-preflight", "createdAt": time.time(),
                       "instanceSha256": sha_file(self.instance_path), "manifestSha256": sha_file(package / "release-manifest.json"),
                       "sqlSha256": digest_file(package / SQL_PATH), "package": str(package), "baseline": current})
        return {"status": "049-preflight-passed", "audit": str(self.audit), "mutations": False}

    def migrate_049(self, package, preflight):
        release, catalog = verify_049_package(package)
        prior = read_json(private_directory(preflight) / "preflight.json")
        require(prior.get("kind") == "quick-image-049-preflight" and 0 <= time.time() - prior.get("createdAt", 0) <= 900, "049_FRESH_PREFLIGHT_REQUIRED")
        require(prior.get("instanceSha256") == sha_file(self.instance_path) and prior.get("manifestSha256") == sha_file(package / "release-manifest.json")
                and prior.get("sqlSha256") == digest_file(package / SQL_PATH) and prior.get("package") == str(package), "049_PREFLIGHT_TARGET_CHANGED")
        self.new_audit("quick-image-049-migrate")
        phase = "preparation"
        try:
            current = self.capture("049-migrate")
            require_unchanged(prior["baseline"]["configurationHashes"], current["configurationHashes"], "049_CONFIGURATION_DRIFT")
            assert_database_layout(prior["baseline"]["database"], current["database"])
            for field in ["functions", "triggers"]:
                require_unchanged(prior["baseline"]["database"][field], current["database"][field], "049_CATALOG_DRIFT_SINCE_PREFLIGHT")
            assert_rollback_source(current["model"], prior["baseline"]["model"], current["containers"], prior["baseline"]["containers"], self.instance)
            validate_source_migrations(current["database"], release, self.instance)
            self.assert_platform(release)
            self.disabled("049-before-maintenance-statistics-unchanged")
            require(shutil.disk_usage(self.root).free >= self.instance["minimumFreeBytes"], "INSUFFICIENT_DISK_SPACE")
            self.preparation_unchanged(current)
            self.gate("verify-open")
            phase = "maintenance"
            self.gate("close"); self.gate("verify-closed")
            self.wait_for_drain()
            model = self.audit / "original.private.json"
            write_new_json(model, compose_literals(current["model"]))
            baseline = self.freeze_stopped_baseline(current, self.stop_app(model))
            for field in ["functions", "triggers"]:
                require_unchanged(current["database"][field], baseline["database"][field], "049_CATALOG_DRIFT_DURING_DRAIN")
            self.backup_048()
            self.protected_and_database(baseline, "049-before-sql")
            phase = "sql-outcome-unknown-until-verified"
            self.raw_sql(migration_sql(baseline["database"], catalog, (package / SQL_PATH).read_text(encoding="utf-8")), "049-transaction", timeout=360)
            after = self.sql("database-state.sql", "049-after-sql")
            assert_049_delta(baseline["database"], after, catalog)
            self.disabled("049-after-sql-statistics-unchanged")
            assert_protected(baseline["containers"], self.inventory("049-after-sql"), self.instance)
            write_new_json(self.audit / "schema-after.private.json", after)
            phase = "schema-committed-original-start-pending"
            self.application_configuration_unchanged(baseline)
            self.start_original(baseline)
            self.wait_health(self.instance["localBaseUrl"])
            self.command(["docker", "exec", self.instance["containers"]["worker"], "bun", "src/worker-healthcheck.ts"])
            running = self.inventory("049-original-started")
            support.assert_same_original(baseline["containers"], running, baseline["model"], self.instance, True)
            assert_protected(baseline["containers"], running, self.instance)
            require_unchanged(after, self.sql("database-state.sql", "049-original-verified"), "049_DATABASE_CHANGED_DURING_ORIGINAL_RESTART")
            self.disabled("049-original-statistics-unchanged")
            assert_idle(self.sql("activity.sql", "049-original-idle"))
            self.application_configuration_unchanged(baseline)
            phase = "verified-gate-reopen-pending"
            self.gate("open"); self.gate("verify-open")
            self.wait_health(self.instance["publicBaseUrl"])
            receipt = {"schema": 1, "status": "049-migrated-empty", "audit": str(self.audit), "instanceSha256": sha_file(self.instance_path),
                       "manifestSha256": sha_file(package / "release-manifest.json"), "sqlSha256": digest_file(package / SQL_PATH),
                       "databaseIdentity": after["identity"], "originalContainerIds": {role: container_map(running)[name]["Id"] for role, name in self.instance["containers"].items()},
                       "businessRowsChanged": False, "processingEnabled": False, "normalIngressRestored": True}
            write_new_json(self.audit / "receipt.json", receipt)
            return receipt
        except Exception:
            write_new_json(self.audit / "failure.json", {"status": "failed", "phase": phase, "manualReviewRequired": True,
                           "automaticRetry": False, "automaticRestore": False, "maintenanceMayBeClosed": phase != "preparation"})
            raise


def main():
    parser = argparse.ArgumentParser(description="Fixed 049 preparation only; never changes live image settings or analytics processing")
    parser.add_argument("operation", choices=["preflight", "migrate"])
    parser.add_argument("instance"); parser.add_argument("package"); parser.add_argument("prior_audit", nargs="?")
    args = parser.parse_args()
    require(sys.platform == "linux", "LINUX_DEPLOYMENT_HOST_REQUIRED")
    require(not os.environ.get("DOCKER_HOST"), "EXPLICIT_LOCAL_DOCKER_REQUIRED")
    os.umask(0o077)
    package = Path(args.package)
    require(package.is_absolute() and package.is_dir() and not package.is_symlink(), "ABSOLUTE_PACKAGE_REQUIRED")
    require((args.prior_audit is not None) == (args.operation == "migrate"), "EXACT_PRIOR_AUDIT_ARGUMENT_REQUIRED")
    runner = QuickImage049(args.instance)
    result = runner.preflight_049(package) if args.operation == "preflight" else runner.migrate_049(package, Path(args.prior_audit))
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try: main()
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        error = sys.exc_info()[1]
        print("QUICK_IMAGE_049_REJECTED " + (str(error) if isinstance(error, Rejected) else "PRIVATE_OPERATION_FAILED"), file=sys.stderr)
        sys.exit(1)
