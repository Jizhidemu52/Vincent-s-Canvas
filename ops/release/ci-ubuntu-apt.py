#!/usr/bin/env python3
"""Configure signed Ubuntu mirrors on disposable GitHub-hosted Noble runners only."""

import os
from pathlib import Path
import platform
import re
import subprocess
import sys
from urllib.parse import urlsplit


MIRRORS = {
    "ubuntu": "https://mirrors.mit.edu/ubuntu/",
    "ubuntu-ports": "https://mirrors.mit.edu/ubuntu-ports/",
}
ORIGINS = {
    "archive.ubuntu.com": "ubuntu",
    "azure.archive.ubuntu.com": "ubuntu",
    "security.ubuntu.com": "ubuntu",
    "ports.ubuntu.com": "ubuntu-ports",
}
APT_CONFIG = """// Disposable GitHub-hosted runner only; keep APT signature verification enabled.
Acquire::Retries "0";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT::Update::Error-Mode "any";
"""
# The official runner ships zz-retries; apply our bounded policy after it.
CONFIG_NAME = "zzzz-canvas-ci-ubuntu"
RUNNER_MIRROR_LIST = "mirror+file:/etc/apt/apt-mirrors.txt"
UPDATE_TIMEOUT_SECONDS = 240


def require_runner(environment, system, uid, release):
    expected = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux"}
    if system != "linux" or any(environment.get(key) != value for key, value in expected.items()):
        raise ValueError("refusing to modify APT outside a GitHub-hosted Linux runner")
    if uid != 0:
        raise ValueError("runner APT configuration requires sudo")
    if (release.get("ID"), release.get("VERSION_ID"), release.get("VERSION_CODENAME")) != ("ubuntu", "24.04", "noble"):
        raise ValueError("only Ubuntu 24.04 (noble) is supported")


def mirror_uri(uri, architecture):
    """Match complete known origins/paths, never a host substring or third-party URL."""
    if architecture not in ("amd64", "arm64"):
        raise ValueError("only amd64 and arm64 runners are supported")
    # Official ubuntu24/20261101.360 configure-apt-sources.sh uses this exact
    # indirection for the amd64 Ubuntu archive. Do not follow arbitrary files or
    # change the mirror list itself; replace only the URI in the signed source.
    if uri == RUNNER_MIRROR_LIST:
        if architecture != "amd64":
            raise ValueError("Ubuntu runner mirror-list family does not match runner architecture")
        return MIRRORS["ubuntu"], True
    parsed = urlsplit(uri)
    if parsed.scheme not in ("http", "https") or parsed.query or parsed.fragment:
        return uri, False
    family = ORIGINS.get(parsed.netloc)
    if parsed.netloc == "mirrors.mit.edu":
        family = next((name for name in MIRRORS if parsed.path in (f"/{name}", f"/{name}/")), None)
    if family is None or parsed.path not in (f"/{family}", f"/{family}/"):
        return uri, False
    expected = "ubuntu" if architecture == "amd64" else "ubuntu-ports"
    if family != expected:
        raise ValueError(f"Ubuntu source family {family} does not match runner architecture {architecture}")
    return MIRRORS[family], True


def reject_insecure_options(text, deb822):
    separator = r"\s*:\s*" if deb822 else r"\s*=\s*"
    pattern = r"(?:^|[\s\[])(?:trusted|allow-insecure|allow-weak|allow-downgrade-to-insecure)" + separator + r"(?:yes|true|1)(?=$|[\s\]])"
    if re.search(pattern, text, re.IGNORECASE | re.MULTILINE):
        raise ValueError("refusing an Ubuntu source with signature verification disabled")


def rewrite_list(text, architecture):
    found = 0
    result = []
    pattern = re.compile(r"^(\s*deb(?:-src)?\s+(?:\[[^\]\r\n]*\]\s+)?)(\S+)(\s+[^\r\n]+)(\r?\n)?$")
    for line in text.splitlines(keepends=True):
        match = pattern.match(line)
        if match:
            replacement, known = mirror_uri(match[2], architecture)
            if known:
                reject_insecure_options(match[1], False)
                found += 1
                line = match[1] + replacement + match[3] + (match[4] or "")
        result.append(line)
    return "".join(result), found


