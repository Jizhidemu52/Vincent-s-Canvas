#!/usr/bin/env python3
"""Fixed 050/051 preparation; normal application deployment remains zero-DB.

No arbitrary SQL, legacy recipe export, updates to existing recipes, analytics
enablement, image switching, automatic retry, or automatic database restore.
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
import uuid

from contract import (Rejected, assert_database_layout, assert_idle, assert_protected,
                      container_map, digest, digest_file, read_json, require, verify_package, write_new_json)
from creative_seed import MIGRATIONS, RECIPE_NAMES, SEED_PATH, validate_seed, verify_payload
from deploy import assert_rollback_source, compose_literals, private_directory, require_unchanged, sha_file

TOOLS = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("creative_schema_support", TOOLS / "usage-048.py")
support = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(support)
CATALOG_PATH = "ops/release/creative-050-051-catalog.json"
STATE_PATH = "ops/release/creative-050-051-state.sql"
SORT_KEYS = support.SORT_KEYS
CONSTRAINTS = {("module_flags", "module_flags_module_key_check"),
               ("tool_api_configurations", "tool_api_configurations_tool_key_check"),
               ("quick_image_configurations", "quick_image_configurations_action_check")}
SCOPES = {"module_flags": ("module_key", ["creative-" + key for key in RECIPE_NAMES]),
          "tool_api_configurations": ("tool_key", ["creative-" + key for key in RECIPE_NAMES]),
          "prompt_recipes": ("key", list(RECIPE_NAMES)),
          "prompt_recipe_versions": ("recipe_key", list(RECIPE_NAMES))}
CHANGED_TABLES = set(SCOPES) | {"schema_migrations"}
STAMP = "to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
FLARE_QUERY = """SELECT m.id FROM model_configs m JOIN providers p ON p.id=m.provider_id
 WHERE m.provider_id='9567f5da-bb4d-4e4b-b680-c7184d00a001'::uuid
 AND m.model_id='gpt-image-2.6-flare' AND m.enabled AND p.enabled AND p.protocol='apimart'
 AND 'edit'=ANY(m.capabilities) AND m.workflow_config_id IS NULL"""


def literal(value):
    require(isinstance(value, str) and "\x00" not in value, "051_SQL_TEXT_INVALID")
    return "'" + value.replace("'", "''") + "'"


def options_value(actor, optimizer):
    for value in [actor, optimizer]:
        require(isinstance(value, str) and str(uuid.UUID(value)) == value, "051_CANONICAL_UUID_REQUIRED")
    return {"actorId": actor, "optimizerModelConfigId": optimizer}


def dependency_condition(options):
    options_value(options["actorId"], options["optimizerModelConfigId"])
    return f"""EXISTS(SELECT 1 FROM users WHERE id={literal(options['actorId'])}::uuid AND role='super_admin' AND status='active')
 AND EXISTS(SELECT 1 FROM model_configs m JOIN providers p ON p.id=m.provider_id
 WHERE m.id={literal(options['optimizerModelConfigId'])}::uuid AND m.enabled AND p.enabled AND 'chat'=ANY(m.capabilities)
 AND m.workflow_config_id IS NULL AND p.protocol IN ('openai','custom','apimart','gemini','anthropic','openai-chat'))
 AND (SELECT count(*) FROM ({FLARE_QUERY}) f)=1
 AND (SELECT count(*)=1 AND bool_and(singleton AND NOT processing_enabled) FROM usage_rollup_state)"""


def snapshot_query():
    extra = (TOOLS / Path(STATE_PATH).name).read_text(encoding="utf-8").strip().rstrip(";")
    return f"WITH b(snapshot) AS ({support.snapshot_query()}), c(snapshot) AS ({extra}) SELECT b.snapshot||c.snapshot FROM b,c"


def expected_catalog(before, catalog):
    require(isinstance(catalog, dict) and set(catalog) == {"schema", "constraints"} and catalog["schema"] == 1, "051_CATALOG_FIELDS_INVALID")
    rows = catalog["constraints"]
    require(isinstance(rows, list) and len(rows) == 3 and all(isinstance(row, dict) and set(row) == {"before", "after"} for row in rows), "051_THREE_FIXED_CHECKS_REQUIRED")
    for side in ["before", "after"]:
        require(all(isinstance(row[side], dict) and set(row[side]) == {"relation", "name", "type", "definition"}
                    and row[side]["type"] == "c" and isinstance(row[side]["definition"], str) for row in rows), "051_CHECK_CATALOG_INVALID")
        require({(row[side]["relation"], row[side]["name"]) for row in rows} == CONSTRAINTS, "051_CHECK_IDENTITIES_INVALID")
    result = {field: copy.deepcopy(before[field]) for field in SORT_KEYS}
    for replacement in rows:
        require((replacement["before"]["relation"], replacement["before"]["name"]) ==
                (replacement["after"]["relation"], replacement["after"]["name"]), "051_CHECK_REPLACEMENT_IDENTITY_CHANGED")
        matches = [index for index, row in enumerate(result["constraints"]) if (row["relation"], row["name"]) ==
                   (replacement["before"]["relation"], replacement["before"]["name"])]
        require(len(matches) == 1 and result["constraints"][matches[0]] == replacement["before"], "051_EXACT_PREVIOUS_CHECK_REQUIRED")
        result["constraints"][matches[0]] = copy.deepcopy(replacement["after"])
    result["constraints"].sort(key=lambda row: (row["relation"], row["name"]))
    return result


def scope_map(database):
    rows = database["creativeScopes"]
    require(isinstance(rows, list) and len(rows) == 8, "051_SCOPE_SNAPSHOT_INVALID")
    result = {(row["table"], row["key"]): row for row in rows}
    require(set(result) == {(table, key) for table, (_, keys) in SCOPES.items() for key in keys}, "051_SCOPE_IDENTITIES_INVALID")
    for (table, key), row in result.items():
        require(type(row["count"]) is int and row["count"] >= 0 and (table == "prompt_recipe_versions" or row["count"] <= 1), "051_SCOPE_COUNT_INVALID")
        if table == "prompt_recipes" and row["count"] == 0:
            require(result[("prompt_recipe_versions", key)]["count"] == 0, "051_ORPHAN_RECIPE_VERSIONS_REJECTED")
    return result


def missing_scopes(before):
    rows = scope_map(before)
    result = {table: [key for key in keys if rows[(table, key)]["count"] == 0] for table, (_, keys) in SCOPES.items()}
    # An existing draft without a version is preserved, not silently published.
    result["prompt_recipe_versions"] = result["prompt_recipes"][:]
    return result


def assert_delta(before, after, catalog):
    require(set(after) == set(before), "051_SNAPSHOT_FIELDS_CHANGED")
    for field in ["identity", "sequences", "sequenceStates", "creativeOtherRows"]:
        require_unchanged(before[field], after[field], "051_ORIGINAL_" + field.upper() + "_CHANGED")
    for field, expected in expected_catalog(before, catalog).items():
        require_unchanged(expected, after[field], "051_UNEXPECTED_" + field.upper() + "_DELTA")
    old_scopes, new_scopes, missing = scope_map(before), scope_map(after), missing_scopes(before)
    for identity, row in old_scopes.items():
        table, key = identity
        if key in missing[table]: require(new_scopes[identity]["count"] == 1, "051_EXACTLY_ONE_NEW_SCOPED_ROW_REQUIRED")
        else: require_unchanged(row, new_scopes[identity], "051_EXISTING_SCOPED_ROW_CHANGED")
    prior, current = ({row["name"]: row for row in value["tables"]} for value in [before, after])
    require(set(prior) == set(current), "051_TABLE_SET_CHANGED")
    for name, row in prior.items():
        if name not in CHANGED_TABLES: require_unchanged(row, current[name], "051_ORIGINAL_BUSINESS_ROWS_CHANGED")
        else: require(current[name]["count"] == row["count"] + (2 if name == "schema_migrations" else len(missing[name])), "051_SCOPED_TABLE_COUNT_INVALID")
    require_unchanged(before["migrations"], [row for row in after["migrations"] if row["name"] not in MIGRATIONS], "051_OLD_MIGRATION_ROWS_CHANGED")
    require(all(sum(row["name"] == name for row in after["migrations"]) == 1 for name in MIGRATIONS), "051_TWO_MIGRATION_REGISTRATIONS_REQUIRED")


def validate_source_migrations(database, release, instance):
    expected = {row["name"] for row in release["migrations"] if row["name"] not in MIGRATIONS} | set(instance["retainedMigrationNames"])
    actual = [row["name"] for row in database["migrations"]]
    require(not set(actual) & set(MIGRATIONS) and len(actual) == len(set(actual)) and set(actual) == expected, "051_EXACT_PREVIOUS_MIGRATIONS_REQUIRED")


def verify_creative_package(package):
    release = verify_package(package)
    seed = verify_payload(package, release)
    for relative in ["ops/release/creative-050-051.py", "ops/release/creative_seed.py", CATALOG_PATH, STATE_PATH,
                     "ops/release/usage-048.py", "ops/release/usage-048-state.sql", "ops/release/database-state.sql",
                     "ops/release/contract.py", "ops/release/deploy.py"]:
        require(digest_file(package / relative) == digest_file(TOOLS / Path(relative).name), "051_RUNNING_TOOL_DIFFERS_FROM_PACKAGE")
    catalog = read_json(package / CATALOG_PATH)
    return release, catalog, seed


def payload_hashes(package):
    return {relative: digest_file(package / relative) for relative in [SEED_PATH, CATALOG_PATH, *["server/src/migrations/" + name for name in MIGRATIONS]]}


def validate_binding(prior, package, instance_path, options):
    require(prior.get("instanceSha256") == sha_file(instance_path) and prior.get("manifestSha256") == sha_file(package / "release-manifest.json")
            and prior.get("payloadHashes") == payload_hashes(package) and prior.get("package") == str(package)
            and prior.get("options") == options, "051_PREFLIGHT_TARGET_CHANGED")


def validate_preflight(prior, package, instance_path, options, now=None):
    require(prior.get("kind") == "creative-050-051-preflight" and 0 <= (time.time() if now is None else now) - prior.get("createdAt", 0) <= 900, "051_FRESH_PREFLIGHT_REQUIRED")
    validate_binding(prior, package, instance_path, options)


def read_migration_sql(package, release):
    chunks = []
    for name in MIGRATIONS:
        path = package / "server/src/migrations" / name
        require(path.is_file() and not path.is_symlink(), "051_REGULAR_SQL_REQUIRED")
        data = path.read_bytes()
        expected = next(row["sha256"] for row in release["migrations"] if row["name"] == name)
        require(digest(data) == expected, "051_SQL_CHANGED_BEFORE_EXECUTION")
        chunks.append(data.decode("utf-8"))
    return "\n".join(chunks)


def seed_sql(before, seed, options, version_ids):
    statements = []
    for row in seed["recipes"]:
        if row["key"] not in version_ids: continue
        key, version_id = literal(row["key"]), literal(version_ids[row["key"]])
        settings = {"name": row["name"], "enabled": True, "modelConfigId": options["optimizerModelConfigId"], "failurePolicy": "stop"}
        statements += [f"INSERT INTO prompt_recipes(key,settings,updated_at) VALUES({key},{support.json_sql(settings)},{STAMP});",
                       f"INSERT INTO prompt_recipe_versions(id,recipe_key,version,content_hash,content,created_by,created_at) VALUES({version_id},{key},1,{literal(row['contentHash'])},{support.json_sql(row['content'])},{literal(options['actorId'])},{STAMP});",
                       f"UPDATE prompt_recipes SET current_version_id={version_id} WHERE key={key};"]
    return "\n".join(statements)


def guard_sql(before, catalog, seed, options, version_ids):
    missing = missing_scopes(before)
    checks = [f"actual->'{field}' IS DISTINCT FROM expected->'{field}'" for field in SORT_KEYS]
    checks += [f"actual->'{field}' IS DISTINCT FROM prior->'{field}'" for field in ["identity", "sequences", "sequenceStates", "creativeOtherRows"]]
    unchanged_tables = ",".join(literal(name) for name in sorted(CHANGED_TABLES))
    target_migrations = ",".join(literal(name) for name in MIGRATIONS)
    assertions = [f"""IF {' OR '.join(checks)} THEN RAISE EXCEPTION '051_CATALOG_IDENTITY_SEQUENCE_OR_OTHER_ROWS_CHANGED'; END IF;
 IF (SELECT jsonb_agg(v ORDER BY v->>'name') FROM jsonb_array_elements(actual->'tables') v WHERE v->>'name' NOT IN ({unchanged_tables}))
 IS DISTINCT FROM (SELECT jsonb_agg(v ORDER BY v->>'name') FROM jsonb_array_elements(prior->'tables') v WHERE v->>'name' NOT IN ({unchanged_tables}))
 OR (SELECT jsonb_agg(v->'name' ORDER BY v->>'name') FROM jsonb_array_elements(actual->'tables') v)
 IS DISTINCT FROM (SELECT jsonb_agg(v->'name' ORDER BY v->>'name') FROM jsonb_array_elements(prior->'tables') v)
 THEN RAISE EXCEPTION '051_ORIGINAL_BUSINESS_ROWS_CHANGED'; END IF;
 IF (SELECT coalesce(jsonb_agg(v ORDER BY v->>'name'),'[]'::jsonb) FROM jsonb_array_elements(actual->'migrations') v WHERE v->>'name' NOT IN ({target_migrations}))
 IS DISTINCT FROM prior->'migrations'
 OR (SELECT count(*) FROM schema_migrations WHERE name IN ({target_migrations}) AND applied_at=now())<>2
 THEN RAISE EXCEPTION '051_MIGRATION_DELTA_REJECTED'; END IF;
 IF NOT ({dependency_condition(options)}) THEN RAISE EXCEPTION '051_DEPENDENCIES_OR_STATISTICS_CHANGED'; END IF;"""]
    for name in sorted(CHANGED_TABLES):
        delta = 2 if name == "schema_migrations" else len(missing[name])
        assertions.append(f"IF (SELECT (v->>'count')::bigint FROM jsonb_array_elements(actual->'tables') v WHERE v->>'name'={literal(name)}) IS DISTINCT FROM (SELECT (v->>'count')::bigint+{delta} FROM jsonb_array_elements(prior->'tables') v WHERE v->>'name'={literal(name)}) THEN RAISE EXCEPTION '051_SCOPED_TABLE_COUNT_INVALID'; END IF;")
    for (table, key), row in scope_map(before).items():
        predicate = f"v->>'table'={literal(table)} AND v->>'key'={literal(key)}"
        if key not in missing[table]:
            assertions.append(f"IF (SELECT v FROM jsonb_array_elements(actual->'creativeScopes') v WHERE {predicate}) IS DISTINCT FROM {support.json_sql(row)} THEN RAISE EXCEPTION '051_EXISTING_SCOPED_ROW_CHANGED'; END IF;")
        else:
            assertions.append(f"IF (SELECT (v->>'count')::int FROM jsonb_array_elements(actual->'creativeScopes') v WHERE {predicate}) IS DISTINCT FROM 1 THEN RAISE EXCEPTION '051_EXACTLY_ONE_NEW_SCOPED_ROW_REQUIRED'; END IF;")
    for key in missing["module_flags"]:
        expected = f"jsonb_build_object('module_key',{literal(key)},'enabled',true,'updated_by',NULL,'updated_at',now())"
        assertions.append(f"IF (SELECT to_jsonb(t) FROM module_flags t WHERE module_key={literal(key)}) IS DISTINCT FROM {expected} THEN RAISE EXCEPTION '051_NEW_FLAG_ROW_INVALID'; END IF;")
    for key in missing["tool_api_configurations"]:
        expected = f"jsonb_build_object('tool_key',{literal(key)},'model_config_id',({FLARE_QUERY}),'enabled',true,'updated_by',NULL,'created_at',now(),'updated_at',now(),'credit_cost_override',NULL,'rmb_cost_override',NULL,'configuration_version',1,'allow_raw_prompt',false)"
        assertions.append(f"IF (SELECT to_jsonb(t) FROM tool_api_configurations t WHERE tool_key={literal(key)}) IS DISTINCT FROM {expected} THEN RAISE EXCEPTION '051_NEW_TOOL_ROW_INVALID'; END IF;")
    for row in seed["recipes"]:
        if row["key"] not in version_ids: continue
        key, version_id = literal(row["key"]), literal(version_ids[row["key"]])
        settings = support.json_sql({"name": row["name"], "enabled": True, "modelConfigId": options["optimizerModelConfigId"], "failurePolicy": "stop"})
        expected_recipe = f"jsonb_build_object('key',{key},'settings',{settings},'current_version_id',{version_id},'updated_at',{STAMP})"
        expected_version = f"jsonb_build_object('id',{version_id},'recipe_key',{key},'version',1,'content_hash',{literal(row['contentHash'])},'content',{support.json_sql(row['content'])},'created_by',{literal(options['actorId'])},'created_at',{STAMP})"
        assertions += [f"IF (SELECT to_jsonb(t) FROM prompt_recipes t WHERE key={key}) IS DISTINCT FROM {expected_recipe} THEN RAISE EXCEPTION '051_NEW_RECIPE_ROW_INVALID'; END IF;",
                       f"IF (SELECT to_jsonb(t) FROM prompt_recipe_versions t WHERE id={version_id}) IS DISTINCT FROM {expected_version} THEN RAISE EXCEPTION '051_NEW_VERSION_ROW_INVALID'; END IF;"]
    return (f"DO $creative051guard$ DECLARE actual jsonb; prior jsonb := {support.json_sql(before)}; expected jsonb := {support.json_sql(expected_catalog(before, catalog))}; BEGIN\n"
            f"actual := ({snapshot_query()});\n" + "\n".join(assertions) + "\nEND $creative051guard$;")


def migration_sql(before, catalog, sql, seed, options):
    validate_seed(seed)
    options_value(options["actorId"], options["optimizerModelConfigId"])
    expected_catalog(before, catalog)
    require(not {row["name"] for row in before["migrations"]} & set(MIGRATIONS), "051_MIGRATION_ALREADY_PRESENT")
    tables = [row["name"] for row in before["tables"]]
    require(CHANGED_TABLES <= set(tables), "051_PREVIOUS_TABLE_SET_REQUIRED")
    identifiers = ",".join('public."' + name.replace('"', '""') + '"' for name in tables)
    version_ids = {key: str(uuid.uuid4()) for key in missing_scopes(before)["prompt_recipes"]}
    return ("BEGIN; SET LOCAL search_path=public; SET LOCAL standard_conforming_strings=on; SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='300s'; "
            "SET LOCAL idle_in_transaction_session_timeout='330s';\n"
            f"LOCK TABLE {identifiers} IN SHARE MODE;\n"
            f"DO $creative051before$ DECLARE actual jsonb; prior jsonb := {support.json_sql(before)}; BEGIN actual := ({snapshot_query()}); "
            "IF actual IS DISTINCT FROM prior THEN RAISE EXCEPTION '051_STOPPED_BASELINE_DRIFT'; END IF; "
            f"IF NOT ({dependency_condition(options)}) THEN RAISE EXCEPTION '051_DEPENDENCIES_OR_STATISTICS_INVALID'; END IF; END $creative051before$;\n"
            + sql + "\n" + seed_sql(before, seed, options, version_ids)
            + "\nINSERT INTO schema_migrations(name) VALUES " + ",".join("(" + literal(name) + ")" for name in MIGRATIONS) + ";\n"
            + guard_sql(before, catalog, seed, options, version_ids) + "\nCOMMIT;\n")


class Creative050051(support.Usage048):
    def sql(self, name, label):
        if name != "database-state.sql": return super().sql(name, label)
        value = self.raw_sql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; SET LOCAL statement_timeout='60s';\n" + snapshot_query() + ";\nCOMMIT;", label)
        return json.loads(value)

    def dependencies(self, options, label):
        value = self.raw_sql("BEGIN READ ONLY; SET LOCAL search_path=public; SET LOCAL statement_timeout='10s'; SELECT " + dependency_condition(options) + "; COMMIT;", label)
        require(value.strip() == b"t", "051_ENABLED_ADMIN_CHAT_FLARE_AND_DISABLED_STATISTICS_REQUIRED")

    def preflight_creative(self, package, options):
        release, catalog, seed = verify_creative_package(package)
        self.new_audit("creative-050-051-preflight")
        self.assert_platform(release)
        current = self.capture("051-preflight")
        require(current["database"]["identity"]["database"] == self.instance["database"]["name"], "051_DATABASE_NAME_MISMATCH")
        validate_source_migrations(current["database"], release, self.instance)
        expected_catalog(current["database"], catalog)
        missing = missing_scopes(current["database"])
        self.dependencies(options, "051-preflight-dependencies")
        self.gate("verify-open")
        write_new_json(self.audit / "preflight.json", {"schema": 1, "kind": "creative-050-051-preflight", "createdAt": time.time(),
                       "instanceSha256": sha_file(self.instance_path), "manifestSha256": sha_file(package / "release-manifest.json"),
                       "payloadHashes": payload_hashes(package), "package": str(package), "options": options, "baseline": current})
        return {"status": "050-051-preflight-passed", "audit": str(self.audit), "mutations": False,
                "newRecipeKeys": missing["prompt_recipes"], "existingRecipesPreserved": True}

    def migrate_creative(self, package, preflight, options):
        release, catalog, seed = verify_creative_package(package)
        prior = read_json(private_directory(preflight) / "preflight.json")
        validate_preflight(prior, package, self.instance_path, options)
        self.new_audit("creative-050-051-migrate")
        phase = "preparation"
        try:
            current = self.capture("051-migrate")
            require_unchanged(prior["baseline"]["configurationHashes"], current["configurationHashes"], "051_CONFIGURATION_DRIFT")
            assert_database_layout(prior["baseline"]["database"], current["database"])
            for field in ["functions", "triggers"]:
                require_unchanged(prior["baseline"]["database"][field], current["database"][field], "051_CATALOG_DRIFT_SINCE_PREFLIGHT")
            assert_rollback_source(current["model"], prior["baseline"]["model"], current["containers"], prior["baseline"]["containers"], self.instance)
            validate_source_migrations(current["database"], release, self.instance)
            expected_catalog(current["database"], catalog)
            self.assert_platform(release)
            self.dependencies(options, "051-before-maintenance-dependencies")
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
                require_unchanged(current["database"][field], baseline["database"][field], "051_CATALOG_DRIFT_DURING_DRAIN")
            self.backup_048()
            self.protected_and_database(baseline, "051-before-sql")
            # Drain/backup can take time. Rebind immediately before mutation,
            # and hash the exact in-memory SQL bytes that will be executed.
            validate_binding(prior, package, self.instance_path, options)
            sql = read_migration_sql(package, release)
            phase = "sql-outcome-unknown-until-verified"
            self.raw_sql(migration_sql(baseline["database"], catalog, sql, seed, options), "051-transaction", timeout=360)
            after = self.sql("database-state.sql", "051-after-sql")
            assert_delta(baseline["database"], after, catalog)
            self.dependencies(options, "051-after-sql-dependencies")
            assert_protected(baseline["containers"], self.inventory("051-after-sql"), self.instance)
            write_new_json(self.audit / "schema-after.private.json", after)
            phase = "schema-committed-original-start-pending"
            self.application_configuration_unchanged(baseline)
            self.start_original(baseline)
            self.wait_health(self.instance["localBaseUrl"])
            self.command(["docker", "exec", self.instance["containers"]["worker"], "bun", "src/worker-healthcheck.ts"])
            running = self.inventory("051-original-started")
            support.assert_same_original(baseline["containers"], running, baseline["model"], self.instance, True)
            assert_protected(baseline["containers"], running, self.instance)
            require_unchanged(after, self.sql("database-state.sql", "051-original-verified"), "051_DATABASE_CHANGED_DURING_ORIGINAL_RESTART")
            self.disabled("051-original-statistics-unchanged")
            assert_idle(self.sql("activity.sql", "051-original-idle"))
            self.application_configuration_unchanged(baseline)
            phase = "verified-gate-reopen-pending"
            self.gate("open"); self.gate("verify-open")
            self.wait_health(self.instance["publicBaseUrl"])
            receipt = {"schema": 1, "status": "050-051-migrated-fixed", "audit": str(self.audit), "instanceSha256": sha_file(self.instance_path),
                       "manifestSha256": sha_file(package / "release-manifest.json"), "payloadHashes": payload_hashes(package),
                       "databaseIdentity": after["identity"], "options": options,
                       "originalContainerIds": {role: container_map(running)[name]["Id"] for role, name in self.instance["containers"].items()},
                       "newRecipeKeys": missing_scopes(baseline["database"])["prompt_recipes"],
                       "existingBusinessRowsPreserved": True, "existingRecipesPreserved": True,
                       "processingEnabled": False, "normalIngressRestored": True}
            write_new_json(self.audit / "receipt.json", receipt)
            return receipt
        except Exception:
            write_new_json(self.audit / "failure.json", {"status": "failed", "phase": phase, "manualReviewRequired": True,
                           "automaticRetry": False, "automaticRestore": False, "maintenanceMayBeClosed": phase != "preparation"})
            raise


def main():
    parser = argparse.ArgumentParser(description="Fixed 050/051 migration and missing-only two-recipe installation; no image deployment")
    parser.add_argument("operation", choices=["preflight", "migrate"])
    parser.add_argument("instance"); parser.add_argument("package"); parser.add_argument("prior_audit", nargs="?")
    parser.add_argument("--actor", required=True); parser.add_argument("--optimizer-model", required=True)
    args = parser.parse_args()
    require(sys.platform == "linux", "LINUX_DEPLOYMENT_HOST_REQUIRED")
    require(not os.environ.get("DOCKER_HOST"), "EXPLICIT_LOCAL_DOCKER_REQUIRED")
    os.umask(0o077)
    package = Path(args.package)
    require(package.is_absolute() and package.is_dir() and not package.is_symlink(), "ABSOLUTE_PACKAGE_REQUIRED")
    require((args.prior_audit is not None) == (args.operation == "migrate"), "EXACT_PRIOR_AUDIT_ARGUMENT_REQUIRED")
    options = options_value(args.actor, args.optimizer_model)
    runner = Creative050051(args.instance)
    result = runner.preflight_creative(package, options) if args.operation == "preflight" else runner.migrate_creative(package, Path(args.prior_audit), options)
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    try: main()
    except (Rejected, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        error = sys.exc_info()[1]
        print("CREATIVE_050_051_REJECTED " + (str(error) if isinstance(error, Rejected) else "PRIVATE_OPERATION_FAILED"), file=sys.stderr)
        sys.exit(1)
