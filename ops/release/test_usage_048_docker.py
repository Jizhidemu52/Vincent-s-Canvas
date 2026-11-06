"""Real PostgreSQL 17 checks in one owned, networkless, tmpfs-only container.

Opt-in CI only. No application env, remote Docker context, host port, bind mount,
persistent volume, provider request, or production database is used.
"""
import copy
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import unittest
import uuid


HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
MIGRATIONS = ROOT / "server/src/migrations"
spec = importlib.util.spec_from_file_location("usage_048_docker_operator", HERE / "usage-048.py")
operator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(operator)
CATALOG = json.loads((HERE / "usage-048-catalog.json").read_text(encoding="utf-8"))
MIGRATION_SQL = (MIGRATIONS / operator.MIGRATION).read_text(encoding="utf-8")
USER_ID = "04800000-0000-4000-8000-000000000001"
TASK_ID = "04800000-0000-4000-8000-000000000002"


@unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true",
                     "requires explicit CI Docker opt-in; PostgreSQL 17 was not run")
class Usage048DockerPostgres17(unittest.TestCase):
    @classmethod
    def docker(cls, *arguments, sql=None, timeout=60, check=True):
        result = subprocess.run([cls.docker_binary, "--host", "unix:///var/run/docker.sock", *arguments],
                                input=sql, capture_output=True, text=True, encoding="utf-8",
                                timeout=timeout, env=cls.docker_environment)
        if check and result.returncode:
            raise AssertionError("Owned PostgreSQL test command failed: " + result.stderr[-4000:])
        return result

    @classmethod
    def remove_owned_container(cls):
        # A timed-out `run` may still have created our container. Resolve only
        # the exact generated name and verify its ownership label before removal.
        target = cls.container_id or cls.container_name
        result = cls.docker("inspect", target, check=False)
        if result.returncode:
            if "No such object" in result.stderr or "No such container" in result.stderr:
                return
            raise AssertionError("Unable to verify owned test-container cleanup: " + result.stderr[-1000:])
        rows = json.loads(result.stdout)
        if (len(rows) != 1 or rows[0].get("Name") != "/" + cls.container_name
                or rows[0].get("Config", {}).get("Labels", {}).get("canvas.usage048-test") != cls.owner
                or (cls.container_id and rows[0].get("Id") != cls.container_id)):
            raise AssertionError("Refusing to remove an unverified test container")
        cls.docker("rm", "--force", rows[0]["Id"], timeout=60)

    @classmethod
    def setUpClass(cls):
        cls.docker_binary = shutil.which("docker")
        if not cls.docker_binary or not Path("/var/run/docker.sock").is_socket():
            raise AssertionError("Enabled PostgreSQL 17 test requires the local CI Docker Unix socket")
        cls.docker_environment = dict(os.environ)
        for key in ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]:
            cls.docker_environment.pop(key, None)
        cls.owner = uuid.uuid4().hex
        cls.container_name = "canvas-usage048-test-" + cls.owner
        cls.container_id = None
        try:
            launched = cls.docker("run", "--detach", "--name", cls.container_name,
                                  "--label", "canvas.usage048-test=" + cls.owner,
                                  "--network", "none", "--restart", "no", "--memory", "768m", "--pids-limit", "128",
                                  "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,noexec,size=384m",
                                  "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_USER=usage048test",
                                  "postgres:17-alpine", "-c", "listen_addresses=", timeout=180)
            cls.container_id = launched.stdout.strip()
            if not re.fullmatch(r"[0-9a-f]{64}", cls.container_id):
                cls.container_id = None
                raise AssertionError("Docker did not return one exact test container ID")
            inspection = json.loads(cls.docker("inspect", cls.container_id).stdout)[0]
            if (inspection["HostConfig"].get("NetworkMode") != "none"
                    or inspection["HostConfig"].get("PortBindings")
                    or any(mount.get("Type") in ["bind", "volume"] for mount in inspection.get("Mounts", []))
                    or "/var/lib/postgresql/data" not in inspection["HostConfig"].get("Tmpfs", {})):
                raise AssertionError("PostgreSQL test isolation or tmpfs contract was not preserved")
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                logs = cls.docker("logs", cls.container_id)
                initialized = "PostgreSQL init process complete; ready for start up." in logs.stdout + logs.stderr
                ready = cls.docker("exec", cls.container_id, "pg_isready", "-q", "-U", "usage048test", "-d", "postgres", check=False)
                if initialized and ready.returncode == 0:
                    break
                time.sleep(0.25)
            else:
                raise AssertionError("Owned PostgreSQL 17 did not become ready within 60 seconds")
            version = cls.psql("SHOW server_version_num;", "postgres").stdout.strip()
            if not version.isdigit() or not 170000 <= int(version) < 180000:
                raise AssertionError("The container is not running PostgreSQL 17")
        except BaseException:
            cls.remove_owned_container()
            raise

    @classmethod
    def tearDownClass(cls):
        cls.remove_owned_container()

    @classmethod
    def psql(cls, sql, database, check=True):
        if not re.fullmatch(r"(?:postgres|usage048_[0-9a-f]{32})", database):
            raise AssertionError("Unexpected disposable test database name")
        return cls.docker("exec", "-i", cls.container_id, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
                          "-U", "usage048test", "-d", database, sql=sql, timeout=360, check=check)

    def setUp(self):
        self.database = "usage048_" + uuid.uuid4().hex
        self.psql('CREATE DATABASE "' + self.database + '";', "postgres")
        names = sorted(path.name for path in MIGRATIONS.glob("*.sql") if path.name <= operator.MIGRATION)
        self.assertEqual(names[-1], operator.MIGRATION, "This fixed operator test only supports a release ending in 048")
        previous = [name for name in names if name != operator.MIGRATION]
        # Both historical 015 files are registered migrations; 048 therefore
        # follows 48 files, not 47. Preserve the exact filename inventory.
        self.assertEqual(len(previous), 48)
        bootstrap = ["CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now());"]
        for name in previous:
            self.assertRegex(name, r"^[0-9]{3}_[a-z0-9_]+\.sql$")
            bootstrap += ["BEGIN;", (MIGRATIONS / name).read_text(encoding="utf-8"),
                          "INSERT INTO schema_migrations(name) VALUES('" + name + "');", "COMMIT;"]
        # Representative nonempty business state makes preservation assertions
        # meaningful; no provider credentials or real user input are present.
        bootstrap += [
            "INSERT INTO users(id,username,display_name,role,must_change_password,credit_balance) "
            "VALUES('" + USER_ID + "','usage048-fixture','Original name','super_admin',false,73);",
            "INSERT INTO tasks(id,request_id,user_id,project_id,operation_type,status,queued_at) "
            "VALUES('" + TASK_ID + "','usage048-fixture','" + USER_ID + "','fixture','image_generation','paused','2026-09-01T01:00:00Z');",
        ]
        self.psql("\n".join(bootstrap), self.database)

    def snapshot(self):
        return json.loads(self.psql("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=public; "
                                   + operator.snapshot_query() + "; COMMIT;", self.database).stdout)

    def migrate(self, before, catalog=None, injected=""):
        return self.psql(operator.migration_sql(before, CATALOG if catalog is None else catalog, MIGRATION_SQL + "\n" + injected), self.database, check=False)

    def test_exact_pg17_catalog_and_migration_preserve_every_original_business_hash(self):
        before = self.snapshot()
        result = self.migrate(before)
        self.assertEqual(result.returncode, 0, result.stderr)
        after = self.snapshot()
        operator.assert_048_delta(before, after, CATALOG)
        # Exact equality with the committed catalog is intentional here: PG 17
        # catalog drift must fail CI before this package reaches a real host.
        for field, expected in operator.catalog_union(before, CATALOG).items():
            self.assertEqual(after[field], expected, field)
        for row in before["tables"]:
            if row["name"] != "schema_migrations":
                self.assertIn(row, after["tables"], row["name"])
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state;", self.database).stdout.strip(), "f")
        self.assertEqual(self.psql("SELECT count(*) FROM usage_source_invalidations;", self.database).stdout.strip(), "0")
        self.assertEqual(self.psql("SELECT count(*) FROM schema_migrations WHERE name='048_usage_daily_facts.sql';", self.database).stdout.strip(), "1")

    def test_wrong_expected_catalog_rolls_back_ddl_seed_and_registration(self):
        before = self.snapshot()
        wrong = copy.deepcopy(CATALOG)
        wrong["columns"][0]["column_default"] = "unexpected-default"
        result = self.migrate(before, catalog=wrong)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("048_CATALOG_IDENTITY_OR_SEQUENCE_DELTA_REJECTED", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_injected_old_business_write_rolls_back_entire_migration(self):
        before = self.snapshot()
        result = self.migrate(before, injected="UPDATE users SET display_name='Unauthorized mutation' WHERE id='" + USER_ID + "';")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("048_ORIGINAL_BUSINESS_ROWS_CHANGED", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_nonempty_source_invalidation_seed_rolls_back_entire_migration(self):
        before = self.snapshot()
        result = self.migrate(before, injected="INSERT INTO usage_source_invalidations(day) VALUES('2026-09-01');")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("048_DISABLED_SEED_DELTA_REJECTED", result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_control_roundtrip_changes_only_flag_and_preserves_all_data(self):
        result = self.migrate(self.snapshot())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.psql("""
INSERT INTO usage_rollup_jobs(idempotency_key,from_day,to_day,status,completed_days)
VALUES('048-control-fixture','2026-09-01','2026-09-02','running',ARRAY['2026-09-01']::date[]);
INSERT INTO usage_daily_facts(day,kind,fact_id,user_id,occurred_at,payload)
VALUES('2026-09-01','task','retained-fact','04800000-0000-4000-8000-000000000001','2026-09-01T01:00:00Z','{}');
INSERT INTO usage_daily_snapshots(day,metric_version,computed_at,fact_count,fact_bytes)
VALUES('2026-09-01','retained-version',now(),1,2);
UPDATE usage_dirty_days SET failure_code='RETAINED_FAILURE',failed_at=now() WHERE day='2026-09-01';
UPDATE usage_rollup_state SET last_scheduled_day='2026-09-01';
INSERT INTO usage_source_invalidations(day) VALUES('2026-09-01');
""", self.database)
        before = self.snapshot()
        state = self.psql("SELECT to_jsonb(s)-'processing_enabled' FROM usage_rollup_state s;", self.database).stdout
        self.psql(operator.control_sql(True, before["identity"], CATALOG), self.database)
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state;", self.database).stdout.strip(), "t")
        after_enable = self.snapshot()
        self.assertEqual(self.psql("SELECT to_jsonb(s)-'processing_enabled' FROM usage_rollup_state s;", self.database).stdout, state)
        for field in before:
            if field != "tables":
                self.assertEqual(after_enable[field], before[field], field)
        self.assertEqual([row for row in after_enable["tables"] if row["name"] != "usage_rollup_state"],
                         [row for row in before["tables"] if row["name"] != "usage_rollup_state"])
        self.psql(operator.control_sql(False, before["identity"], CATALOG), self.database)
        self.assertEqual(self.snapshot(), before, "Enable then disable must preserve every table hash, including non-flag state")

    def test_public_shadow_functions_cannot_bypass_the_exact_control_lock(self):
        result = self.migrate(self.snapshot())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.psql("""
CREATE FUNCTION public.pg_advisory_xact_lock(bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
CREATE FUNCTION public.hashtextextended(text,bigint) RETURNS bigint LANGUAGE sql AS $$ SELECT 7::bigint $$;
""", self.database)
        before = self.snapshot()
        control = operator.control_sql(True, before["identity"], CATALOG)
        prefix, commit, suffix = control.rpartition("\nCOMMIT;")
        self.assertTrue(commit and not suffix.strip(), "The production control transaction must have a terminal COMMIT")
        # Execute the production control SQL unchanged, adding only a read
        # immediately before COMMIT so its transaction-scoped lock is observable.
        probe = """
SELECT count(*) FROM pg_catalog.pg_locks
WHERE locktype='advisory' AND pid=pg_catalog.pg_backend_pid() AND granted
  AND mode='ExclusiveLock' AND objsubid=1
  AND classid::bigint=((pg_catalog.hashtextextended('canvas:usage-rollup-control:v1',0)>>32)&4294967295)
  AND objid::bigint=(pg_catalog.hashtextextended('canvas:usage-rollup-control:v1',0)&4294967295);
"""
        observed = self.psql(prefix + probe + commit + suffix, self.database).stdout.strip()
        self.assertEqual(observed, "1", "An actual exclusive lock on the backend's exact key must be held")
        self.assertEqual(self.psql("SELECT processing_enabled FROM usage_rollup_state;", self.database).stdout.strip(), "t")
        self.psql(operator.control_sql(False, before["identity"], CATALOG), self.database)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
