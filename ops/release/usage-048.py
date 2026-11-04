#!/usr/bin/env python3
"""Fixed 048 schema preparation and separate analytics processing control.

This is not a general migration runner and does not change the zero-DB-change
image deployment contract. Unknown writes are never retried or auto-restored.
"""
import argparse
import copy
import ipaddress
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from contract import (Rejected, assert_configured_environment, assert_database_layout, assert_idle, assert_live_inventory, assert_migrations, assert_protected,
                      container_map, digest_file, read_json, require,
                      stable_container, verify_package, write_new_json)
from deploy import (Deployment, assert_rollback_source, compose_literals,
                    parse_compose_config, private_directory, require_unchanged, sha_file, stopped)

MIGRATION = "048_usage_daily_facts.sql"
SQL_PATH = "server/src/migrations/" + MIGRATION
CATALOG_PATH = "ops/release/usage-048-catalog.json"
CONTROL_LOCK = "pg_catalog.hashtextextended('canvas:usage-rollup-control:v1',0)"
NEW_TABLES = {"usage_rollup_state", "usage_dirty_days", "usage_source_invalidations", "usage_daily_snapshots", "usage_daily_facts", "usage_rollup_jobs"}
SORT_KEYS = {"columns": ("table_name", "ordinal_position"), "indexes": ("tablename", "indexname"),
             "constraints": ("relation", "name"), "functions": ("identity",), "triggers": ("relation", "name")}
TOOLS = Path(__file__).resolve().parent


def json_sql(value):
    text = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    require("$canvas048json$" not in text, "JSON_DELIMITER_REFUSED")
    return "$canvas048json$" + text + "$canvas048json$::jsonb"


def snapshot_query():
    base = (TOOLS / "database-state.sql").read_text(encoding="utf-8").strip().rstrip(";")
    extra = (TOOLS / "usage-048-state.sql").read_text(encoding="utf-8").strip().rstrip(";")
    # PostgreSQL 18 exposes NOT NULL in pg_constraint; 17 represents it only in
    # columns.is_nullable. Keep identical, complete nullability checks on both.
    return (f"WITH b(snapshot) AS ({base}), e(snapshot) AS ({extra}) SELECT b.snapshot||e.snapshot||"
            "jsonb_build_object('constraints',(SELECT coalesce(jsonb_agg(c ORDER BY c->>'relation',c->>'name'),'[]'::jsonb) "
            "FROM jsonb_array_elements(b.snapshot->'constraints') c WHERE c->>'type'<>'n')) FROM b,e")


def catalog_union(before, additions):
    require(set(additions) == set(SORT_KEYS), "048_CATALOG_FIELDS_INVALID")
    result = {}
    for field, keys in SORT_KEYS.items():
        original = before.get(field) or []
        added = additions[field]
        require(isinstance(original, list) and isinstance(added, list), "048_CATALOG_ARRAY_REQUIRED")
        result[field] = sorted(copy.deepcopy(original + added), key=lambda row: tuple(row[key] for key in keys))
        identities = [tuple(row[key] for key in keys) for row in result[field]]
        require(len(identities) == len(set(identities)), "048_OBJECT_ALREADY_PRESENT")
    return result


