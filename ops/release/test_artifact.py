import copy
import json
import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch

import artifact
from contract import Rejected, digest, verify_package
import creative_seed
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
        self.assertEqual([path for path in artifact.PACKAGE_FILES if path.startswith("server/src/migrations/")], ["server/src/migrations/048_usage_daily_facts.sql", "server/src/migrations/049_quick_image_configurations.sql", "server/src/migrations/050_quick_image_item_extract.sql", "server/src/migrations/051_new_creative_scenes.sql"])
        self.assertNotIn(creative_seed.SOURCE_PATH, artifact.PACKAGE_FILES)
        self.assertNotIn(creative_seed.SEED_PATH, artifact.PACKAGE_FILES)  # generated, not copied from a mutable seed file
        for name in ["usage-048.py", "usage-048-state.sql", "usage-048-catalog.json"]:
            self.assertIn("ops/release/" + name, artifact.PACKAGE_FILES)
        for name in ["quick-image-049.py", "quick-image-049-catalog.json"]:
            self.assertIn("ops/release/" + name, artifact.PACKAGE_FILES)

    def test_049_payload_only_accepts_exact_reviewed_final_migration_and_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "server/src/migrations/049_quick_image_configurations.sql"
            path.parent.mkdir(parents=True)
            path.write_bytes(b"reviewed 049 SQL")
            value = {"migrations": [{"name": path.name, "sha256": digest(path.read_bytes())}]}
            artifact.verify_049_payload(root, value)
            path.write_bytes(b"altered")
            with self.assertRaisesRegex(Rejected, "049_SQL_MIGRATION_HASH_MISMATCH"):
                artifact.verify_049_payload(root, value)
            for rows in [[], value["migrations"] * 2, value["migrations"] + [{"name": "050_unreviewed.sql", "sha256": "0" * 64}]]:
                with self.assertRaisesRegex(Rejected, "FIXED_049_MIGRATION_REQUIRED"):
                    artifact.verify_049_payload(root, {"migrations": rows})

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

    def test_tail_support_is_exactly_reviewed_048_through_051_not_an_open_ended_relaxation(self):
        names = ["048_usage_daily_facts.sql", "049_quick_image_configurations.sql", *creative_seed.MIGRATIONS]
        self.assertTrue(artifact.fixed_migration_tail({"migrations": [{"name": name} for name in names]}, names[0]))
        for changed in [names + ["052_future.sql"], [names[0], *names[2:]], names[:-1] + ["051_other.sql"], names + [names[-1]]]:
            with self.subTest(changed=changed):
                self.assertFalse(artifact.fixed_migration_tail({"migrations": [{"name": name} for name in changed]}, names[0]))

    def test_complete_package_seals_only_two_generated_public_recipes_and_rejects_tamper(self):
        root = Path(__file__).resolve().parents[2]
        candidate = manifest(); candidate["migrations"] = artifact.migrations(root)
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            images = temporary / "test-images.tar.gz"; images.write_bytes(b"offline fixture image archive")
            destination = temporary / "package"
            with patch.object(artifact, "repository_commit", return_value=candidate["commit"]):
                result = artifact.package(root, candidate, candidate["verification"], images, destination)
            self.assertFalse(result["imagesRebuilt"])
            release = verify_package(destination)
            seed = creative_seed.verify_payload(destination, release)
            self.assertEqual([row["key"] for row in seed["recipes"]], list(creative_seed.RECIPE_NAMES))
            self.assertEqual({row["path"] for row in release["files"]}, set(artifact.PACKAGE_FILES) | {"images.tar.gz", creative_seed.SEED_PATH})
            self.assertEqual([row["path"] for row in release["files"] if "recipe" in row["path"]], [])
            bad = copy.deepcopy(seed); bad["recipes"][0]["content"]["systemPrompt"] += " changed"
            (destination / creative_seed.SEED_PATH).write_text(json.dumps(bad), encoding="utf-8")
            with self.assertRaises(Rejected): verify_package(destination)
            with self.assertRaisesRegex(Rejected, "CONTENT_HASH_MISMATCH"): creative_seed.verify_payload(destination, release)


if __name__ == "__main__": unittest.main()
