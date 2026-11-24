#!/usr/bin/env python3
import argparse
from contextlib import contextmanager
import fnmatch
from http.client import HTTPConnection, HTTPSConnection, HTTPException
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "release"))
from contract import Rejected, assert_migrations, container_map, read_json, require, validate_instance, write_new_json
from deploy import private_directory, sha_file


class ProbeFailed(ValueError):
    pass


def check(condition, message):
    if not condition:
        raise ProbeFailed(message)


def run(*argv, data=None, timeout=12):
    result = subprocess.run(argv, input=data, capture_output=True, timeout=timeout, check=False)
    check(result.returncode == 0, "只读探针执行失败，请检查命令权限与目标服务")
    return result.stdout


@contextmanager
def request(origin, path, headers=None, timeout=8):
    url = urlsplit(origin)
    connection_type = HTTPSConnection if url.scheme == "https" else HTTPConnection
    connection = connection_type(url.hostname, url.port, timeout=timeout)
    try:
        connection.request("GET", path, headers={"Accept-Encoding": "identity", **(headers or {})})
        response = connection.getresponse()
        check(response.status == 200, f"{path.split('?')[0]} 返回 HTTP {response.status}")
        yield response
    finally:
        connection.close()


def get(origin, path, headers=None, limit=32 * 1024 * 1024):
    with request(origin, path, headers) as response:
        body = response.read(limit + 1)
        check(len(body) <= limit, "响应超过诊断长度上限")
        return body, response.headers


def session_headers(path, origin):
    check(path is not None, "需要提供生产域名专用验收会话 --session-file")
    check(path.is_absolute() and path.is_file() and not path.is_symlink(), "验收会话必须为绝对路径的普通文件")
    check(path.stat().st_mode & 0o077 == 0 and path.stat().st_uid == os.geteuid(), "验收会话文件须由当前用户持有，权限为 0600")
    value = read_json(path)
    check(isinstance(value, dict) and set(value) == {"origin", "cookie"} and isinstance(value["origin"], str)
          and value["origin"].rstrip("/") == origin.rstrip("/"), "验收会话与当前实例域名不一致")
    cookie = value["cookie"]
    check(isinstance(cookie, str) and re.fullmatch(r"[A-Za-z0-9_.-]+=[A-Za-z0-9_.%~-]{8,4096}", cookie), "验收会话必须只包含一个有效的会话 Cookie")
    return {"Cookie": cookie}