def assert_048_delta(before, after, catalog):
    for field in ["identity", "sequences", "sequenceStates"]:
        require_unchanged(before[field], after[field], "048_ORIGINAL_" + field.upper() + "_CHANGED")
    for field, expected in catalog_union(before, catalog).items():
        require_unchanged(expected, after[field], "048_UNEXPECTED_" + field.upper() + "_DELTA")
    prior = {row["name"]: row for row in before["tables"]}
    current = {row["name"]: row for row in after["tables"]}
    require(set(current) == set(prior) | NEW_TABLES and not set(prior) & NEW_TABLES, "048_UNEXPECTED_TABLE_DELTA")
    for name, row in prior.items():
        if name != "schema_migrations": require_unchanged(row, current[name], "048_ORIGINAL_BUSINESS_ROWS_CHANGED")
    old_migrations = [row for row in after["migrations"] if row["name"] != MIGRATION]
    require_unchanged(before["migrations"], old_migrations, "048_OLD_MIGRATION_ROWS_CHANGED")
    require(sum(row["name"] == MIGRATION for row in after["migrations"]) == 1, "048_MIGRATION_REGISTRATION_REQUIRED")
    require(current["schema_migrations"]["count"] == prior["schema_migrations"]["count"] + 1, "048_MIGRATION_ROW_DELTA_INVALID")
    for name in ["usage_daily_snapshots", "usage_daily_facts", "usage_rollup_jobs", "usage_source_invalidations"]:
        require(current[name]["count"] == 0, "048_PROCESSING_STARTED_BEFORE_ENABLE")
    require(current["usage_rollup_state"]["count"] == 1 and current["usage_dirty_days"]["count"] >= 1, "048_SEED_ROWS_MISSING")


def verify_048_package(package):
    release = verify_package(package)
    rows = [row for row in release["migrations"] if row["name"] == MIGRATION]
    require(len(rows) == 1 and release["migrations"][-1]["name"] == MIGRATION, "ONLY_RELEASE_ENDING_IN_048_SUPPORTED")
    require(digest_file(package / SQL_PATH) == rows[0]["sha256"], "048_SQL_MANIFEST_HASH_MISMATCH")
    # Never execute an operator or catalog different from this verified package.
    for relative in ["ops/release/usage-048.py", "ops/release/usage-048-state.sql", CATALOG_PATH,
                     "ops/release/database-state.sql", "ops/release/contract.py", "ops/release/deploy.py"]:
        require(digest_file(package / relative) == digest_file(TOOLS / Path(relative).name), "048_RUNNING_TOOL_DIFFERS_FROM_PACKAGE")
    catalog = read_json(package / CATALOG_PATH)
    catalog_union({field: [] for field in SORT_KEYS}, catalog)
    require({row["table_name"] for row in catalog["columns"]} == NEW_TABLES, "048_FIXED_TABLE_CATALOG_REQUIRED")
    return release, catalog


def validate_source_migrations(database, release, instance):
    expected = {row["name"] for row in release["migrations"] if row["name"] != MIGRATION} | set(instance["retainedMigrationNames"])
    actual = [row["name"] for row in database["migrations"]]
    require(MIGRATION not in actual and len(actual) == len(set(actual)) and set(actual) == expected, "048_EXACT_PREVIOUS_MIGRATIONS_REQUIRED")


