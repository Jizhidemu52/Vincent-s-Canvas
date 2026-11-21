"""Prepare the exact reviewed schema tail from 055 before an image switch."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import time

from contract import (Rejected, TASK_REPAIR_MIGRATIONS, TRYOUT_MIGRATIONS, assert_database_layout, assert_migrations,
                      assert_protected, digest, digest_file, read_json, require, verify_package, write_new_json)
from deploy import Deployment, assert_rollback_source, compose_literals, private_directory, require_unchanged

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("usage048_support", HERE / "usage-048.py")
support = importlib.util.module_from_spec(spec)
spec.loader.exec_module(support)
PREVIOUS = "055_mai27_model_catalog.sql"
FIELDS = ("paused_kind", "repair_attempts", "next_repair_at", "repair_error_code", "original_size_source_id", "reference_download_recheck_at")


TRYOUT_TABLES = {"material_presets", "provider_upload_cache", "provider_upload_task_inputs", "asset_fact_cards", "asset_product_card_overrides", "model_presets", "user_model_defaults"}


def reviewed_tail(release):
    names = tuple(row["name"] for row in release["migrations"] if row["name"] >= "055")
    for tail in (TASK_REPAIR_MIGRATIONS, TASK_REPAIR_MIGRATIONS + TRYOUT_MIGRATIONS):
        if names == (PREVIOUS, *tail):
            return tail
    raise Rejected("EXPECTED_REVIEWED_TAIL_FROM_055")


def before_release(release):
    return {**release, "migrations": release["migrations"][:-len(reviewed_tail(release))]}


def sql_payload(package, release):
    before_release(release)
    statements = []
    for row in release["migrations"][-len(reviewed_tail(release)):]:
        path = package / "server/src/migrations" / row["name"]
        require(path.is_file() and not path.is_symlink(), "REPAIR_REGULAR_SQL_REQUIRED")
        raw = path.read_bytes()
        require(digest(raw) == row["sha256"], "REPAIR_SQL_HASH_MISMATCH")
        statements.append(raw.decode("utf-8") + f"\nINSERT INTO public.schema_migrations(name) VALUES ('{row['name']}');")
    return "\n".join(statements)


def transaction(package, release, instance, baseline):
    expected = before_release(release)
    old_names = [row["name"] for row in baseline["migrations"]]
    assert_migrations(old_names, expected, instance)
    require(not set(old_names).intersection(TASK_REPAIR_MIGRATIONS), "REPAIR_ALREADY_REGISTERED")
    require(baseline["identity"]["database"] == instance["database"]["name"], "REPAIR_DATABASE_MISMATCH")
    names = ",".join("'" + name + "'" for name in sorted(old_names))
    fields = ",".join("'" + field + "'" for field in FIELDS)
    def fingerprint(value):
        return f"SELECT sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(({value})::text,'UTF8')),'hex'),'' ORDER BY id),''),'UTF8')) AS hash FROM public.tasks t"
    identity = support.json_sql(baseline["identity"])
    combined = reviewed_tail(release)[-1] == TRYOUT_MIGRATIONS[-1]
    exempt = {"tasks", "schema_migrations"}
    before_flags = after_flags = ""
    if combined:
        require(not TRYOUT_TABLES.intersection(row["name"] for row in baseline["tables"]), "TRYOUT_TABLE_ALREADY_EXISTS")
        exempt.update({"module_flags", *TRYOUT_TABLES})
        before_flags = """LOCK TABLE public.module_flags IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT FROM public.module_flags WHERE module_key='canvas-tryout') THEN RAISE EXCEPTION 'TRYOUT_FLAG_ALREADY_EXISTS'; END IF;
END $$;
CREATE TEMP TABLE prior_flags ON COMMIT DROP AS SELECT to_jsonb(f) AS row FROM public.module_flags f;"""
        after_flags = """IF NOT EXISTS (SELECT FROM public.module_flags WHERE module_key='canvas-tryout' AND enabled IS FALSE)
 OR EXISTS ((SELECT row FROM pg_temp.prior_flags EXCEPT ALL SELECT to_jsonb(f) FROM public.module_flags f WHERE module_key<>'canvas-tryout')
 UNION ALL (SELECT to_jsonb(f) FROM public.module_flags f WHERE module_key<>'canvas-tryout' EXCEPT ALL SELECT row FROM pg_temp.prior_flags))
 THEN RAISE EXCEPTION 'TRYOUT_FLAGS_CHANGED'; END IF;
 IF (SELECT array_agg(name ORDER BY sort_order) FROM public.material_presets) IS DISTINCT FROM ARRAY['粗针','罗纹','绞花','马海毛','摇粒绒','灯芯绒']::text[]
 OR EXISTS (SELECT FROM public.material_presets WHERE status<>'published' OR thumb_asset_id IS NOT NULL)
 OR EXISTS (SELECT FROM public.model_presets) OR EXISTS (SELECT FROM public.user_model_defaults) OR EXISTS (SELECT FROM public.asset_fact_cards) OR EXISTS (SELECT FROM public.asset_product_card_overrides) OR EXISTS (SELECT FROM public.provider_upload_cache) OR EXISTS (SELECT FROM public.provider_upload_task_inputs)
 THEN RAISE EXCEPTION 'TRYOUT_UNSAFE_INITIAL_STATE'; END IF;"""
    exclusions = ",".join("'" + name + "'" for name in sorted(exempt))
    protected = support.json_sql([row for row in baseline["tables"] if row["name"] not in exempt])
    state_query = (package / "ops/release/database-state.sql").read_text(encoding="utf-8").strip().rstrip(";")
    return f"""BEGIN;