def rewrite_deb822(text, architecture):
    # Change URI tokens only; preserve Signed-By (including inline keys), suites,
    # components, architecture restrictions, comments and third-party stanzas.
    chunks = re.split(r"(\r?\n[ \t]*\r?\n)", text)
    found = 0
    for index in range(0, len(chunks), 2):
        stanza = chunks[index]
        if re.search(r"^Enabled:[ \t]*no[ \t]*\r?$", stanza, re.IGNORECASE | re.MULTILINE):
            continue
        known_count = 0

        def replace_token(match):
            nonlocal known_count
            replacement, known = mirror_uri(match[0], architecture)
            known_count += int(known)
            return replacement

        field = None
        lines = []
        for line in stanza.splitlines(keepends=True):
            if line.lstrip().startswith("#"):
                lines.append(line)
                continue
            match = re.match(r"^([A-Za-z][A-Za-z0-9-]*:)([ \t]*)(.*)$", line)
            if match:
                field = match[1][:-1].lower()
                if field == "uris":
                    offset = len(match[1]) + len(match[2])
                    line = line[:offset] + re.sub(r"\S+", replace_token, line[offset:])
            elif field == "uris" and line[:1].isspace():
                line = re.sub(r"\S+", replace_token, line)
            else:
                field = None
            lines.append(line)
        if known_count:
            reject_insecure_options(stanza, True)
        chunks[index] = "".join(lines)
        found += known_count
    return "".join(chunks), found


def plan_sources(apt_directory, architecture):
    sources = [apt_directory / "sources.list"]
    source_directory = apt_directory / "sources.list.d"
    sources += sorted(path for path in source_directory.glob("*")
                      if re.fullmatch(r"[A-Za-z0-9_.-]+\.(list|sources)", path.name))
    changes = []
    found = 0
    for path in sources:
        if not path.is_file():
            continue
        original = path.read_bytes()
        rewrite = rewrite_deb822 if path.suffix == ".sources" else rewrite_list
        revised, count = rewrite(original.decode("utf-8"), architecture)
        found += count
        if revised.encode("utf-8") != original:
            if path.is_symlink():
                raise ValueError(f"refusing to rewrite a symlinked APT source: {path.name}")
            changes.append((path, revised.encode("utf-8")))
    if not found:
        raise ValueError("no active supported Ubuntu source found; refusing an unverified runner layout")
    return changes, found


def verify_effective_config():
    values = {"CANVAS_RETRIES": ("Acquire::Retries", "0"),
              "CANVAS_HTTP_TIMEOUT": ("Acquire::http::Timeout", "30"),
              "CANVAS_HTTPS_TIMEOUT": ("Acquire::https::Timeout", "30"),
              "CANVAS_UPDATE_ERRORS": ("APT::Update::Error-Mode", "any")}
    arguments = [part for name, (key, _) in values.items() for part in (name, key)]
    output = subprocess.run(["apt-config", "shell", *arguments], check=True, capture_output=True,
                            text=True, timeout=15).stdout
    expected = {f"{name}='{value}'" for name, (_, value) in values.items()}
    if set(output.strip().splitlines()) != expected:
        raise ValueError("effective APT download policy differs from the bounded runner configuration")
    print("Effective APT policy verified: retries=0, HTTP/HTTPS timeout=30, update errors=any", flush=True)


def main():
    # Do not even inspect or write host APT paths when invoked locally/self-hosted.
    environment = os.environ
    expected = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux"}
    if sys.platform != "linux" or any(environment.get(key) != value for key, value in expected.items()):
        raise ValueError("refusing to modify APT outside a GitHub-hosted Linux runner")
    require_runner(environment, sys.platform, os.geteuid(), platform.freedesktop_os_release())
    architecture = subprocess.run(["dpkg", "--print-architecture"], check=True, capture_output=True,
                                  text=True, timeout=15).stdout.strip()
    if not Path("/usr/share/keyrings/ubuntu-archive-keyring.gpg").is_file():
        raise ValueError("Ubuntu archive signing keyring is missing")
    apt_directory = Path("/etc/apt")
    changes, found = plan_sources(apt_directory, architecture)
    config = apt_directory / "apt.conf.d" / CONFIG_NAME
    if config.is_symlink() or (config.exists() and config.read_bytes() != APT_CONFIG.encode("utf-8")):
        raise ValueError("refusing to overwrite a different APT configuration")
    for path, contents in changes:
        path.write_bytes(contents)
        print(f"Updated Ubuntu mirror URI in {path}", flush=True)
    config.write_bytes(APT_CONFIG.encode("utf-8"))
    verify_effective_config()
    print(f"Checking {found} signed Ubuntu source URI(s) on noble/{architecture}; index timeout {UPDATE_TIMEOUT_SECONDS}s", flush=True)
    subprocess.run(["apt-get", "update", "--error-on=any"], check=True, timeout=UPDATE_TIMEOUT_SECONDS)
    print("Runner APT indexes verified; package signatures and all release gates remain enabled.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"CI Ubuntu APT setup failed: {error}", file=sys.stderr)
        sys.exit(1)
