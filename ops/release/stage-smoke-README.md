# 宝塔同机隔离 staging 验收

这套工具只运行一次性的隔离测试项目。API/Web/Worker 使用已经通过 CI 的原始 image ID，不在服务器构建应用，也不借用生产数据库、卷、账号、Provider 或密钥。staging 结果写入独立 `stage-verification.json`，不能替代、修改或伪造 CI 发布清单。

宿主要求：Linux/amd64、Python 3.7+、Docker Engine、本机 `/var/run/docker.sock`、Docker Compose v2（已知目标为 2.28.1）、可单独安装配置的宝塔 Nginx。宿主不需要 Bun、Node 或浏览器。此工具不接触现有 Nginx 站点配置，不自动重载 Nginx。

## 两个独立包

- 应用包 `canvas-release-<commit>-amd64.tar`：既有成功 CI 的 API/Web 镜像、`release-manifest.json` 和部署工具。
- 工具包 `canvas-stage-tools-<commit>-amd64.tar`：同一次 CI smoke 实际使用的 PostgreSQL、Redis、MinIO、MinIO-init 精确镜像，以及独立 Playwright 1.64.1 工具镜像、公开测试脚本和本说明。没有 `.env`、员工数据或生产凭据。

先在新的目录解包，并按下载的 `.tar.sha256` 核验整个包；每包内还包含 `SHA256SUMS`。两个包的 commit、平台、workflow run 必须一致。以下路径与端口都是占位；应使用已核实的实际路径和空闲端口，不要覆盖已有目录。

## 1. 准备私有状态与独立 Nginx 配置

```bash
python3 /absolute/stage-tools/stage-smoke.py prepare \
  --release /absolute/release \
  --tools /absolute/stage-tools \
  --state /absolute/new-private-stage-state \
  --web-port 13080 --edge-port 18080
```

工具校验两个包的文件哈希、CI 成功状态与 image ID，然后生成模式为 0700 的私有状态目录、随机测试凭据、隔离 Compose 和 `baota-staging.conf`。项目名为 `canvas-staging-<commit前12位>-<随机12位>`。数据库只允许空库初始化；失败或不明状态不自动重试。

输出中的 `newNginxFilename` 是该次唯一的新配置名。把生成的 `baota-staging.conf` 安装为宝塔 Nginx 配置目录中同名的新文件，必须先确认目标不存在，再 `nginx -t` 并按该服务器既有方式 reload。只新增这个独立 `server {}`；不要替换生产域名配置、证书、认证、反代或防火墙规则。其监听固定为 `127.0.0.1:<edge-port>`，上游也是本机独立 Web 端口；不会对外开放 staging。

本脚本不自动执行这一步。新配置具有本次随机 `X-Canvas-Staging` 响应头，后续验收同时核对配置哈希、该头及 release marker，避免误测生产入口或直接绕过宝塔 Nginx。

## 2. 启动隔离栈

```bash
python3 /absolute/stage-tools/stage-smoke.py up \
  --state /absolute/new-private-stage-state
```

仅加载两个包内的既定镜像；没有 `build`、`pull`、生产更新或共享卷。只创建本次带随机 run 标签的独立内部网络与三个命名卷，分别运行 PostgreSQL、Redis、MinIO、正式 API、正式 Worker、Web 和本地合成 Provider。迁移和测试账号 seed 是明确的一次性操作，`TASK_MOCK_MODE=false`，不运行生产 bootstrap。

失败会保留本次资源和私有恢复记录，不自动删除或重复提交。需要检查后显式 `cleanup`，再用新的状态目录重新准备，不覆盖旧证据。

## 3. 通过真实宝塔入口运行浏览器验收

```bash
python3 /absolute/stage-tools/stage-smoke.py verify \
  --state /absolute/new-private-stage-state \
  --nginx-config /www/server/panel/vhost/nginx/<输出的newNginxFilename>
```

浏览器运行于独立工具容器，使用 `--network host` 访问宿主的本机 staging Nginx 入口。不挂载 Docker socket、生产目录或生产配置，只挂载本次私有测试证据目录；根文件系统只读，浏览器外域请求被拒绝。后端和合成 Provider 留在 `internal` 隔离网络中，Provider 不转发外网请求。

七项真实路径：登录、超过 1 MiB 原图上传、画布生图、原任务仍在运行时刷新并恢复、下载原始字节与尺寸核验、正式视频 Worker 与播放器、正式聊天适配器；另用无缓存的新浏览器上下文重新登录，核验云端画布恢复。

只有全部通过、Provider 收据与浏览器结果一致、没有重复任务提交且镜像/容器身份前后不变，才写入 `stage-verification.json`。`seed.private.json`、Compose、容器详情和浏览器日志均为私有资料，不应作为公开构建产物上传。公开保留 `stage-verification.json` 即可。原图与视频都是本地合成的测试素材，没有付费模型调用。

## 4. 显式清理本次测试资源

```bash
python3 /absolute/stage-tools/stage-smoke.py cleanup \
  --state /absolute/new-private-stage-state
```

清理前先核对资源的本次 run/project 标签、记录的容器/network ID、卷名与创建时间、精确镜像和挂载；任何未知资源、生产名称、外部连接或其他容器占用都使清理停止。随后只按这些精确标识删除本次容器、三个测试卷和内部网络。不使用 `compose down`、`prune`、通配符或前缀删除，不删除应用镜像、证据、生产卷或 `newvcan-*`。

状态目录和独立 Nginx 配置会保留。验收与清理结束后，由操作者再次核对本次文件名和哈希，仅移除本次新增的 staging Nginx 配置，运行 `nginx -t` 并 reload；不要清理生产配置或其他证据目录。

## 当前 workflow 的接入契约

当前 `docker-image.yml` 的 amd64 job 应在应用包成功生成后完成以下步骤；arm64 不生成此工具包。应用镜像不重建。

```bash
docker build --build-arg VCS_REF="$GITHUB_SHA" \
  -f ops/release/stage-smoke-runner/Dockerfile \
  -t "canvas-stage-browser:$GITHUB_SHA" .
runner_id=$(docker image inspect -f '{{.Id}}' "canvas-stage-browser:$GITHUB_SHA")
docker run --rm --pull never --network none --init --read-only --shm-size 1g \
  --tmpfs /tmp:rw,nosuid,size=512m --cap-drop ALL \
  --security-opt no-new-privileges:true --entrypoint node \
  "$runner_id" /smoke/check.cjs
python3 ops/release/stage-smoke-package.py \
  --repository "$PWD" \
  --release "$RUNNER_TEMP/canvas-release-$GITHUB_SHA-amd64" \
  --infra-receipt "$RUNNER_TEMP/release-smoke/infra-images.json" \
  --runner-image-id "$runner_id" \
  --output "$RUNNER_TEMP/canvas-stage-tools-$GITHUB_SHA-amd64"
```

独立上传 `<output>.tar` 与 `<output>.tar.sha256`，不要把工具档混入生产 release manifest。`infra-images.json` 必须由同一次 CI stack smoke 记录：`schema=1`、同 commit、`ci-release-<run>-<attempt>-amd64` 项目、`platform=linux/amd64`，以及 `imageIds.postgres/redis/minio/minio-init`。前三者取实际运行容器的 `.Image`，MinIO-init 在一次性运行前锁定 image ID，且运行后核对未变。

## 验证边界

本地单元/类型/语法检查只证明工具契约与守卫，不等于 Docker 或宝塔整栈已通过。只有 CI 实际构建并启动工具浏览器、同机 staging 执行成功并产生独立回执后，才可把相应层级标为已验收；生产切换仍属于原发布流程。
