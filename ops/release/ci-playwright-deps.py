import importlib.util
import os
from pathlib import Path
import platform
import re
import subprocess
import sys


SPEC = importlib.util.spec_from_file_location("ci_ubuntu_apt", Path(__file__).with_name("ci-ubuntu-apt.py"))
apt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(apt)


def missing_packages(result):
    output = result.stdout.strip()
    if result.stderr.strip():
        raise ValueError("Playwright dependency check returned unexpected diagnostics")
    if result.returncode == 0 and output == "All system dependencies are installed.":
        return []
    lines = output.splitlines()
    header = re.fullmatch(r"Missing system dependencies \(([1-9][0-9]{0,2})\):", lines[0]) if lines else None
    if result.returncode != 1 or not header:
        raise ValueError("Playwright dependency check did not return a supported installed/missing result")
    packages = [line[2:] for line in lines[1:] if line.startswith("  ")]
    if len(packages) != int(header[1]) or len(packages) != len(lines) - 1 or len(set(packages)) != len(packages):
        raise ValueError("Playwright missing package count is inconsistent")
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::(?:amd64|arm64))?", name) for name in packages):
        raise ValueError("Playwright returned an invalid Debian package name")
    if any(name.split(":")[0].endswith("-") or (name.split(":")[0].endswith("+") and not name.split(":")[0].endswith("++")) for name in packages):
        raise ValueError("Playwright returned a package operation suffix")
    return packages


def install_dependencies(cli):
    command = ["node", str(cli), "install-deps", "--dry-run", "chromium"]
    environment = {**os.environ, "LC_ALL": "C", "LANG": "C"}

    def inspect():
        result = subprocess.run(command, capture_output=True, text=True, timeout=60, env=environment)
        print(result.stdout, end="", flush=True)
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr, flush=True)
        return missing_packages(result)

    packages = inspect()
    if packages:
        subprocess.run(["apt-get", "install", "-y", "--no-remove", "--no-install-recommends", *packages], check=True, timeout=240, env=environment)
        if inspect():
            raise ValueError("Playwright dependencies remain missing after one installation")
    print("Chromium system dependencies verified against the existing signed APT indexes; no additional update performed.", flush=True)


def main():
    if sys.platform != "linux" or any(os.environ.get(key) != value for key, value in {
        "GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux",
    }.items()):
        raise ValueError("refusing package installation outside a GitHub-hosted Linux runner")
    apt.require_runner(os.environ, sys.platform, os.geteuid(), platform.freedesktop_os_release())
    apt.verify_effective_config()
    cli = Path(__file__).resolve().parents[2] / "web/node_modules/playwright/cli.js"
    if not cli.is_file():
        raise ValueError("the frozen web Playwright dependency must be installed first")
    install_dependencies(cli)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"CI Chromium dependency installation failed: {error}", file=sys.stderr)
        sys.exit(1)