def assert_same_original(before, after, model, instance, running):
    """Same IDs and deployment configuration; dynamic IPv4 can be reassigned.

    This exception is scoped to a verified same-container stop/start, not image
    cutover. Static IPAM/Compose addresses and every network identity stay exact.
    """
    original, current = container_map(before), container_map(after)
    for role, name in instance["containers"].items():
        require(name in current and name in original, "048_ORIGINAL_CONTAINER_MISSING")
        a, b = original[name], current[name]
        require(b.get("State", {}).get("Running") is running and b.get("State", {}).get("Restarting") is False, "048_ORIGINAL_RUNNING_STATE_INVALID")
        left, right = stable_container(a), stable_container(b)
        for row, value in [(a, left), (b, right)]:
            value["networkAllocation"] = {network: {key: item.get(key) for key in ["IPAMConfig", "Gateway", "IPPrefixLen", "IPv6Gateway", "GlobalIPv6PrefixLen"]}
                                          for network, item in row.get("NetworkSettings", {}).get("Networks", {}).items()}
        for value in [left, right]:
            value.pop("startedAt", None); value.pop("restartCount", None)
        configured = model["services"][role].get("networks", {})
        static = isinstance(configured, dict) and any(isinstance(v, dict) and v.get("ipv4_address") for v in configured.values())
        for network in left["networks"]:
            prior_network = a.get("NetworkSettings", {}).get("Networks", {}).get(network, {})
            now_network = b.get("NetworkSettings", {}).get("Networks", {}).get(network, {})
            if not running:
                # A stopped endpoint can be detached without changing its
                # deployment. Only exact empty runtime values are normalized;
                # the original network/subnet is verified again after start.
                require(a["Id"] == b["Id"], "048_ORIGINAL_CONTAINER_CHANGED")
                for key, empty in [("IPAddress", ""), ("GlobalIPv6Address", "")]:
                    if now_network.get(key) == empty and prior_network.get(key) != empty:
                        right["networks"][network][key] = left["networks"][network][key]
                for key, empty in [("Gateway", ""), ("IPPrefixLen", 0), ("IPv6Gateway", ""), ("GlobalIPv6PrefixLen", 0)]:
                    if now_network.get(key) == empty and prior_network.get(key) != empty:
                        right["networkAllocation"][network][key] = left["networkAllocation"][network][key]
                if now_network.get("IPAddress") == "": continue
            if prior_network.get("IPAddress") != now_network.get("IPAddress"):
                require(a["Id"] == b["Id"] and network == instance["network"] and not static
                        and prior_network.get("IPAMConfig") is None and now_network.get("IPAMConfig") is None
                        and prior_network.get("NetworkID") == now_network.get("NetworkID"), "048_STATIC_OR_UNREVIEWED_IPV4_CHANGE")
                prefix = prior_network.get("IPPrefixLen")
                require(type(prefix) is int and 1 <= prefix <= 32, "048_DYNAMIC_IPV4_PREFIX_INVALID")
                try:
                    subnet = ipaddress.IPv4Interface(f"{prior_network['IPAddress']}/{prefix}").network
                    require(ipaddress.IPv4Address(now_network["IPAddress"]) in subnet, "048_DYNAMIC_IPV4_SUBNET_CHANGED")
                except (ValueError, TypeError, KeyError):
                    raise Rejected("048_DYNAMIC_IPV4_ADDRESS_INVALID") from None
                left["networks"][network].pop("IPAddress", None)
                if network in right["networks"]: right["networks"][network].pop("IPAddress", None)
        require_unchanged(left, right, "048_ORIGINAL_DEPLOYMENT_CHANGED")


def installed_catalog_sql(catalog):
    """Select the complete fixed projection surface, including unexpected additions."""
    tables = ",".join("'" + name + "'" for name in sorted(NEW_TABLES))
    names = {
        "columns": f"v->>'table_name' IN ({tables})",
        "constraints": f"v->>'relation' IN ({tables})",
        "indexes": f"v->>'tablename' IN ({tables}) OR v->>'indexname' IN (" + ",".join("'" + row["indexname"] + "'" for row in catalog["indexes"]) + ")",
        "functions": "split_part(v->>'identity','(',1) IN (" + ",".join("'" + row["identity"].split("(")[0] + "'" for row in catalog["functions"]) + ")",
        "triggers": f"v->>'relation' IN ({tables}) OR v->>'name' IN (" + ",".join("'" + row["name"] + "'" for row in catalog["triggers"]) + ")",
    }
    return " OR ".join(f"(SELECT coalesce(jsonb_agg(v ORDER BY " + ",".join(f"(v->>'{key}')::int" if key == "ordinal_position" else f"v->>'{key}'" for key in SORT_KEYS[field])
                       + f"),'[]'::jsonb) FROM jsonb_array_elements(actual->'{field}') v WHERE {predicate}) IS DISTINCT FROM expected->'{field}'"
                       for field, predicate in names.items())


