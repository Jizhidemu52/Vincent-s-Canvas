from argparse import ArgumentParser
from contextlib import contextmanager
from http.client import HTTPException
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from acceptance import account_file, authenticated_probe, fixture_bytes, image_roundtrip
from doctor import Doctor, ProbeFailed, check, report, require_local_engine
from deploy import Deployment, Rejected, read_json, require, sha_file, write_new_json


@contextmanager
def deployer(instance_path):
    deploy = Deployment(instance_path)
    try:
        yield deploy
    finally:
        if deploy.lock is not None:
            deploy.lock.close()


def doctor_report(deploy, name, session=None, headers=None, expected_release=None):
    doctor = Doctor(deploy.instance, session, headers, expected_release)
    return report(deploy.instance, doctor.verify(), Path(deploy.audit) / name)


def render_proxy(instance_path, output):
    doctor = Doctor(Deployment(instance_path).instance)
    doctor.inventory()
    port = doctor.web_port()
    template = Path(__file__).with_name("site-proxy.conf").read_text(encoding="utf-8")
    content, count = re.subn(r"(?m)^set \$canvas_web http://127\.0\.0\.1:[0-9]+;$", f"set $canvas_web http://127.0.0.1:{port};", template)
    check(count == 1, "代理模板必须只定义一个回环 upstream")
    check(output.is_absolute(), "生成的代理配置须使用绝对路径")
    with output.open("xb") as stream:
        stream.write(content.encode())
    return {"port": port, "file": str(output), "sha256": sha_file(output)}


def preflight(instance_path, package, session=None, account=None):
    with deployer(instance_path) as deploy:
        earlier = deploy.preflight(package)
        if account is None:
            failures = doctor_report(deploy, "doctor-before.json", session=session)
        else:
            with authenticated_probe(deploy.instance["publicBaseUrl"], account) as headers:
                failures = doctor_report(deploy, "doctor-before.json", headers=headers)
        return Path(earlier["audit"]), failures


def apply(instance_path, package, account_path, fixture_path):
    instance = Deployment(instance_path).instance
    origin = instance["publicBaseUrl"]
    account = account_file(account_path, origin)
    image = fixture_bytes(fixture_path)
    previous, failures = preflight(instance_path, package, account=account)
    check(failures == 0, "上线前自检未通过，应用未切换")
    expected_release = read_json(package / "release-manifest.json")
    with deployer(instance_path) as deploy:
        receipt = deploy.apply(package, previous, verify_public=False)
        audit = Path(receipt["audit"])
        try:
            check(receipt["commit"] == expected_release["commit"], "切换回执与目标提交不一致")
            with authenticated_probe(origin, account) as headers:
                failures = doctor_report(deploy, "doctor-after.json", headers=headers, expected_release=expected_release)
                check(failures == 0, "切换后 16 项自检未通过")
                image_receipt = image_roundtrip(origin, headers, image)
            write_new_json(audit / "public-acceptance.json", {"status": "passed", "commit": receipt["commit"],
                           "login": "passed", "sse": "passed", "imageRoundTrip": image_receipt})
            return receipt
        except (OSError, ValueError, KeyError, TypeError, HTTPException, subprocess.SubprocessError) as error:
            print("切换后生产域名验收失败，进入应用回滚。", file=sys.stderr, flush=True)
            try:
                detail = str(error) if isinstance(error, ProbeFailed) else type(error).__name__
                write_new_json(audit / "public-acceptance-failure.json", {"status": "failed", "commit": receipt["commit"], "detail": detail})
            except OSError:
                print("无法写入验收失败记录，继续执行应用回滚。", file=sys.stderr, flush=True)
    with deployer(instance_path) as recovery:
        result = recovery.rollback(audit)
    write_new_json(audit / "public-acceptance.json", {"status": "failed", "commit": receipt["commit"], "rollback": result})
    raise ProbeFailed("生产验收未通过，已从留档镜像回滚应用")


def main():
    parser = ArgumentParser(description="按宝塔部署规范验证并发布应用")
    subparsers = parser.add_subparsers(dest="operation", required=True)
    for operation in ("plan", "apply"):
        command = subparsers.add_parser(operation)
        command.add_argument("instance", type=Path)
        command.add_argument("package", type=Path)
        if operation == "plan":
            command.add_argument("--session-file", type=Path)
        else:
            command.add_argument("--probe-account-file", type=Path, required=True)
            command.add_argument("--fixture", type=Path, required=True)
    proxy = subparsers.add_parser("render-proxy")
    proxy.add_argument("instance", type=Path)
    proxy.add_argument("output", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    require_local_engine()
    if args.operation == "render-proxy":
        print(json.dumps(render_proxy(args.instance, args.output)))
        return 0
    require(args.package.is_absolute() and args.package.is_dir() and not args.package.is_symlink(), "发布包必须为绝对路径目录")
    if args.operation == "plan":
        directory, failures = preflight(args.instance, args.package, session=args.session_file)
        print(json.dumps({"status": "blocked" if failures else "ready", "preflight": str(directory), "doctorFailures": failures}))
        return int(failures != 0)
    receipt = apply(args.instance, args.package, args.probe_account_file, args.fixture)
    print(json.dumps(receipt))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ProbeFailed, Rejected) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, TypeError, HTTPException, subprocess.SubprocessError):
        print("发布或回滚未完成，请检查私有审计及当前线上状态。", file=sys.stderr)
        sys.exit(1)