SET LOCAL search_path=public,pg_catalog;
SET LOCAL lock_timeout='10s';
SET LOCAL statement_timeout='5min';
LOCK TABLE public.tasks,public.schema_migrations IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF jsonb_build_object('database',current_database(),'schema',current_schema(),'systemIdentifier',(SELECT system_identifier::text FROM pg_control_system()))
    IS DISTINCT FROM {identity} THEN RAISE EXCEPTION 'REPAIR_DATABASE_IDENTITY_DRIFT'; END IF;
 IF (SELECT array_agg(name ORDER BY name COLLATE "C") FROM public.schema_migrations) IS DISTINCT FROM ARRAY[{names}]::text[]
 THEN RAISE EXCEPTION 'REPAIR_LEDGER_DRIFT'; END IF;
END $$;
CREATE TEMP TABLE repair_before ON COMMIT DROP AS {fingerprint('to_jsonb(t)')};
{before_flags}
{sql_payload(package, release)}
DO $$ BEGIN
 {after_flags}
 IF ({fingerprint('to_jsonb(t) - ARRAY[' + fields + ']::text[]')}) IS DISTINCT FROM (SELECT hash FROM pg_temp.repair_before)
 THEN RAISE EXCEPTION 'REPAIR_OLD_TASK_ROWS_CHANGED'; END IF;
 IF EXISTS (SELECT FROM public.tasks WHERE repair_attempts<>0 OR original_size_source_id IS NOT NULL OR reference_download_recheck_at IS NOT NULL
   OR (next_repair_at IS NOT NULL AND (status<>'paused' OR paused_kind IS NULL OR paused_kind NOT IN ('result_repair','awaiting_query') OR nullif(btrim(upstream_task_id),'') IS NULL)))
 THEN RAISE EXCEPTION 'REPAIR_UNSAFE_INITIAL_STATE'; END IF;
 IF (SELECT coalesce(jsonb_agg(r ORDER BY r->>'name'),'[]'::jsonb)
     FROM jsonb_array_elements(({state_query})->'tables') r WHERE r->>'name' NOT IN ({exclusions}))
     IS DISTINCT FROM {protected} THEN RAISE EXCEPTION 'REPAIR_UNRELATED_ROWS_CHANGED'; END IF;