def guard_sql(before, catalog):
    expected = catalog_union(before, catalog)
    fields = " OR ".join(f"actual->'{key}' IS DISTINCT FROM expected->'{key}'" for key in SORT_KEYS)
    return f"""DO $canvas048guard$
DECLARE actual jsonb; prior jsonb := {json_sql(before)}; expected jsonb := {json_sql(expected)};
BEGIN
 actual := ({snapshot_query()});
 IF actual->'identity' IS DISTINCT FROM prior->'identity' OR actual->'sequences' IS DISTINCT FROM prior->'sequences'
    OR actual->'sequenceStates' IS DISTINCT FROM prior->'sequenceStates'
    OR {fields} THEN RAISE EXCEPTION '048_CATALOG_IDENTITY_OR_SEQUENCE_DELTA_REJECTED' USING DETAIL =
    (SELECT string_agg(key,',' ORDER BY key) FROM jsonb_each(expected||jsonb_build_object('identity',prior->'identity','sequences',prior->'sequences','sequenceStates',prior->'sequenceStates')) WHERE value IS DISTINCT FROM actual->key); END IF;
 IF (SELECT coalesce(jsonb_agg(v ORDER BY v->>'name'),'[]'::jsonb) FROM jsonb_array_elements(actual->'migrations') v WHERE v->>'name'<>'{MIGRATION}') IS DISTINCT FROM prior->'migrations'
    OR (SELECT count(*) FROM jsonb_array_elements(actual->'migrations') v WHERE v->>'name'='{MIGRATION}')<>1
 THEN RAISE EXCEPTION '048_MIGRATION_DELTA_REJECTED'; END IF;
 IF (SELECT jsonb_agg(v ORDER BY v->>'name') FROM jsonb_array_elements(actual->'tables') v WHERE v->>'name' NOT IN ('schema_migrations','usage_rollup_state','usage_dirty_days','usage_source_invalidations','usage_daily_snapshots','usage_daily_facts','usage_rollup_jobs'))
    IS DISTINCT FROM (SELECT jsonb_agg(v ORDER BY v->>'name') FROM jsonb_array_elements(prior->'tables') v WHERE v->>'name'<>'schema_migrations')
 THEN RAISE EXCEPTION '048_ORIGINAL_BUSINESS_ROWS_CHANGED'; END IF;
 IF (SELECT count(*) FROM usage_rollup_state)<>1 OR NOT EXISTS(SELECT 1 FROM usage_rollup_state WHERE singleton AND NOT processing_enabled AND last_scheduled_day IS NULL)
    OR EXISTS(SELECT 1 FROM usage_daily_facts) OR EXISTS(SELECT 1 FROM usage_daily_snapshots) OR EXISTS(SELECT 1 FROM usage_rollup_jobs)
    OR EXISTS(SELECT 1 FROM usage_source_invalidations)
    OR EXISTS(SELECT 1 FROM usage_dirty_days WHERE failure_code IS NOT NULL OR failed_at IS NOT NULL OR dirty_at<>now() OR ready_after<>now())
    OR (SELECT count(*) FROM usage_dirty_days)<>(SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date-history_from+1 FROM usage_rollup_state)
    OR EXISTS(SELECT 1 FROM usage_dirty_days d,usage_rollup_state s WHERE d.day<s.history_from OR d.day>(now() AT TIME ZONE 'Asia/Shanghai')::date)
 THEN RAISE EXCEPTION '048_DISABLED_SEED_DELTA_REJECTED'; END IF;
END $canvas048guard$;"""


