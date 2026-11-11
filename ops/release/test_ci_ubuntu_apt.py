import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("ci_ubuntu_apt", Path(__file__).with_name("ci-ubuntu-apt.py"))
apt = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(apt)
HOSTED = {"GITHUB_ACTIONS": "true", "RUNNER_ENVIRONMENT": "github-hosted", "RUNNER_OS": "Linux"}
NOBLE = {"ID": "ubuntu", "VERSION_ID": "24.04", "VERSION_CODENAME": "noble"}
SOURCE = """Types: deb deb-src
URIs: http://azure.archive.ubuntu.com/ubuntu/
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://security.ubuntu.com/ubuntu/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
"""


class UbuntuMirrorFixtures(unittest.TestCase):
    def test_host_guards_accept_only_hosted_linux_noble_root(self):
        apt.require_runner(HOSTED, "linux", 0, NOBLE)
        cases = [({}, "linux", 0, NOBLE),
                 ({**HOSTED, "RUNNER_ENVIRONMENT": "self-hosted"}, "linux", 0, NOBLE),
                 ({**HOSTED, "RUNNER_OS": "Windows"}, "linux", 0, NOBLE),
                 (HOSTED, "win32", 0, NOBLE), (HOSTED, "linux", 1001, NOBLE),
                 (HOSTED, "linux", 0, {**NOBLE, "ID": "debian"}),
                 (HOSTED, "linux", 0, {**NOBLE, "VERSION_ID": "22.04"}),
                 (HOSTED, "linux", 0, {**NOBLE, "VERSION_CODENAME": "jammy"})]
        for arguments in cases:
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                apt.require_runner(*arguments)

    def test_exact_amd64_origins_use_https_and_preserve_every_other_byte(self):
        for host in ("azure.archive.ubuntu.com", "archive.ubuntu.com", "security.ubuntu.com"):
            for scheme in ("http", "https"):
                for suffix in ("", "/"):
                    uri = f"{scheme}://{host}/ubuntu{suffix}"
                    source = f"deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] {uri} noble-security main universe # preserved\r\n"
                    revised, count = apt.rewrite_list(source, "amd64")
                    self.assertEqual(revised, source.replace(uri, apt.MIRRORS["ubuntu"]))
                    self.assertEqual(count, 1)

    def test_arm64_ports_family_is_not_mapped_to_the_amd64_archive(self):
        source = SOURCE.replace("azure.archive.ubuntu.com/ubuntu/", "ports.ubuntu.com/ubuntu-ports/")
        source = source.replace("security.ubuntu.com/ubuntu/", "ports.ubuntu.com/ubuntu-ports/")
        revised, count = apt.rewrite_deb822(source, "arm64")
        self.assertEqual(revised, source.replace("http://ports.ubuntu.com/ubuntu-ports/", apt.MIRRORS["ubuntu-ports"]))
        self.assertEqual(count, 2)
        self.assertNotIn("https://mirrors.mit.edu/ubuntu/", revised)

    def test_wrong_family_or_unknown_architecture_fails_closed(self):
        for uri, architecture in [("http://ports.ubuntu.com/ubuntu-ports/", "amd64"),
                                  ("http://archive.ubuntu.com/ubuntu/", "arm64"),
                                  ("https://mirrors.mit.edu/ubuntu-ports/", "amd64"),
                                  ("http://archive.ubuntu.com/ubuntu/", "riscv64")]:
            with self.subTest(uri=uri, architecture=architecture), self.assertRaises(ValueError):
                apt.mirror_uri(uri, architecture)

    def test_unknown_urls_ports_credentials_queries_and_lookalikes_are_untouched(self):
        for uri in ["https://packages.microsoft.com/ubuntu/24.04/prod", "https://apt.postgresql.org/pub/repos/apt",
                    "http://us.archive.ubuntu.com/ubuntu/", "http://archive.ubuntu.com.evil.test/ubuntu/",
                    "http://archive.ubuntu.com:8080/ubuntu/", "http://user@archive.ubuntu.com/ubuntu/",
                    "http://archive.ubuntu.com/ubuntu-extra/", "http://archive.ubuntu.com/ubuntu/?x=1",
                    "http://archive.ubuntu.com/ubuntu/#fragment", "ftp://archive.ubuntu.com/ubuntu/"]:
            with self.subTest(uri=uri):
                self.assertEqual(apt.mirror_uri(uri, "amd64"), (uri, False))

    def test_deb822_preserves_signing_suites_components_and_third_party_stanzas(self):
        third_party = "Types: deb\nURIs: https://packages.microsoft.com/repos/azure-cli/\nSuites: noble\nComponents: main\nSigned-By: /etc/apt/keyrings/microsoft.gpg\n"
        source = SOURCE + "\n" + third_party
        revised, count = apt.rewrite_deb822(source, "amd64")
        expected = source.replace("http://azure.archive.ubuntu.com/ubuntu/", apt.MIRRORS["ubuntu"])
        expected = expected.replace("http://security.ubuntu.com/ubuntu/", apt.MIRRORS["ubuntu"])
        self.assertEqual(revised, expected)
        self.assertEqual(count, 2)
        self.assertTrue(revised.endswith(third_party))

    def test_multiple_and_continued_uris_preserve_comments_crlf_and_inline_key(self):
        source = ("# http://archive.ubuntu.com/ubuntu/\r\nTypes: deb\r\n"
                  "URIs: http://archive.ubuntu.com/ubuntu/ https://packages.example.test/ubuntu/\r\n"
                  " http://security.ubuntu.com/ubuntu/\r\n"
                  "# keep the current URI continuation field\r\n"
                  " https://azure.archive.ubuntu.com/ubuntu/\r\n"
                  "Suites: noble noble-security\r\nComponents: main\r\n"
                  "Signed-By:\r\n -----BEGIN PGP PUBLIC KEY BLOCK-----\r\n .\r\n key-data\r\n -----END PGP PUBLIC KEY BLOCK-----\r\n")
        revised, count = apt.rewrite_deb822(source, "amd64")
        self.assertEqual(count, 3)
        self.assertIn("# http://archive.ubuntu.com/ubuntu/\r\n", revised)
        self.assertIn("https://packages.example.test/ubuntu/", revised)
        self.assertEqual(revised.split("Signed-By:")[1], source.split("Signed-By:")[1])
        self.assertEqual(revised.count("\r\n"), source.count("\r\n"))

    def test_disabled_stanzas_and_commented_list_entries_are_untouched(self):
        source = SOURCE.replace("Types:", "Enabled: no\nTypes:")
        self.assertEqual(apt.rewrite_deb822(source, "amd64"), (source, 0))
        line = "  # deb http://azure.archive.ubuntu.com/ubuntu/ noble main\n"
        self.assertEqual(apt.rewrite_list(line, "amd64"), (line, 0))

    def test_deb_src_no_final_newline_and_signed_by_are_preserved(self):
        source = "deb-src [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] http://archive.ubuntu.com/ubuntu noble main"
        revised, count = apt.rewrite_list(source, "amd64")
        self.assertEqual(revised, source.replace("http://archive.ubuntu.com/ubuntu", apt.MIRRORS["ubuntu"]))
        self.assertEqual(count, 1)

    def test_mirror_rewrite_is_idempotent(self):
        for rewrite, source in [(apt.rewrite_deb822, SOURCE),
                                (apt.rewrite_list, "deb http://archive.ubuntu.com/ubuntu/ noble main\n")]:
            revised, found = rewrite(source, "amd64")
            self.assertEqual(rewrite(revised, "amd64"), (revised, found))

    def test_insecure_ubuntu_options_are_rejected_without_weakening_them(self):
        for option in ("trusted", "allow-insecure", "allow-weak", "allow-downgrade-to-insecure"):
            with self.subTest(option=option):
                with self.assertRaisesRegex(ValueError, "signature verification disabled"):
                    apt.rewrite_list(f"deb [{option}=yes] http://archive.ubuntu.com/ubuntu/ noble main\n", "amd64")
                with self.assertRaisesRegex(ValueError, "signature verification disabled"):
                    apt.rewrite_deb822(SOURCE + f"{option}: true\n", "amd64")
        source = SOURCE + "Trusted: no\n"
        self.assertIn("Trusted: no\n", apt.rewrite_deb822(source, "amd64")[0])

    def test_file_planning_does_not_write_or_include_third_party_and_backup_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sources.list.d").mkdir()
            ubuntu = root / "sources.list.d/ubuntu.sources"
            ubuntu.write_bytes(SOURCE.encode())
            third_party = root / "sources.list.d/vendor.list"
            third_party.write_bytes(b"deb https://packages.example.test/ubuntu/ noble main\n")
            backup = root / "sources.list.d/old.sources.save"
            backup.write_bytes(b"do not parse or change")
            changes, found = apt.plan_sources(root, "amd64")
            self.assertEqual(found, 2)
            self.assertEqual([item[0] for item in changes], [ubuntu])
            self.assertEqual(ubuntu.read_text(), SOURCE)
            self.assertEqual(backup.read_bytes(), b"do not parse or change")
            self.assertEqual(third_party.read_bytes(), b"deb https://packages.example.test/ubuntu/ noble main\n")

    def test_no_recognized_active_source_fails_before_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "sources.list").write_bytes(b"deb https://vendor.test/repo noble main\n")
            with self.assertRaisesRegex(ValueError, "no active supported Ubuntu source"):
                apt.plan_sources(root, "amd64")
            self.assertEqual((root / "sources.list").read_bytes(), b"deb https://vendor.test/repo noble main\n")

    def test_main_refuses_local_execution_before_os_or_apt_inspection(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(apt.platform, "freedesktop_os_release") as release, patch.object(apt, "Path") as path:
            with self.assertRaisesRegex(ValueError, "outside a GitHub-hosted"):
                apt.main()
            release.assert_not_called()
            path.assert_not_called()

    def run_fixture_main(self, update_error=None, conflicting_config=False):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sources = root / "etc/apt/sources.list.d"
            sources.mkdir(parents=True)
            config_directory = root / "etc/apt/apt.conf.d"
            config_directory.mkdir()
            ubuntu = sources / "ubuntu.sources"
            ubuntu.write_bytes(SOURCE.encode())
            keyring = root / "usr/share/keyrings/ubuntu-archive-keyring.gpg"
            keyring.parent.mkdir(parents=True)
            keyring.write_bytes(b"fixture keyring - never used by real APT")
            config = config_directory / apt.CONFIG_NAME
            if conflicting_config:
                config.write_bytes(b"preexisting config")

            def local_path(value):
                return root / str(value).lstrip("/")

            def command(argv, **kwargs):
                if argv == ["dpkg", "--print-architecture"]:
                    return subprocess.CompletedProcess(argv, 0, "amd64\n", "")
                self.assertEqual(argv, ["apt-get", "update", "--error-on=any"])
                self.assertEqual(kwargs, {"check": True, "timeout": 240})
                self.assertIn("https://mirrors.mit.edu/ubuntu/", ubuntu.read_text())
                self.assertIn("Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg", ubuntu.read_text())
                self.assertEqual(config.read_bytes(), apt.APT_CONFIG.encode())
                if update_error:
                    raise update_error
                return subprocess.CompletedProcess(argv, 0)

            with patch.dict(os.environ, HOSTED, clear=True), patch.object(apt.sys, "platform", "linux"), \
                    patch.object(apt.os, "geteuid", return_value=0, create=True), \
                    patch.object(apt.platform, "freedesktop_os_release", return_value=NOBLE), \
                    patch.object(apt, "Path", side_effect=local_path), \
                    patch.object(apt.subprocess, "run", side_effect=command) as run, patch("builtins.print"):
                if update_error:
                    with self.assertRaises(type(update_error)):
                        apt.main()
                    self.assertEqual(run.call_count, 2)
                elif conflicting_config:
                    with self.assertRaisesRegex(ValueError, "different APT configuration"):
                        apt.main()
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(ubuntu.read_bytes(), SOURCE.encode())
                    self.assertEqual(config.read_bytes(), b"preexisting config")
                else:
                    apt.main()
                    self.assertEqual(run.call_count, 2)

    def test_main_updates_only_the_fixture_and_checks_signed_indexes_once(self):
        self.run_fixture_main()

    def test_download_or_signature_failure_is_not_swallowed_or_retried(self):
        self.run_fixture_main(subprocess.CalledProcessError(100, ["apt-get", "update"]))

    def test_index_download_has_a_hard_timeout_and_does_not_retry(self):
        self.run_fixture_main(subprocess.TimeoutExpired(["apt-get", "update"], 240))

    def test_conflicting_config_fails_without_source_changes(self):
        self.run_fixture_main(conflicting_config=True)

    def test_download_config_is_bounded_and_does_not_disable_authentication(self):
        self.assertIn('Acquire::Retries "0";', apt.APT_CONFIG)
        self.assertIn('Acquire::http::Timeout "30";', apt.APT_CONFIG)
        self.assertIn('Acquire::https::Timeout "30";', apt.APT_CONFIG)
        self.assertIn('APT::Update::Error-Mode "any";', apt.APT_CONFIG)
        for unsafe in ("AllowUnauthenticated", "AllowInsecure", "Verify-Peer", "Verify-Host", "trusted=yes"):
            self.assertNotIn(unsafe, apt.APT_CONFIG)


class WorkflowWiring(unittest.TestCase):
    def test_release_and_both_production_jobs_configure_before_first_apt_call(self):
        release = (ROOT / ".github/workflows/docker-image.yml").read_text(encoding="utf-8")
        production = (ROOT / ".github/workflows/production-ci.yml").read_text(encoding="utf-8")
        backend = production.split("  backend-integration:\n", 1)[1].split("  frontend:\n", 1)[0]
        frontend = production.split("  frontend:\n", 1)[1].split("  compose-recovery:\n", 1)[0]
        for job in (release, backend, frontend):
            with self.subTest(job=job[:60]):
                self.assertEqual(job.count('python3 -B "$GITHUB_WORKSPACE/ops/release/ci-ubuntu-apt.py"'), 1)
                setup = job.index("Configure signed Ubuntu mirrors on the disposable runner")
                for install in ("apt-get update", "playwright install --with-deps chromium"):
                    if install in job:
                        self.assertLess(setup, job.index(install))
                self.assertIn('RUNNER_ENVIRONMENT="$RUNNER_ENVIRONMENT"', job)
                self.assertIn("timeout-minutes: 5", job)
        self.assertIn("runs-on: ubuntu-24.04", backend)
        self.assertIn("runs-on: ubuntu-24.04", frontend)
        self.assertIn("runner: ubuntu-24.04-arm", release)

    def test_release_keeps_verify_dependency_and_immutable_build_export_gates(self):
        release = (ROOT / ".github/workflows/docker-image.yml").read_text(encoding="utf-8")
        for required in ("needs: verify", "Freeze clean source identity", "Build API once and publish immutable digest",
                         "Build Web once and publish immutable digest", "Verify contracts and the exact formal application stack",
                         "Export the same verified images without rebuilding", "bash ops/release/stack-smoke.sh",
                         'test "$(git rev-parse HEAD)" = "$GITHUB_SHA"'):
            self.assertIn(required, release)
        self.assertNotIn("continue-on-error:", release)


if __name__ == "__main__":
    unittest.main()
