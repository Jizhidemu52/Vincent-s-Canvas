import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ci_playwright_deps", Path(__file__).with_name("ci-playwright-deps.py"))
deps = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(deps)


def result(code=0, stdout="All system dependencies are installed.\n", stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class PlaywrightDependencies(unittest.TestCase):
    def test_installed_and_exact_missing_output(self):
        self.assertEqual(deps.missing_packages(result()), [])
        self.assertEqual(deps.missing_packages(result(1, "Missing system dependencies (1):\n  g++\n")), ["g++"])
        self.assertEqual(deps.missing_packages(result(1, "Missing system dependencies (3):\n  libasound2t64:amd64\n  fonts-noto-color-emoji\n  libc++1\n")), ["libasound2t64:amd64", "fonts-noto-color-emoji", "libc++1"])

    def test_unexpected_result_never_becomes_an_installation(self):
        cases = [result(2), result(0, ""), result(0, "Missing system dependencies (1):\n  liba\n"),
                 result(1, "apt-get update && apt-get install -y liba"), result(0, stderr="warning"),
                 result(1, "Missing system dependencies (2):\n  liba\n"), result(1, "Missing system dependencies (2):\n  liba\n  liba\n"),
                 result(1, "Missing system dependencies (1):\n liba\n"), result(1, "Missing system dependencies (1):\n  --allow-unauthenticated\n"),
                 result(1, "Missing system dependencies (1):\n  liba;touch /tmp/pwn\n"), result(1, "Missing system dependencies (1):\n  liba=1\n"),
                 result(1, "Missing system dependencies (1):\n  bash-\n"), result(1, "Missing system dependencies (1):\n  bash-:amd64\n"),
                 result(1, "Missing system dependencies (1):\n  bash+\n")]
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                deps.missing_packages(value)

    def test_installed_dependencies_do_not_mutate_packages_or_indexes(self):
        with patch.object(deps.subprocess, "run", return_value=result()) as run, patch("builtins.print"):
            deps.install_dependencies(Path("/work/web/node_modules/playwright/cli.js"))
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][-3:], ["install-deps", "--dry-run", "chromium"])

    def test_missing_dependencies_install_once_and_are_checked_again_without_update(self):
        outcomes = [result(1, "Missing system dependencies (2):\n  liba\n  libb:arm64\n"), result(), result()]
        with patch.object(deps.subprocess, "run", side_effect=outcomes) as run, patch("builtins.print"):
            deps.install_dependencies(Path("/work/cli.js"))
        self.assertEqual(run.call_count, 3)
        self.assertEqual(run.call_args_list[0].args, run.call_args_list[2].args)
        self.assertEqual(run.call_args_list[1].args[0], ["apt-get", "install", "-y", "--no-remove", "--no-install-recommends", "liba", "libb:arm64"])
        self.assertTrue(run.call_args_list[1].kwargs["check"])
        self.assertEqual(run.call_args_list[1].kwargs["timeout"], 240)
        self.assertNotIn("update", [token for call in run.call_args_list for token in call.args[0]])

    def test_install_failure_or_remaining_missing_packages_are_not_retried(self):
        missing = result(1, "Missing system dependencies (1):\n  liba\n")
        for failure, count in [(subprocess.CalledProcessError(100, ["apt-get"]), 2), (missing, 3)]:
            sequence = [missing, failure] if isinstance(failure, Exception) else [missing, result(), missing]
            with patch.object(deps.subprocess, "run", side_effect=sequence) as run, patch("builtins.print"):
                with self.assertRaises((ValueError, subprocess.SubprocessError)):
                    deps.install_dependencies(Path("/work/cli.js"))
                self.assertEqual(run.call_count, count)

    def test_local_machine_is_rejected_before_platform_or_apt_inspection(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(deps.platform, "freedesktop_os_release") as release, patch.object(deps.apt, "verify_effective_config") as verify:
            with self.assertRaisesRegex(ValueError, "outside a GitHub-hosted"):
                deps.main()
            release.assert_not_called()
            verify.assert_not_called()

    def test_release_workflows_use_verified_indexes_and_public_playwright_cli(self):
        production = (ROOT / ".github/workflows/production-ci.yml").read_text(encoding="utf-8")
        release = (ROOT / ".github/workflows/docker-image.yml").read_text(encoding="utf-8")
        for content, count in [(production, 2), (release, 1)]:
            self.assertNotIn("playwright install --with-deps", content)
            self.assertEqual(content.count('python3 -B "$GITHUB_WORKSPACE/ops/release/ci-playwright-deps.py"'), count)
            self.assertEqual(content.count("bunx playwright install chromium"), count)
        self.assertNotIn("apt-get update", production)
        self.assertEqual(production.count("sudo apt-get install -y ffmpeg"), 3)

    @unittest.skipUnless(sys.platform == "linux" and shutil.which("node") and (ROOT / "web/node_modules/playwright/cli.js").is_file(), "actual installed Linux Playwright CLI")
    def test_actual_playwright_cli_installs_exact_simulated_packages_then_rechecks_without_updating(self):
        with tempfile.TemporaryDirectory(prefix="canvas-playwright-deps-") as directory:
            root = Path(directory)
            executable = root / "apt-get"
            executable.write_text("""#!/usr/bin/python3
import json
from pathlib import Path
import sys
root = Path(__file__).parent
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as stream:
    stream.write(json.dumps(args) + '\\n')
if args[:3] == ['install', '-s', '--no-install-recommends']:
    assert len(args[3:]) > 10
    if not (root / 'installed').exists():
        packages = sorted(set(args[3:]))[:2]
        (root / 'expected.json').write_text(json.dumps(packages))
        for package in packages:
            print(f'Inst {package} (1.0 fixture [amd64])')
elif args[:4] == ['install', '-y', '--no-remove', '--no-install-recommends']:
    assert args[4:] == json.loads((root / 'expected.json').read_text())
    (root / 'installed').touch()
else:
    raise RuntimeError('Unexpected APT operation: ' + repr(args))
""", encoding="utf-8")
            executable.chmod(0o755)
            with patch.dict(os.environ, {"PATH": str(root) + os.pathsep + os.environ["PATH"]}), patch("builtins.print"):
                deps.install_dependencies(ROOT / "web/node_modules/playwright/cli.js")
            calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
            self.assertEqual(len(calls), 3)
            self.assertEqual(calls[0], calls[2])
            self.assertEqual(calls[1][4:], json.loads((root / "expected.json").read_text()))
            self.assertTrue((root / "installed").is_file())
            self.assertNotIn("update", [token for call in calls for token in call])


if __name__ == "__main__":
    unittest.main()