def migration_sql(before, catalog, sql):
    # Only the package's fixed SQL reaches this function in the runtime path.
    tables = [row["name"] for row in before["tables"]]
    require(not set(tables) & NEW_TABLES and "schema_migrations" in tables, "048_PREVIOUS_TABLE_SET_REQUIRED")
    identifiers = ",".join('public."' + name.replace('"', '""') + '"' for name in tables)
    return ("BEGIN; SET LOCAL search_path=public; SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='300s'; "
            "SET LOCAL idle_in_transaction_session_timeout='330s';\n"
            f"LOCK TABLE {identifiers} IN SHARE MODE;\n"
            f"DO $canvas048before$ DECLARE actual jsonb; prior jsonb := {json_sql(before)}; BEGIN actual := ({snapshot_query()}); "
            "IF actual IS DISTINCT FROM prior THEN RAISE EXCEPTION '048_STOPPED_BASELINE_DRIFT' USING DETAIL = "
            "(SELECT string_agg(key,',' ORDER BY key) FROM jsonb_each(actual) WHERE value IS DISTINCT FROM prior->key); END IF; END $canvas048before$;\n"
            + sql + f"\nINSERT INTO schema_migrations(name) VALUES('{MIGRATION}');\n"
            + guard_sql(before, catalog) + "\nCOMMIT;\n")


def control_sql(enabled, identity, catalog):
    # No deletion, history reset, job submission, dirty-day clearing or other
    # state fields. Exclusive lock waits for every shared processing transaction.
    expected = json_sql(catalog)
    checks = installed_catalog_sql(catalog)
    return f"""BEGIN; SET LOCAL search_path=public; SET LOCAL lock_timeout='60s'; SET LOCAL statement_timeout='90s';
SET LOCAL idle_in_transaction_session_timeout='100s';
DO $canvas048control$
DECLARE actual jsonb; previous_state jsonb; expected jsonb := {expected};
BEGIN
 PERFORM pg_catalog.pg_advisory_xact_lock({CONTROL_LOCK});
 actual := ({snapshot_query()});
 IF actual->'identity' IS DISTINCT FROM {json_sql(identity)} OR {checks}
    OR NOT EXISTS(SELECT 1 FROM schema_migrations WHERE name='{MIGRATION}')
    OR (SELECT count(*) FROM usage_rollup_state)<>1
    OR EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class='public.usage_rollup_state'::regclass)
    OR EXISTS(SELECT 1 FROM pg_class WHERE oid='public.usage_rollup_state'::regclass AND (relrowsecurity OR relforcerowsecurity))
 THEN RAISE EXCEPTION '048_CONTROL_TARGET_CHANGED'; END IF;
 SELECT to_jsonb(s)-'processing_enabled' INTO previous_state FROM usage_rollup_state s WHERE singleton=true FOR UPDATE;
 UPDATE usage_rollup_state SET processing_enabled={'true' if enabled else 'false'} WHERE singleton=true;
 IF (SELECT to_jsonb(s)-'processing_enabled' FROM usage_rollup_state s WHERE singleton=true) IS DISTINCT FROM previous_state
    OR NOT EXISTS(SELECT 1 FROM usage_rollup_state WHERE singleton=true AND processing_enabled={'true' if enabled else 'false'})
 THEN RAISE EXCEPTION '048_CONTROL_NON_FLAG_STATE_CHANGED'; END IF;
END $canvas048control$;
COMMIT;
"""