END $$;
COMMIT;"""


def verify_after(before, after, release, instance):
    assert_migrations([row["name"] for row in after["migrations"]], release, instance)
    require_unchanged(before["identity"], after["identity"], "REPAIR_DATABASE_CHANGED")
    require_unchanged(before["sequences"], after["sequences"], "REPAIR_SEQUENCES_CHANGED")
    tail = reviewed_tail(release)
    require_unchanged(before["migrations"], [row for row in after["migrations"] if row["name"] not in tail], "REPAIR_OLD_LEDGER_CHANGED")
    old = {row["name"]: row for row in before["tables"]}
    new = {row["name"]: row for row in after["tables"]}
    combined = tail[-1] == TRYOUT_MIGRATIONS[-1]
    require(set(new) == set(old) | (TRYOUT_TABLES if combined else set()), "REPAIR_TABLES_CHANGED")
    for name in old:
        if combined and name == "module_flags":
            require(new[name]["count"] == old[name]["count"] + 1, "TRYOUT_FLAGS_CHANGED")
            continue
        if name not in ("tasks", "schema_migrations"):
            require_unchanged(old[name], new[name], "REPAIR_UNRELATED_ROWS_CHANGED")
    require(new["tasks"]["count"] == old["tasks"]["count"] and new["schema_migrations"]["count"] == old["schema_migrations"]["count"] + len(tail), "REPAIR_ROW_COUNT_CHANGED")
    if combined:
        require([new[name]["count"] for name in sorted(TRYOUT_TABLES)] == [0, 0, 6, 0, 0, 0, 0], "TRYOUT_UNSAFE_INITIAL_STATE")


class Preparation(support.Usage048):
    sql = Deployment.sql

    def preflight(self, package):
        release = verify_package(package)
        kind = "repair-056-" + reviewed_tail(release)[-1][:3]
        self.new_audit(kind + "-preflight")
        self.assert_platform(release)
        baseline = self.capture("repair-preflight")
        transaction(package, release, self.instance, baseline["database"])
        self.gate("verify-open")
        record = {"kind": kind, "createdAt": time.time(), "package": str(package),
                  "instance": digest_file(self.instance_path), "manifest": digest_file(package / "release-manifest.json"), "baseline": baseline}
        write_new_json(self.audit / "preflight.json", record)
        return {"status": "preflight-passed", "audit": str(self.audit), "mutations": False}

    def migrate(self, package, prior_dir):
        release = verify_package(package)
        prior = read_json(private_directory(prior_dir) / "preflight.json")
        kind = "repair-056-" + reviewed_tail(release)[-1][:3]
        def fresh():
            require(prior["kind"] == kind and prior["package"] == str(package)
                    and prior["instance"] == digest_file(self.instance_path) and prior["manifest"] == digest_file(package / "release-manifest.json")
                    and 0 <= time.time()-prior["createdAt"] <= 900, "REPAIR_FRESH_SAME_TARGET_PREFLIGHT_REQUIRED")
        fresh()
        self.new_audit(kind + "-migrate")
        phase = "preparation"
        try:
            current = self.capture("repair-prepare")
            original = prior["baseline"]
            assert_database_layout(original["database"], current["database"])
            assert_rollback_source(current["model"], original["model"], current["containers"], original["containers"], self.instance)
            require_unchanged(original["configurationHashes"], current["configurationHashes"], "REPAIR_CONFIG_DRIFT")
            transaction(package, release, self.instance, current["database"])
            self.assert_platform(release)
            require(shutil.disk_usage(self.root).free >= self.instance["minimumFreeBytes"], "INSUFFICIENT_DISK_SPACE")
            self.preparation_unchanged(current)
            self.gate("verify-open")
            phase = "maintenance"
            self.gate("close"); self.gate("verify-closed")
            self.wait_for_drain()
            model = self.audit / "original.private.json"
            write_new_json(model, compose_literals(current["model"]))
            baseline = self.freeze_stopped_baseline(current, self.stop_app(model))
            self.backup_048()
            self.protected_and_database(baseline, "repair-before-sql")
            fresh()
            body = transaction(package, release, self.instance, baseline["database"])
            phase = "sql-outcome-requires-verification"
            self.raw_sql(body, "repair-atomic-sql", timeout=390)
            after = self.sql("database-state.sql", "repair-after")
            verify_after(baseline["database"], after, release, self.instance)
            phase = "verified-schema-restart"
            self.application_configuration_unchanged(baseline)
            self.start_original(baseline)
            self.wait_health(self.instance["localBaseUrl"])
            self.command(["docker", "exec", self.instance["containers"]["worker"], "bun", "src/worker-healthcheck.ts"])
            running = self.inventory("repair-original")
            support.assert_same_original(baseline["containers"], running, baseline["model"], self.instance, True)
            assert_protected(baseline["containers"], running, self.instance)
            self.protected_and_database({**baseline, "database": after}, "repair-original-ready")
            self.gate("open"); self.gate("verify-open")
            self.wait_health(self.instance["publicBaseUrl"])
            result = {"status":kind.removeprefix("repair-") + "-prepared", "audit":str(self.audit), "manifest":prior["manifest"], "originalApplicationRestored":True}
            write_new_json(self.audit / "receipt.json", result)
            return result
        except Exception:
            write_new_json(self.audit / "failure.json", {"phase":phase, "automaticRetry":False, "manualReviewRequired":True})
            raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("preflight", "migrate"))
    parser.add_argument("instance"); parser.add_argument("package"); parser.add_argument("prior", nargs="?")
    args = parser.parse_args()
    require(sys.platform == "linux" and not os.environ.get("DOCKER_HOST"), "LOCAL_LINUX_DOCKER_REQUIRED")
    os.umask(0o077)
    root = Path(args.package)
    require(root.is_absolute() and root.is_dir() and not root.is_symlink(), "ABSOLUTE_PACKAGE_REQUIRED")
    require((root / "ops/release").resolve() == HERE, "USE_VERIFIED_PACKAGE_TOOL")
    require((args.prior is not None) == (args.operation == "migrate"), "EXACT_PRIOR_AUDIT_REQUIRED")
    runner = Preparation(args.instance)
    result = runner.preflight(root) if args.operation == "preflight" else runner.migrate(root, Path(args.prior))
    print(json.dumps(result))


if __name__ == "__main__":
    try: main()
    except Exception as exc:
        print("TASK_REPAIR_REJECTED " + (str(exc) if isinstance(exc, Rejected) else "PRIVATE_OPERATION_FAILED"), file=sys.stderr)
        sys.exit(1)
