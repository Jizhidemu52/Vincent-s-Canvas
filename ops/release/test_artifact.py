import copy
import unittest
from pathlib import Path
import tempfile

import artifact
from contract import Rejected, digest
from test_contract import manifest


class ArtifactContracts(unittest.TestCase):
    def receipt(self):
        value = manifest()
        return {"schema": 1, "status": "passed", "commit": value["commit"],
                "imageIds": copy.deepcopy(value["verification"]["imageIds"]),
                "checks": ["login", "upload", "canvas-image", "refresh-recovery", "original-download", "video-task", "chat"]}

    def test_all_seven_real_paths_on_the_same_image_ids_are_required(self):
        value = artifact.seal_verification(manifest(), self.receipt(), "123")
        self.assertEqual(value["status"], "passed")
        self.assertEqual(value["checks"], ["runtime", "production-stack", "browser-smoke"])

    def test_missing_path_or_changed_image_cannot_be_sealed(self):
        for field in ["checks", "imageIds", "commit", "status"]:
            receipt = self.receipt()
            if field == "checks": receipt[field].pop()
            elif field == "imageIds": receipt[field]["api"] = "sha256:" + "0" * 64
            else: receipt[field] = "different"
            with self.assertRaises(Rejected): artifact.seal_verification(manifest(), receipt, "123")

    def test_package_allowlist_never_includes_environment_database_or_private_recipes(self):
        self.assertIn("ops/release/deploy.py", artifact.PACKAGE_FILES)
        self.assertIn("ops/baota/gate.py", artifact.PACKAGE_FILES)
        self.assertFalse(any(".env" in path or "output" in path or "recipe" in path for path in artifact.PACKAGE_FILES))
        self.assertEqual([path for path in artifact.PACKAGE_FILES if path.startswith("server/src/migrations/")], ["server/src/migrations/048_usage_daily_facts.sql"])
        for name in ["usage-048.py", "usage-048-state.sql", "usage-048-catalog.json"]:
            self.assertIn("ops/release/" + name, artifact.PACKAGE_FILES)

    def test_048_payload_is_bound_to_migration_manifest_not_just_file_inventory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "server/src/migrations/048_usage_daily_facts.sql"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"reviewed SQL")
            value = {"migrations": [{"name": path.name, "sha256": digest(path.read_bytes())}]}
            artifact.verify_048_payload(root, value)
            for changed in ["changed SQL", ""]:
                path.write_text(changed, encoding="utf-8")
                with self.assertRaisesRegex(Rejected, "048_SQL_MIGRATION_HASH_MISMATCH"):
                    artifact.verify_048_payload(root, value)
            with self.assertRaisesRegex(Rejected, "FIXED_048_MIGRATION_REQUIRED"):
                artifact.verify_048_payload(root, {"migrations": []})
            later = {"migrations": value["migrations"] + [{"name": "049_unreviewed.sql", "sha256": "0" * 64}]}
            with self.assertRaisesRegex(Rejected, "FIXED_048_MIGRATION_REQUIRED"):
                artifact.verify_048_payload(root, later)


if __name__ == "__main__": unittest.main()