class Usage048(Deployment):
    def raw_sql(self, query, label, timeout=120):
        db = self.instance["database"]
        return self.command(["docker", "exec", "-i", db["container"], "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-U", db["user"], "-d", db["name"]],
                            input_data=query.encode("utf-8"), timeout=timeout, output=self.audit / f"{label}.private.log")

    def sql(self, name, label):
        if name != "database-state.sql": return super().sql(name, label)
        value = self.raw_sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; SET LOCAL statement_timeout='60s';\n" + snapshot_query() + ";\nCOMMIT;", label)
        return json.loads(value)

    def disabled(self, label):
        result = self.raw_sql("BEGIN READ ONLY; SET LOCAL statement_timeout='10s'; SELECT count(*)=1 AND bool_and(singleton AND NOT processing_enabled) FROM public.usage_rollup_state; COMMIT;", label)
        require(result.strip() == b"t", "048_PROCESSING_MUST_REMAIN_DISABLED")

    def preflight_048(self, package):
        release, catalog = verify_048_package(package)
        self.new_audit("usage-048-preflight")
        self.assert_platform(release)
        current = self.capture("048-preflight")
        require(current["database"]["identity"]["database"] == self.instance["database"]["name"], "048_DATABASE_NAME_MISMATCH")
        validate_source_migrations(current["database"], release, self.instance)
        catalog_union(current["database"], catalog)
        require(not {row["name"] for row in current["database"]["tables"]} & NEW_TABLES, "048_TABLE_ALREADY_PRESENT")
        self.gate("verify-open")
        write_new_json(self.audit / "preflight.json", {"schema": 1, "kind": "usage-048-preflight", "createdAt": time.time(),
                       "instanceSha256": sha_file(self.instance_path), "manifestSha256": sha_file(package / "release-manifest.json"),
                       "sqlSha256": digest_file(package / SQL_PATH), "package": str(package), "baseline": current})
        return {"status": "048-preflight-passed", "audit": str(self.audit), "mutations": False}

    def backup_048(self):
        db = self.instance["database"]
        target = self.audit / "database-before.dump"
        self.command(["docker", "exec", db["container"], "pg_dump", "-U", db["user"], "-d", db["name"], "-Fc"], timeout=600, output=target, read_output=False)
        require(target.stat().st_size > 0, "EMPTY_DATABASE_BACKUP")
        self.command(["docker", "exec", "-i", db["container"], "pg_restore", "--list"], input_file=target, timeout=120, read_output=False)
        write_new_json(self.audit / "database-backup.json", {"file": target.name, "sha256": sha_file(target), "bytes": target.stat().st_size})

    def start_original(self, baseline):
        rows = self.inventory("048-before-original-start")
        require(stopped(rows, self.instance), "048_ORIGINAL_STOP_REQUIRED")
        assert_same_original(baseline["containers"], rows, baseline["model"], self.instance, False)
        original, now = container_map(baseline["containers"]), container_map(rows)
        ids = []
        for role in ["api", "worker", "web"]:
            name = self.instance["containers"][role]
            require(now[name]["Id"] == original[name]["Id"] and now[name]["Image"] == original[name]["Image"], "048_ORIGINAL_CONTAINER_CHANGED")
            ids.append(original[name]["Id"])
        self.command(["docker", "start", *ids], timeout=180)

    def migrate_048(self, package, preflight):
        release, catalog = verify_048_package(package)
        prior = read_json(private_directory(preflight) / "preflight.json")
        require(prior.get("kind") == "usage-048-preflight" and 0 <= time.time() - prior.get("createdAt", 0) <= 900, "048_FRESH_PREFLIGHT_REQUIRED")
        require(prior.get("instanceSha256") == sha_file(self.instance_path) and prior.get("manifestSha256") == sha_file(package / "release-manifest.json")
                and prior.get("sqlSha256") == digest_file(package / SQL_PATH) and prior.get("package") == str(package), "048_PREFLIGHT_TARGET_CHANGED")
        self.new_audit("usage-048-migrate")
        phase = "preparation"
        try:
            current = self.capture("048-migrate")
            require_unchanged(prior["baseline"]["configurationHashes"], current["configurationHashes"], "048_CONFIGURATION_DRIFT")
            assert_database_layout(prior["baseline"]["database"], current["database"])
            for field in ["functions", "triggers"]:
                require_unchanged(prior["baseline"]["database"][field], current["database"][field], "048_CATALOG_DRIFT_SINCE_PREFLIGHT")
            assert_rollback_source(current["model"], prior["baseline"]["model"], current["containers"], prior["baseline"]["containers"], self.instance)
            validate_source_migrations(current["database"], release, self.instance)
            self.assert_platform(release)
            require(shutil.disk_usage(self.root).free >= self.instance["minimumFreeBytes"], "INSUFFICIENT_DISK_SPACE")
            self.preparation_unchanged(current)
            self.gate("verify-open")
            phase = "maintenance"
            self.gate("close"); self.gate("verify-closed")
            self.wait_for_drain()
            model = self.audit / "original.private.json"
            write_new_json(model, compose_literals(current["model"]))
            rows = self.stop_app(model)
            baseline = self.freeze_stopped_baseline(current, rows)
            for field in ["functions", "triggers"]:
                require_unchanged(current["database"][field], baseline["database"][field], "048_CATALOG_DRIFT_DURING_DRAIN")
            self.backup_048()
            self.protected_and_database(baseline, "048-before-sql")
            phase = "sql-outcome-unknown-until-verified"
            self.raw_sql(migration_sql(baseline["database"], catalog, (package / SQL_PATH).read_text(encoding="utf-8")), "048-transaction", timeout=360)
            after = self.sql("database-state.sql", "048-after-sql")
            assert_048_delta(baseline["database"], after, catalog)
            self.disabled("048-after-sql-disabled")
            assert_protected(baseline["containers"], self.inventory("048-after-sql"), self.instance)
            write_new_json(self.audit / "schema-after.private.json", after)
            phase = "schema-committed-original-start-pending"
            self.application_configuration_unchanged(baseline)
            self.start_original(baseline)
            self.wait_health(self.instance["localBaseUrl"])
            self.command(["docker", "exec", self.instance["containers"]["worker"], "bun", "src/worker-healthcheck.ts"])
            running = self.inventory("048-original-started")
            assert_same_original(baseline["containers"], running, baseline["model"], self.instance, True)
            assert_protected(baseline["containers"], running, self.instance)
            require_unchanged(after, self.sql("database-state.sql", "048-original-verified"), "048_DATABASE_CHANGED_DURING_ORIGINAL_RESTART")
            self.disabled("048-original-disabled")
            assert_idle(self.sql("activity.sql", "048-original-idle"))
            self.application_configuration_unchanged(baseline)
            phase = "verified-gate-reopen-pending"
            self.gate("open"); self.gate("verify-open")
            self.wait_health(self.instance["publicBaseUrl"])
            receipt = {"schema": 1, "status": "048-migrated-disabled", "audit": str(self.audit), "instanceSha256": sha_file(self.instance_path),
                       "manifestSha256": sha_file(package / "release-manifest.json"), "sqlSha256": digest_file(package / SQL_PATH),
                       "databaseIdentity": after["identity"], "originalContainerIds": {role: container_map(running)[name]["Id"] for role, name in self.instance["containers"].items()},
                       "businessRowsChanged": False, "processingEnabled": False, "normalIngressRestored": True}
            write_new_json(self.audit / "receipt.json", receipt)
            return receipt
        except Exception:
            write_new_json(self.audit / "failure.json", {"status": "failed", "phase": phase, "manualReviewRequired": True,
                           "automaticRetry": False, "automaticRestore": False, "maintenanceMayBeClosed": phase != "preparation"})
            raise

    def control_048(self, package, enabled, applied=None):
        release, catalog = verify_048_package(package)
        self.new_audit("usage-048-enable" if enabled else "usage-048-disable")
        # Do not use capture()'s maintenance-busy rejection: disable is meant to
        # wait behind active analysis, including work older than 30 seconds.
        model = parse_compose_config(self.compose("config", "--format", "json"))
        rows = self.inventory("048-control")
        assert_live_inventory(rows, model, self.instance)
        for role, name in self.instance["containers"].items():
            image = json.loads(self.command(["docker", "image", "inspect", container_map(rows)[name]["Image"]]))[0]
            assert_configured_environment(container_map(rows)[name], image, model["services"][role])
        current = {"model": model, "containers": rows, "database": self.sql("database-state.sql", "048-control")}
        assert_migrations([row["name"] for row in current["database"]["migrations"]], release, self.instance)
        identity = current["database"]["identity"]
        require(identity["database"] == self.instance["database"]["name"], "048_DATABASE_NAME_MISMATCH")
        if enabled:
            old = private_directory(applied)
            receipt = read_json(old / "receipt.json")
            require(receipt.get("status") == "applied" and receipt.get("instanceSha256") == sha_file(self.instance_path)
                    and receipt.get("commit") == release["commit"] and receipt.get("databaseChanged") is False
                    and receipt.get("infrastructureChanged") is False and receipt.get("databaseBaseline") == "confirmed-stopped"
                    and receipt.get("imageIds") == {role: row["id"] for role, row in release["images"].items()}, "048_MATCHING_SUCCESSFUL_APPLY_REQUIRED")
            evidence = receipt.get("rollbackEvidence", {})
            for name in ["baseline.private.json", "candidate-model.private.json", "candidate.private.json", "containers-started.private.json"]:
                require(evidence.get(name) == sha_file(old / name), "048_APPLY_EVIDENCE_CHANGED")
            require_unchanged(read_json(old / "baseline.private.json")["database"]["identity"], identity, "048_APPLY_DATABASE_IDENTITY_CHANGED")
            expected_model = parse_compose_config(self.compose("config", "--format", "json", model=old / "candidate.private.json"))
            assert_rollback_source(current["model"], expected_model, current["containers"], read_json(old / "containers-started.private.json"), self.instance)
            for role, name in self.instance["containers"].items():
                require(container_map(current["containers"])[name]["Image"] == release["images"]["web" if role == "web" else "api"]["id"], "048_LIVE_RELEASE_IMAGE_MISMATCH")
            self.gate("verify-open")
        try:
            self.raw_sql(control_sql(enabled, identity, catalog), "048-control-transaction", timeout=110)
        except Exception:
            write_new_json(self.audit / "failure.json", {"status": "control-outcome-unknown", "requestedEnabled": enabled,
                           "manualReviewRequired": True, "automaticRetry": False})
            raise
        receipt = {"schema": 1, "status": "048-enabled" if enabled else "048-disabled", "audit": str(self.audit), "processingEnabled": enabled,
                   "instanceSha256": sha_file(self.instance_path), "manifestSha256": sha_file(package / "release-manifest.json"),
                   "sqlSha256": digest_file(package / SQL_PATH), "databaseIdentity": identity, "commit": release["commit"],
                   "onlyProcessingFlagChanged": True, "inflightProcessingDrained": not enabled, "dataAndDirtyRowsPreserved": True}
        write_new_json(self.audit / "receipt.json", receipt)
        return receipt