def probe_stream(origin, headers, duration=90):
    content, _ = get(origin, "/api/auth/session", headers, limit=32_768)
    payload = json.loads(content)
    user = payload.get("user") if isinstance(payload, dict) else None
    actor = user.get("id", "") if isinstance(user, dict) else ""
    check(isinstance(actor, str) and re.fullmatch(r"[0-9a-fA-F-]{36}", actor), "无法取得有效验收账号身份")
    with request(origin, "/api/tasks/events?ownerId=" + actor, {**headers, "Accept": "text/event-stream"}, timeout=23) as stream:
        check(stream.headers.get_content_type() == "text/event-stream", "任务接口未返回 SSE")
        started = time.monotonic()
        last_heartbeat = started
        initial = False
        heartbeats = 0
        while time.monotonic() - started < duration + 23:
            line = stream.readline(4097)
            check(line and len(line) <= 4096, "任务 SSE 提前断开或内容异常")
            data = line.strip()
            initial |= data == b"event: tasks-changed"
            if data == b": heartbeat":
                heartbeats += 1
                now = time.monotonic()
                check(now - last_heartbeat <= 23, "SSE 心跳中断或被代理延迟")
                last_heartbeat = now
                elapsed = now - started
                if elapsed >= duration:
                    check(initial and heartbeats >= max(1, duration // 15 - 1), "SSE 心跳不足或存在缓冲")
                    return f"持续 {int(elapsed)} 秒，收到 {heartbeats} 条心跳"
        raise ProbeFailed("任务 SSE 心跳未达到要求")


def directive(source, key):
    return re.findall(r"(?m)(?:^|(?<=[;{}]))\s*" + re.escape(key) + r"\s+([^;{}]+);", source)


def location(source, path):
    found = re.findall(r"location\s+(?:=\s+)?" + re.escape(path) + r"\s*\{([^{}]*)\}", source)
    check(len(found) == 1, f"代理缺少唯一 {path} 配置")
    return found[0]


def no_comments(source):
    return re.sub(r"(?m)^\s*#[^\n]*|[ \t]+#[^\n]*", "", source)


def time_setting(value):
    match = re.fullmatch(r"([0-9]+)([smh]?)", value.strip())
    return int(match[1]) * {"": 1, "s": 1, "m": 60, "h": 3600}[match[2]] if match else 0


class Doctor:
    service_roles = ("web", "api", "worker", "postgres", "redis", "minio")

    def __init__(self, instance, session=None):
        self.instance = instance
        self.session = session
        self.app = instance["containers"]
        self.api, self.web = self.app["api"], self.app["web"]
        self.public, self.local = instance["publicBaseUrl"], instance["localBaseUrl"]
        self.ingress = instance.get("ingress") or {}
        self.results = []
        self.roles, self.containers = {}, {}
        self.outer, self.inner = "", ""
        self.runtime_result = {"errors": ["RUNTIME_PROBE_FAILED"], "warnings": []}
        self.html_bytes = b""

    def read(self, number, label, probe):
        try:
            detail, level = probe(), "通过"
        except ProbeFailed as error:
            detail, level = str(error), "失败"
        except (ValueError, OSError, TypeError, KeyError, HTTPException, subprocess.SubprocessError):
            detail, level = "无法完成现场探针，检查实例定义及对应服务", "失败"
        self.results.append({"id": number, "name": label, "status": level, "detail": detail})

    def inventory(self):
        expected = [*self.app.values(), *self.instance["protectedContainers"]]
        self.containers = container_map(json.loads(run("docker", "inspect", *expected)))
        check(all(name in self.containers for name in expected), "实例容器不完整")
        self.roles = {}
        for role in self.service_roles:
            candidates = [self.app[role]] if role in self.app else self.instance["expectedVolumes"]
            names = []
            for name in candidates:
                labels = self.containers[name]["Config"].get("Labels") or {}
                if labels.get("com.docker.compose.project") == self.instance["project"] and labels.get("com.docker.compose.service") == role:
                    names.append(name)
            check(len(names) == 1, f"实例声明未匹配到唯一的 {role} 业务容器")
            self.roles[role] = names[0]
        check(self.roles["postgres"] == self.instance["database"]["container"], "数据库容器身份不一致")

    def config(self):
        self.outer = no_comments(self.proxy_raw().decode())
        self.inner = no_comments(run("docker", "exec", self.web, "cat", "/etc/nginx/conf.d/default.conf").decode())

    def proxy_raw(self):
        path = Path(self.ingress["proxyFile"])
        check(sha_file(path) == self.ingress["expectedProxySha256"], "外层代理文件哈希与实例不一致")
        return path.read_bytes()

    def ports(self):
        port = urlsplit(self.local).port
        bindings = self.containers[self.web]["NetworkSettings"]["Ports"].get("3000/tcp")
        upstreams = set(re.findall(r"http://127\.0\.0\.1:(\d+)\b", no_comments(self.proxy_raw().decode())))
        check(bindings == [{"HostIp": "127.0.0.1", "HostPort": str(port)}] and upstreams == {str(port)}, "Web 实际映射、实例端口及宝塔反代端口必须一致并只监听回环")
        return f"Compose 与反代均为 127.0.0.1:{port}"

    def health_states(self):
        check(set(self.roles) == set(self.service_roles), "无法核实实例的六个业务容器")
        unhealthy = []
        for role, name in self.roles.items():
            state = self.containers[name]["State"]
            if not state.get("Running") or state.get("Paused") or state.get("Restarting") or state.get("Health", {}).get("Status") != "healthy":
                unhealthy.append(role)
        check(not unhealthy, "缺少运行或独立健康状态的服务：" + ", ".join(unhealthy))
        return "Web、API、Worker、PostgreSQL、Redis、MinIO 均为 healthy"

    def health_paths(self):
        source = 'const r=await fetch("http://127.0.0.1:3100/api/health",{redirect:"error",signal:AbortSignal.timeout(5000)});if(r.status!==200)process.exit(1);console.log(await r.text());'
        bodies = [run("docker", "exec", self.api, "bun", "--no-env-file", "-e", source)]
        bodies += [get(origin, "/api/health")[0] for origin in (self.local, self.public)]
        check(all(json.loads(body) == {"status": "ok"} for body in bodies), "健康接口响应与预期 JSON 不一致")
        return "API 容器、本机端口、生产域名均返回 200/ok"

    def release_identity(self):
        live = json.loads(get(self.public, "/deployment-release.json", limit=4096)[0])
        local = json.loads(get(self.local, "/deployment-release.json", limit=4096)[0])
        check(live == local and set(live) == {"schema", "version", "commit"} and live["schema"] == 1
              and re.fullmatch(r"v\d+\.\d+\.\d+", live["version"]) and re.fullmatch(r"[a-f0-9]{40}", live["commit"]), "域名和本机发布标记不一致或格式错误")
        for row in self.app.values():
            labels = self.containers[row]["Config"]["Labels"]
            check(labels.get("org.opencontainers.image.revision") == live["commit"] and labels.get("org.opencontainers.image.version") == live["version"], "运行容器与生产发布标记不一致")
        return live["version"] + " " + live["commit"]

    def migrations(self):
        db = self.instance["database"]
        actual = run("docker", "exec", "-i", db["container"], "psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-U", db["user"], "-d", db["name"],
                     data=b"BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SELECT name FROM schema_migrations ORDER BY name; COMMIT;\n").decode().splitlines()
        files = run("docker", "exec", self.api, "ls", "-1", "/app/src/migrations").decode().splitlines()
        migrations = [{"name": name} for name in files if re.fullmatch(r"[0-9]{3}_[a-z0-9_]+\.sql", name)]
        check(bool(migrations), "当前运行镜像的迁移目录为空")
        try:
            assert_migrations(actual, {"migrations": migrations}, self.instance)
        except Rejected:
            raise ProbeFailed("数据库登记迁移与运行镜像及实例保留清单不一致") from None
        return "运行镜像、历史保留清单与数据库登记一致"

    def runtime(self):
        script = Path(__file__).with_name("runtime-probe.ts").read_bytes()
        self.runtime_result = json.loads(run("docker", "exec", "-i", "-w", "/app", self.api, "bun", "--no-env-file", "-", data=script))

    def environment(self):
        allowed_key = r"[A-Z0-9_]+"
        errors, warnings = (self.runtime_result[key] for key in ("errors", "warnings"))
        check(all(re.fullmatch(allowed_key, key) for key in errors + warnings), "服务端环境探针返回异常")
        check(not errors, "生产变量校验失败：" + ", ".join(errors))
        return "生产变量通过" + ("，提醒：" + ", ".join(warnings) if warnings else "")

    def managed_proxy(self):
        site = Path(self.ingress["siteFile"])
        proxy = self.ingress["proxyFile"]
        check(sha_file(site) == self.ingress["expectedSiteSha256"], "宝塔站点文件哈希与实例不一致")
        includes = directive(no_comments(site.read_text(encoding="utf-8")), "include")
        matches = [value.strip().strip('"\'') for value in includes if fnmatch.fnmatchcase(proxy, value.strip().strip('"\''))]
        check(matches == [proxy], "宝塔站点必须显式 include 已审阅的独立代理文件")
        markers = self.proxy_raw().decode().strip().splitlines()
        check(bool(markers) and markers[0] == "# canvas-site-proxy BEGIN" and markers[-1] == "# canvas-site-proxy END", "独立代理文件缺少 BEGIN / END 管理标记")
        expanded = run(self.ingress["nginxBinary"], "-T").decode()
        check(f"# configuration file {proxy}:" in expanded.splitlines(), "Nginx 未加载实例锁定的代理配置")
        return "显式 include、标记和配置哈希均一致"

    def proxy_streaming(self):
        for source in (self.outer, self.inner):
            for path, minimum in (("/api/chat/responses", 240), ("/api/tasks/events", 75)):
                block = location(source, path)
                timeout = directive(block, "proxy_read_timeout")
                check(len(timeout) == 1 and time_setting(timeout[0]) >= minimum and directive(block, "proxy_buffering") == ["off"], f"{path} 读取超时或代理缓冲未达规范")
        return "双层流式配置达到 240 秒 / 75 秒，代理缓冲关闭"

    def html(self):
        self.html_bytes = run("docker", "exec", self.web, "cat", "/usr/share/nginx/html/index.html")
        check(bool(self.html_bytes), "容器 index.html 为空")
        for path in ("/", "/index.html"):
            content, headers = get(self.public, path)
            check(content == self.html_bytes and headers.get_all("Cache-Control") == ["no-store"], "外层 HTML no-store 或实际字节不一致")
        return "首页与 index.html 为 no-store，字节与容器一致"

    def assets(self):
        paths = re.findall(rb'''(?:src|href)=["'](/assets/[A-Za-z0-9_.-]+\.(?:js|mjs))["']''', self.html_bytes)
        check(bool(paths), "HTML 中缺少可验证的 JS 资源")
        content, headers = get(self.public, paths[0].decode())
        mime = headers.get_content_type()
        directives = {part.strip().lower() for value in headers.get_all("Cache-Control", []) for part in value.split(",")}
        check(content and mime in {"text/javascript", "application/javascript"} and "immutable" in directives, "静态 JS 缺少正确 MIME 或 immutable 缓存")
        return "当前入口 JS 返回 200、JavaScript MIME 和 immutable"

    def deep_link(self):
        content, _ = get(self.public, "/canvas/baota-doctor-proof")
        check(self.html_bytes and content == self.html_bytes, "画布深链未返回当前 index.html")
        return "生产画布深链返回当前 SPA"

    def stream(self):
        return probe_stream(self.public, session_headers(self.session, self.public))

    def upload_limits(self):
        for name, source in (("外层", self.outer), ("容器", self.inner)):
            api = location(source, "/api/")
            limits = directive(api, "client_max_body_size") or directive(source, "client_max_body_size")
            check(limits and all(value.lower() == "200m" for value in limits), name + "上传上限未核实为 200m")
        return "两层 /api/ 上传限制均为 200m"

    def storage_connections(self):
        failed = [label for key, label in (("postgres", "PostgreSQL"), ("redis", "Redis"), ("storage", "MinIO")) if self.runtime_result.get(key) is not True]
        check(not failed, "API 容器无法实际读取：" + ", ".join(failed))
        return "从 API 容器只读查询 PostgreSQL、PING Redis 和列举 MinIO"

    def storage_location(self):
        docker_root = Path(run("docker", "info", "--format", "{{.DockerRootDir}}").decode().strip())
        check(docker_root.is_absolute() and docker_root.is_dir(), "Docker Root Dir 无法核实")
        free = shutil.disk_usage(docker_root).free
        check(free >= self.instance["minimumFreeBytes"], f"Docker 磁盘剩余 {free // 2**30} GiB，低于实例阈值")
        check(docker_root.stat().st_dev != Path("/").stat().st_dev, f"Docker 仍位于系统盘，剩余 {free // 2**30} GiB")
        for container, entries in self.instance["expectedVolumes"].items():
            for entry in entries:
                volumes = [m for m in self.containers[container]["Mounts"] if m.get("Name") == entry["name"] and m.get("Destination") == entry["destination"] and m.get("Type") == "volume"]
                check(len(volumes) == 1 and Path(volumes[0]["Source"]).stat().st_dev == docker_root.stat().st_dev, "保护卷位置和 Docker 数据盘不一致")
        return f"Docker 与业务卷位于同一非系统盘，剩余 {free // 2**30} GiB"

    def timezones(self):
        check(set(self.roles) == set(self.service_roles), "无法核实实例容器时区")
        host = run("date", "+%z").decode().strip()
        check(bool(re.fullmatch(r"[+-]\d{4}", host)), "无法读取主机当前时区偏移")
        mismatched = [role for role, container in self.roles.items() if run("docker", "exec", container, "date", "+%z").decode().strip() != host]
        check(not mismatched, "以下容器时区偏移与主机不一致：" + ", ".join(mismatched))
        return "所有业务容器当前的时区偏移与主机一致"

    def verify(self):
        for what, initialize in (("inventory", self.inventory), ("config", self.config), ("runtime", self.runtime)):
            try:
                initialize()
            except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError):
                if what == "inventory":
                    self.roles, self.containers = {}, {}
        probes = [
            ("端口一致性", self.ports), ("容器健康", self.health_states), ("三层健康接口", self.health_paths),
            ("版本与提交", self.release_identity), ("待执行迁移", self.migrations), ("必需环境变量", self.environment),
            ("代理配置", self.managed_proxy), ("流式配置", self.proxy_streaming), ("HTML 不缓存", self.html),
            ("静态资源", self.assets), ("SPA 深链", self.deep_link), ("流式存活", self.stream),
            ("上传上限", self.upload_limits), ("数据与存储", self.storage_connections),
            ("磁盘与卷位置", self.storage_location), ("主机与容器时区", self.timezones),
        ]
        for number, (label, probe) in enumerate(probes, 1):
            self.read(number, label, probe)
        return self.results


def main():
    parser = argparse.ArgumentParser(description="宝塔生产实例 16 项只读自检")
    parser.add_argument("instance", type=Path)
    parser.add_argument("--session-file", type=Path)
    args = parser.parse_args()
    require(sys.platform == "linux" and not os.environ.get("DOCKER_HOST"), "只支持本机 Linux Docker")
    require(args.instance.is_absolute(), "实例文件必须使用绝对路径")
    instance = validate_instance(read_json(args.instance))
    endpoint = json.loads(run("docker", "context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"))
    require(isinstance(endpoint, str) and endpoint.startswith("unix:///"), "只支持本机 Docker Unix socket")
    os.umask(0o077)
    audit = Path(tempfile.mkdtemp(prefix="doctor-", dir=private_directory(instance["auditRoot"]))) / "doctor.json"
    rows = Doctor(instance, args.session_file).verify()
    failures = sum(row["status"] == "失败" for row in rows)
    write_new_json(audit, {"schema": 1, "kind": "canvas-baota-doctor", "instance": instance["name"], "checkedAt": int(time.time()), "checks": rows, "failures": failures})
    for row in rows:
        print(f"[{row['status']}] {row['id']:2}  {row['name']}  {row['detail']}")
    print(f"结论：{failures} 项未通过。审计文件 {audit}")
    return int(failures != 0)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (Rejected, ProbeFailed, OSError, TypeError, ValueError, KeyError, subprocess.SubprocessError):
        print("宝塔自检无法启动，请检查实例文件、私有审计目录和本机 Docker。", file=sys.stderr)
        sys.exit(2)
