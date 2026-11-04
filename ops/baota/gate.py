#!/usr/bin/env python3
"""Hash-locked, reversible maintenance gate for one existing Baota instance."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "release"))
from contract import Rejected, canonical, read_json, require, validate_instance, write_new_json


def sha(data):
    return hashlib.sha256(data).hexdigest()


def run(argv, check=True):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=30)
    if check and result.returncode:
        raise Rejected("GATE_COMMAND_FAILED:" + Path(argv[0]).name)
    return result


def read_regular(path):
    require(path.is_file() and not path.is_symlink(), "GATE_REGULAR_FILE_REQUIRED")
    return path.read_bytes()


def gated_site(source, marker):
    starts = list(re.finditer(rb"(?m)^\s*server\s*\{", source))
    require(len(starts) == 1 and b"canvas-maintenance-" not in source, "ONE_UNGATED_SERVER_REQUIRED")
    position = starts[0].end()
    return source[:position] + ("\n    return 503; # " + marker + "\n").encode() + source[position:]


def firewall_plan(network, marker):
    """Only the old Web's exact published ports and container IPs are targeted.

    The new Web must publish on loopback only (enforced by the release renderer).
    No broad restore/prune/flush or changes to another instance are permitted.
    """
    rules = []
    ips = []
    for entry in network.get("Networks", {}).values():
        for key in ("IPAddress", "GlobalIPv6Address"):
            if entry.get(key):
                ips.append(ipaddress.ip_address(entry[key]))
    for mapping, bindings in (network.get("Ports") or {}).items():
        if not bindings:
            continue
        port, protocol = mapping.split("/")
        require(protocol == "tcp" and port.isdigit(), "ONLY_TCP_WEB_PORTS_SUPPORTED")
        for binding in bindings:
            address = ipaddress.ip_address(binding["HostIp"])
            published = binding["HostPort"]
            require(published.isdigit() and 1 <= int(published) <= 65535, "INVALID_PUBLISHED_PORT")
            if address.is_loopback:
                continue
            tool = "iptables" if address.version == 4 else "ip6tables"
            scope = [] if address.is_unspecified else ["-d", str(address)]
            rules.append([tool, "INPUT", "!", "-i", "lo", "-p", "tcp", *scope, "--dport", published,
                          "-m", "comment", "--comment", marker, "-j", "REJECT", "--reject-with", "tcp-reset"])
            for target in ips:
                if target.version == address.version:
                    rules.append([tool, "DOCKER-USER", "-p", "tcp", "-d", str(target), "--dport", port,
                                  "-m", "conntrack", "--ctdir", "ORIGINAL", "--ctorigdstport", published,
                                  "-m", "comment", "--comment", marker, "-j", "REJECT", "--reject-with", "tcp-reset"])
    return [list(rule) for rule in dict.fromkeys(tuple(rule) for rule in rules)]


def rule_command(rule, action):
    return [rule[0], "--wait", "5", action, rule[1], *(["1"] if action == "-I" else []), *rule[2:]]


def rule_present(rule):
    status = run(rule_command(rule, "-C"), check=False).returncode
    require(status in (0, 1), "FIREWALL_QUERY_FAILED")
    return status == 0


def remove_rules(rules):
    for rule in reversed(rules):
        if rule_present(rule):
            run(rule_command(rule, "-D"))


def replace_site(path, content):
    # Atomically replace only this reviewed config, preserving its mode and owner.
    require(path.is_file() and not path.is_symlink(), "SITE_PATH_CHANGED")
    previous = path.stat()
    fd, temporary = tempfile.mkstemp(prefix=".canvas-gate-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as target:
            target.write(content)
            target.flush()
            os.fchmod(target.fileno(), previous.st_mode & 0o7777)
            os.fchown(target.fileno(), previous.st_uid, previous.st_gid)
            os.fsync(target.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def probe(instance, expected):
    origin = urlsplit(instance["publicBaseUrl"])
    port = origin.port or (443 if origin.scheme == "https" else 80)
    # Check the real outer vhost on this host, without skipping TLS validation.
    deadline = time.monotonic() + 10
    while True:
        result = run(["curl", "--noproxy", "*", "--silent", "--show-error", "--connect-timeout", "2", "--max-time", "2",
                      "--resolve", f"{origin.hostname}:{port}:127.0.0.1", "--output", "/dev/null", "--write-out", "%{http_code}",
                      instance["publicBaseUrl"].rstrip("/") + "/api/health"], check=False)
        if result.returncode == 0 and result.stdout == str(expected):
            return
        require(time.monotonic() < deadline, "OUTER_GATE_PROBE_FAILED")
        time.sleep(0.2)


def main(argv):
    require(len(argv) == 3 and argv[0] in ("close", "verify-closed", "open", "verify-open"), "GATE_ARGUMENTS_INVALID")
    require(os.geteuid() == 0, "GATE_ROOT_REQUIRED")
    action, config_path, audit_path = argv
    instance = validate_instance(read_json(config_path))
    ingress = instance.get("ingress")
    require(ingress is not None, "GATE_INGRESS_REQUIRED")
    audit = Path(audit_path)
    require(audit.is_dir() and not audit.is_symlink() and str(audit.resolve()).startswith(instance["auditRoot"] + "/"), "GATE_AUDIT_OUTSIDE_INSTANCE")
    site = Path(ingress["siteFile"])
    proxy = Path(ingress["proxyFile"])
    require(sha(read_regular(proxy)) == ingress["expectedProxySha256"], "PROXY_CHANGED_DURING_GATE")
    nginx = ingress["nginxBinary"]
    journal_path = audit / "gate-journal.json"
    binding = sha(canonical(instance).encode())
    if action == "close":
        require(not journal_path.exists(), "GATE_ALREADY_STARTED_INSPECT_FIRST")
        source = read_regular(site)
        require(sha(source) == ingress["expectedSiteSha256"], "SITE_CHANGED_BEFORE_GATE")
        marker = "canvas-maintenance-" + sha((binding + str(audit)).encode())[:16]
        target = gated_site(source, marker)
        state = json.loads(run(["docker", "inspect", "--format", "{{json .NetworkSettings}}", instance["containers"]["web"]]).stdout)
        rules = firewall_plan(state, marker)
        for rule in rules:
            run([rule[0], "--wait", "5", "-S", rule[1]])
            require(not rule_present(rule), "UNEXPECTED_EXISTING_GATE_RULE")
        run([nginx, "-t"])
        for name, content in (("gate-original.conf", source), ("gate-closed.conf", target)):
            with (audit / name).open("xb") as output:
                output.write(content)
            os.chmod(audit / name, 0o600)
        journal = {"instanceHash": binding, "originalHash": sha(source), "closedHash": sha(target), "rules": rules}
        write_new_json(journal_path, journal)
        try:
            replace_site(site, target)
            run([nginx, "-t"])
            run([nginx, "-s", "reload"])
            for rule in rules:
                run(rule_command(rule, "-I"))
            probe(instance, 503)
        except Exception:
            # An operator may have edited the vhost while closing failed.
            # Preserve unknown content and the journal/rules for manual review.
            require(sha(read_regular(site)) in (journal["closedHash"], journal["originalHash"]), "REFUSING_TO_REPLACE_CHANGED_SITE")
            replace_site(site, source)
            run([nginx, "-t"])
            run([nginx, "-s", "reload"])
            remove_rules(rules)
            raise
    elif action == "verify-open" and not journal_path.exists():
        require(sha(read_regular(site)) == ingress["expectedSiteSha256"], "SITE_CHANGED_BEFORE_GATE")
        run([nginx, "-t"])
        probe(instance, 200)
    else:
        journal = read_json(journal_path)
        require(journal["instanceHash"] == binding, "GATE_INSTANCE_CHANGED")
        if action == "verify-closed":
            require(sha(read_regular(site)) == journal["closedHash"], "CLOSED_GATE_FILE_CHANGED")
            require(all(rule_present(rule) for rule in journal["rules"]), "CLOSED_GATE_RULE_MISSING")
            probe(instance, 503)
        elif action == "open":
            require(sha(read_regular(site)) in (journal["closedHash"], journal["originalHash"]), "REFUSING_TO_REPLACE_CHANGED_SITE")
            source = read_regular(audit / "gate-original.conf")
            require(sha(source) == journal["originalHash"], "GATE_BACKUP_CHANGED")
            replace_site(site, source)
            run([nginx, "-t"])
            run([nginx, "-s", "reload"])
            remove_rules(journal["rules"])
            probe(instance, 200)
        else:
            require(sha(read_regular(site)) == journal["originalHash"], "OPEN_GATE_FILE_CHANGED")
            require(all(not rule_present(rule) for rule in journal["rules"]), "GATE_RULES_REMAIN")
            probe(instance, 200)
    print(json.dumps({"gate": action, "status": "passed"}))


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except (Rejected, OSError, subprocess.TimeoutExpired, ValueError, KeyError) as error:
        print("GATE_FAILED: " + (str(error) if isinstance(error, Rejected) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