def main():
    parser = argparse.ArgumentParser(description="Fixed 048 preparation; no arbitrary SQL, image switching or automatic retries")
    parser.add_argument("operation", choices=["preflight", "migrate", "enable", "disable"])
    parser.add_argument("instance"); parser.add_argument("package"); parser.add_argument("prior_audit", nargs="?")
    args = parser.parse_args()
    require(sys.platform == "linux", "LINUX_DEPLOYMENT_HOST_REQUIRED")
    require(not os.environ.get("DOCKER_HOST"), "EXPLICIT_LOCAL_DOCKER_REQUIRED")
    os.umask(0o077)
    package = Path(args.package)
    require(package.is_absolute() and package.is_dir() and not package.is_symlink(), "ABSOLUTE_PACKAGE_REQUIRED")
    require((args.prior_audit is not None) == (args.operation in ["migrate", "enable"]), "EXACT_PRIOR_AUDIT_ARGUMENT_REQUIRED")
    runner = Usage048(args.instance)
    if args.operation == "preflight": result = runner.preflight_048(package)
    elif args.operation == "migrate": result = runner.migrate_048(package, Path(args.prior_audit))
    else: result = runner.control_048(package, args.operation == "enable", Path(args.prior_audit) if args.prior_audit else None)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try: main()
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        error = sys.exc_info()[1]
        print("USAGE_048_REJECTED " + (str(error) if isinstance(error, Rejected) else "PRIVATE_OPERATION_FAILED"), file=sys.stderr)
        sys.exit(1)
