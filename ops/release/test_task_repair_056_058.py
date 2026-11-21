import copy
import json
import os
from pathlib import Path
import unittest
import uuid

import artifact
import task_repair_056_058 as repair
from contract import Rejected
import test_usage_048_docker as docker_fixture

ROOT = Path(__file__).resolve().parents[2]
COMBINED = {"migrations": artifact.migrations(ROOT)}
RELEASE = {"migrations": [r for r in COMBINED["migrations"] if r["name"] < "059"]}
LEDGER = repair.before_release(RELEASE)["migrations"]
STATE = (ROOT / "ops/release/database-state.sql").read_text(encoding="utf8")
FIXTURE = """
CREATE EXTENSION pgcrypto;
CREATE TABLE schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE tasks(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text,attempts int,upstream_task_id text,
 upstream_submission_started_at timestamptz, failure_reason text,upstream_result_document jsonb);
CREATE TABLE credit_ledger(id int, amount int);
INSERT INTO credit_ledger VALUES(1,80);
INSERT INTO tasks(status,attempts,upstream_task_id,upstream_submission_started_at) VALUES
 ('paused',1,'known-upstream',now()),('paused',1,NULL,now()),('completed',1,'finished',now());
""" + "\n".join("INSERT INTO schema_migrations(name) VALUES ('" + r["name"] + "');" for r in LEDGER)


class RepairContracts(unittest.TestCase):
    def test_reject_partial_future_tampered_or_already_migrated(self):
        for rows in [RELEASE["migrations"][:-1], RELEASE["migrations"] + [{"name":"059_future.sql"}]]:
            with self.assertRaises(Rejected): repair.before_release({"migrations": rows})
        tampered = copy.deepcopy(RELEASE)
        tampered["migrations"][-1]["sha256"] = "0"*64
        with self.assertRaisesRegex(Rejected, "REPAIR_SQL_HASH_MISMATCH"):
            repair.sql_payload(ROOT, tampered)
        with self.assertRaises(Rejected):
            repair.transaction(ROOT, RELEASE, {"retainedMigrationNames":[]}, RELEASE)


class SqlScenarios:
    def tryout_tables(self):
        self.psql("""
CREATE TABLE assets(id uuid PRIMARY KEY);
CREATE TABLE providers(id uuid PRIMARY KEY);
CREATE TABLE users(id uuid PRIMARY KEY);
CREATE TABLE module_flags(module_key text PRIMARY KEY, enabled boolean NOT NULL,
 CONSTRAINT module_flags_module_key_check CHECK(module_key IN ('canvas','assets')));
INSERT INTO module_flags VALUES('canvas',true),('assets',false);
""", self.database)

    def test_combined_tail_from_055_adds_only_reviewed_rows_and_rejects_rerun(self):
        self.tryout_tables()
        before = self.snapshot()
        self.psql(repair.transaction(ROOT, COMBINED, self.instance, before), self.database)
        after = self.snapshot()
        repair.verify_after(before, after, COMBINED, self.instance)
        self.assertEqual(self.psql("SELECT module_key,enabled FROM module_flags ORDER BY module_key", self.database).stdout.strip(),
                         "assets|f\ncanvas|t\ncanvas-tryout|f")
        with self.assertRaises(Rejected):
            repair.transaction(ROOT, COMBINED, self.instance, after)

    def test_late_flag_trigger_rolls_back_all_six_migrations(self):
        self.tryout_tables()
        self.psql("""CREATE FUNCTION unexpected_flag_update() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN UPDATE module_flags SET enabled=false WHERE module_key='canvas'; RETURN NEW; END $$;
 CREATE TRIGGER flag_side_effect AFTER INSERT ON module_flags FOR EACH ROW EXECUTE FUNCTION unexpected_flag_update();""", self.database)
        before = self.snapshot()
        outcome = self.psql(repair.transaction(ROOT, COMBINED, self.instance, before), self.database, check=False)
        self.assertNotEqual(outcome.returncode, 0)
        self.assertIn("TRYOUT_FLAGS_CHANGED", outcome.stderr)
        self.assertEqual(before, self.snapshot())

    def snapshot(self):
        return json.loads(self.psql(STATE, self.database).stdout)

    def setUp(self):
        self.database = "usage048_" + uuid.uuid4().hex
        self.psql(f'CREATE DATABASE "{self.database}"', "postgres")
        self.psql(FIXTURE, self.database)
        self.instance = {"retainedMigrationNames": [], "database":{"name": self.database}}

    def test_only_known_upstream_is_scheduled_and_rerun_refused(self):
        before = self.snapshot()
        self.psql(repair.transaction(ROOT, RELEASE, self.instance, before), self.database)
        after = self.snapshot()
        repair.verify_after(before, after, RELEASE, self.instance)
        rows = self.psql("SELECT paused_kind, next_repair_at IS NOT NULL FROM tasks WHERE status='paused' ORDER BY paused_kind", self.database).stdout.strip()
        self.assertEqual(rows, "awaiting_query|t\nsubmission_unknown|f")
        with self.assertRaises(Rejected):
            repair.transaction(ROOT, RELEASE, self.instance, after)

    def test_credit_side_effect_causes_atomic_rollback_including_first_ddl(self):
        self.psql("CREATE FUNCTION touch_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE credit_ledger SET amount=0; RETURN NEW; END $$; CREATE TRIGGER unexpected_side_effect AFTER UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION touch_credit();", self.database)
        before = self.snapshot()
        result = self.psql(repair.transaction(ROOT, RELEASE, self.instance, before), self.database, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("REPAIR_UNRELATED_ROWS_CHANGED", result.stderr)
        self.assertEqual(before, self.snapshot())


@unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "requires isolated PostgreSQL 17 container")
class RepairPostgres17(SqlScenarios, unittest.TestCase):
    docker = classmethod(docker_fixture.Usage048DockerPostgres17.docker.__func__)
    remove_owned_container = classmethod(docker_fixture.Usage048DockerPostgres17.remove_owned_container.__func__)
    setUpClass = classmethod(docker_fixture.Usage048DockerPostgres17.setUpClass.__func__)
    tearDownClass = classmethod(docker_fixture.Usage048DockerPostgres17.tearDownClass.__func__)
    psql = classmethod(docker_fixture.Usage048DockerPostgres17.psql.__func__)
