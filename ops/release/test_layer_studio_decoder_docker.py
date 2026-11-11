"""Validate the production HEIC runtime on the same immutable API image."""
import json
import os
from pathlib import Path
import re
import subprocess
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get("RUN_DOCKER_COMPOSE_CONTRACT_TESTS") == "true", "same-image Linux decoder requires explicit CI Docker opt-in")
class LayerStudioReleaseDecoder(unittest.TestCase):
    def test_exact_api_image_decodes_primary_heic_and_derived_heif_without_network(self):
        reference = os.environ.get("COMPOSE_RUNTIME_TEST_IMAGE", "")
        self.assertTrue(reference, "explicit release API image required")
        inspected = json.loads(subprocess.run(["docker", "image", "inspect", reference], check=True,
                                             capture_output=True, text=True, timeout=30).stdout)
        self.assertEqual(len(inspected), 1)
        image = inspected[0]
        self.assertEqual(image["Os"], "linux")
        self.assertRegex(image["Id"], r"^sha256:[a-f0-9]{64}$")
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, check=True,
                                capture_output=True, text=True, timeout=10).stdout.strip()
        self.assertEqual(image["Config"]["Labels"]["org.opencontainers.image.revision"], commit)
        token = uuid.uuid4().hex
        name = "canvas-layer-codec-" + token
        script = ROOT / "ops/release/verify-layer-reference.mjs"
        fixture = ROOT / "server/tests/fixtures/seedream55-reference.heic"
        self.assertTrue(script.is_file() and fixture.is_file())
        try:
            result = subprocess.run(["docker", "run", "--rm", "--name", name, "--label", "canvas.test.owner=" + token,
                                     "--network", "none", "--read-only", "--memory", "1g", "--pids-limit", "64", "--cpus", "1",
                                     "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                                     "--mount", f"type=bind,src={script},dst=/opt/canvas-fixture/verify.mjs,readonly",
                                     "--mount", f"type=bind,src={fixture},dst=/opt/canvas-fixture/reference.heic,readonly",
                                     "--entrypoint", "bun", image["Id"], "--no-env-file", "/opt/canvas-fixture/verify.mjs"],
                                    capture_output=True, text=True, timeout=80)
            self.assertEqual(result.returncode, 0, result.stderr[-6000:])
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["status"], "passed")
            self.assertTrue(receipt["originalBytesUnchanged"])
            self.assertEqual(receipt["paidRequests"], 0)
            self.assertFalse(receipt["ffmpegUsed"])
        finally:
            leftover = subprocess.run(["docker", "inspect", name], capture_output=True, text=True, timeout=15)
            if leftover.returncode == 0:
                row = json.loads(leftover.stdout)[0]
                if row.get("Config", {}).get("Labels", {}).get("canvas.test.owner") == token and re.fullmatch(r"[a-f0-9]{64}", row.get("Id", "")):
                    subprocess.run(["docker", "rm", "-f", row["Id"]], check=True, capture_output=True, timeout=30)


if __name__ == "__main__": unittest.main()
