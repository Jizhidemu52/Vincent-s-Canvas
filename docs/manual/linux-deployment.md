# Linux 部署指南

本文面向首次在 Linux 服务器安装无线画布的管理员，使用仓库现有 Docker Compose 完整服务，不使用 Windows 本地演示服务。命令在 **Linux Bash、仓库根目录**执行；需要有 Docker 使用权限，没有权限时由管理员执行，勿开放 Docker socket。

已按当前仓库的 Compose、Dockerfile、环境校验、初始化和备份脚本核对。本文不表示已在你的 Linux 服务器完成部署；当前编写环境未运行 Docker，镜像构建、HTTPS、上传和真实模型调用仍需按下文验收。

## 1. 准备什么

- Linux **x86_64 / amd64** 服务器，例如 Ubuntu 24.04 LTS。当前 `ops/backup/Dockerfile` 下载的是 `linux-amd64` 客户端，不要直接套用到 ARM 服务器。
- 起步可预留 4 核、8 GB 内存、100 GB 可用磁盘，这是规划建议而非容量保证；视频、多用户和大量素材需要增加资源。外部 API 生图不要求服务器配 GPU。
- Git、OpenSSL、Docker Engine、Docker Compose 插件（本指南需要 **2.24.4 或更新版本**）、可用的 HTTPS 域名和证书。
- 服务器能访问 GitHub、容器镜像仓库、包仓库以及实际模型 API。容器出站网络也必须可用。
- 独立于本机磁盘的备份位置。

Docker 安装按发行版官方步骤进行：[Ubuntu](https://docs.docker.com/engine/install/ubuntu/)、[Debian](https://docs.docker.com/engine/install/debian/)、[Compose 插件](https://docs.docker.com/compose/install/linux/)。已有 Docker 时不要盲目卸载重装，以免影响其他服务。

```bash
uname -m
docker version
docker compose version
git --version
openssl version
df -h
```

本指南默认 HTTPS 反向代理安装在**同一台 Linux 主机**。若公司网关位于另一台服务器，需由 IT 改为受控内网监听和来源访问限制，不能直接照搬下面的回环地址。

## 2. 获取代码，先保住旧数据

在准备存放项目的目录执行：

```bash
git clone https://github.com/Jizhidemu52/Vincent-s-Canvas.git
cd Vincent-s-Canvas
git rev-parse --short HEAD
umask 077
test -e .env || cp .env.example .env
chmod 600 .env
```

如果目录已存在，先检查原项目和数据，不要覆盖；升级流程见第 8 节。不要把本机 `node_modules`、`.env` 或演示服务内存快照当成 Linux 安装包。

**当前 Windows 演示服务不会自动迁移。** 切换前在旧浏览器导出画布，并下载需要保留的图片、视频和其他文件。浏览器画布是本地数据，换域名、端口或浏览器不会自动出现；正式素材库与本地画布也不是同一份备份。导出后核实文件可读，保留旧环境直到新环境验收完成。

## 3. 填写根目录 `.env`

用服务器文本编辑器编辑 `.env`，不是 `web/.env`，也不是 `server/.env`。根目录 Compose 明确加载根目录 `.env`。

分别生成三个独立密码和一个 Provider 加密密钥，将输出填入对应变量，不要复用：

```bash
# 分别用于数据库、初始管理员、对象存储密码
openssl rand -hex 24
openssl rand -hex 24
openssl rand -hex 24
# 只用于 PROVIDER_ENCRYPTION_KEY
openssl rand -base64 32
```

| 变量 | 填写要求 |
| --- | --- |
| `POSTGRES_PASSWORD` | 独立随机密码，至少 16 位；建议使用上面生成的十六进制值，避免数据库 URL 中的特殊字符转义问题 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 首次管理员密码，至少 12 位 |
| `PROVIDER_ENCRYPTION_KEY` | `openssl rand -base64 32` 的完整输出，必须单独安全备份 |
| `S3_SECRET_ACCESS_KEY` | 独立对象存储密码，至少 16 位 |
| `NODE_ENV` / `TRUST_PROXY` | 保留 `production` / `true` |
| `TASK_MOCK_MODE` | 正式环境为 `false` |
| `WORKER_CONCURRENCY` | 默认 `10`，程序允许 1–40；还受后台每个模型的并发上限限制 |
| `S3_ENDPOINT` | 保留 `http://minio:9000`，不要改成容器内无法访问的 `localhost` |
| `S3_PUBLIC_ENDPOINT` | 不需要外部素材引用时可留空；视频/音频供应商拉取素材时见第 6 节 |

保留示例中的 `S3_BUCKET`、`S3_REGION`、`S3_ACCESS_KEY_ID` 等其他必要字段。Compose 自动给 API、Worker 注入数据库和 Redis 的容器网络地址，无需自行在根目录拼接 `DATABASE_URL`。

暂不使用企业微信时，**四项全部留空**，包括示例自带的回调地址：

```dotenv
WECOM_CORP_ID=
WECOM_AGENT_ID=
WECOM_SECRET=
WECOM_CALLBACK_URL=
```

保留账号登录可用以下配置；若只想关闭内部积分，单独把 `CREDITS_ENABLED` 改为 `false`：

```dotenv
AUTH_ENABLED=true
CREDITS_ENABLED=true
ROLE_PORTALS_ENABLED=true
```

内部积分关闭不代表供应商免费。公网不要为省事开启免登录。Provider API Key 后续在管理员后台录入，不写入前端环境变量或 Git。丢失 `PROVIDER_ENCRYPTION_KEY` 会导致已有加密凭据无法解密，不要在每次升级时重新生成它。

## 4. 限制端口并运行预检

默认 `docker-compose.yml` 的 `3000:3000` 会监听所有网卡。为同机 HTTPS 代理创建 `docker-compose.override.yml`，内容如下（若文件已存在，先人工合并，勿覆盖）：

```yaml
services:
  web:
    ports: !override
      - "127.0.0.1:3000:3000"
```

`!override` 是有意使用的：普通列表合并可能保留原来的公网端口映射；它要求 Compose 2.24.4+，参见 [Docker 合并规则](https://docs.docker.com/reference/compose-file/merge/#replace-value)。该文件是服务器本地配置，不要提交真实部署信息。

定义本次终端使用的简写，后续命令都使用同一个项目名和同一组配置：

```bash
dc() { docker compose -p wireless-canvas -f docker-compose.yml -f docker-compose.override.yml "$@"; }
dc config --quiet
docker run --rm --env-file .env \
  -v "$PWD:/workspace:ro" -w /workspace \
  oven/bun:1.3.13 bun ops/preflight/production-preflight.ts
```

新开 SSH 终端后，需要进入同一目录并重新定义 `dc`。已有部署不能随意改项目名，否则可能挂到另一组空数据卷。`config --quiet` 不展开打印密钥；不要把完整 `docker compose config` 输出贴到聊天或工单。

预检必须为 **0 项错误**。未启用企业微信、提醒首次改密属于可解释的提醒。预检只验证配置，不会验证模型是否能出图。

## 5. 启动完整服务与 HTTPS

```bash
dc up -d --build
dc ps -a
dc logs --tail=100 api worker minio-init backup
curl -fsS http://127.0.0.1:3000/api/health
```

API 启动命令自动迁移数据库并初始化管理员；`minio-init` 创建 Bucket 并启用对象版本保护，完成后显示 `Exited (0)` 是正常的。其余常驻服务应运行，带健康检查的服务应健康。先确认初始化成功，再上传素材。

对外只开放 HTTPS 入口；不要公开 `3000`、`3100`、`5432`、`6379`、`9000`、`9001`。Docker 发布的端口可能绕过 UFW，不能只依赖 `ufw deny`，参见 [Docker 防火墙说明](https://docs.docker.com/engine/network/packet-filtering-firewalls/)。

生产 Cookie 带 `Secure`，所以 `http://服务器IP:3000` 不是正式登录入口。应访问 `https://你的域名/admin/login`。

若已有公司 HTTPS 网关，让 IT 转发到上述 Web 入口。若使用同机 Nginx，可将下列配置纳入宿主机 Nginx 的站点配置；**先换成实际域名、有效证书路径**，不要直接覆盖现有站点：

```nginx
server {
    listen 443 ssl;
    server_name canvas.example.com;
    ssl_certificate /etc/nginx/tls/canvas/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/canvas/privkey.pem;
    client_max_body_size 200m;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_buffering off;
    }
}
```

证书签发、DNS 和自动续期由公司网关或选定的证书工具管理；本仓库不自动签发证书。确认宿主机安装并管理 Nginx 后执行：

```bash
sudo nginx -t
# 仅在上一步成功后执行
sudo systemctl reload nginx
curl -fsS https://你的实际域名/api/health
```

仓库内层 `nginx.conf` 的 `/api/` 代理没有显式设置长超时或关闭缓冲。若需要长时间流式聊天，应在内层对应 `location` 也配置 `proxy_read_timeout 600s;`、`proxy_send_timeout 600s;` 和 `proxy_buffering off;`，再执行 `dc up -d --build web`。只调外层不能消除内层超时；该服务器定制需在升级时保留。

## 6. 首次登录、接入模型

1. 通过 HTTPS 打开 `/admin/login`，使用 `.env` 中的管理员账号与初始密码，按要求改密。
2. 在后台「板块 API 配置」填写供应商协议、Base URL、API Key、模型 ID、能力和并发上限，启用所需模型。API Key 只由服务端保存。
3. 配置设计师账号、模块权限和额度；启用内部积分时，应确保测试账号额度足够。
4. 用一张不敏感图片测试上传、编辑和下载。真实模型测试可能计费，按供应商价格控制次数。
5. 画布提交任务 A，服务器接收后再提交任务 B，确认两项各自显示状态。前端可连续提交，不等于供应商无限并发，后台仍可能排队。

视频/音频模型若需要主动拉取参考素材，`http://minio:9000` 只在容器网络内可用。需设置真实受控的 HTTPS 对象入口 `S3_PUBLIC_ENDPOINT`，并确认签名 URL 能被供应商访问；不要把 Bucket 改成公开读，也不要暴露 MinIO 管理控制台。具体要求见 [生产部署与验收](production-deployment.md)。

确认超级管理员完成改密且能重新登录后，从 `.env` **删除整行** `BOOTSTRAP_ADMIN_PASSWORD`（不能保留空值），再复验并重建相关容器：

```bash
dc run --rm --no-deps -v "$PWD:/workspace:ro" -w /workspace \
  api bun ops/preflight/production-preflight.ts --after-bootstrap
# 仅在复验成功后执行；不要在有运行任务时重建 Worker
dc up -d --force-recreate api worker
```

这里覆盖了 API 默认启动命令，预检只读检查数据库中的管理员状态，不会额外启动一份 API。改 `.env` 后单纯 `restart` 不会重新注入配置，应使用 `up -d` 重建。

## 7. 验收与备份

上线前确认：HTTPS 登录和重新登录正常；设计师权限正确；上传、生成、下载成功；刷新后服务端素材仍可访问；画布导出可用；第二项任务不会被前端长期锁住；日志无持续报错。不要用 `/api/health` 成功代替业务验收。

```bash
dc logs --tail=100 backup
# 手工触发一份数据库备份，仍沿用现有 30 天保留策略
dc run --rm --no-deps -e BACKUP_RUN_ONCE=true backup
```

默认每 15 分钟备份 PostgreSQL 到同一 MinIO 的 `backups/postgres/`，保留 30 天。**同机备份不是异机灾备**：数据库备份、素材对象及其必要版本、`.env`/Provider 加密密钥都需复制到独立受控位置；浏览器画布另外导出。备份包含敏感业务数据，应限制读取权限。

恢复会覆盖目标数据库，必须先核实目标、备份时间、文件可读取和素材对应关系，在隔离环境演练。操作和影响见 [生产部署与验收的备份恢复章节](production-deployment.md#7-备份与恢复)，不要直接对正在使用的数据库尝试恢复。不要执行 `docker compose down -v` 或带卷清理的 prune 来“修复启动”。

## 8. 后续升级

先通知使用者，等待运行任务结束并导出本地画布；执行备份，记录当前 Git 提交和服务器定制。升级存在短暂停机，不承诺零停机。

```bash
git status --short
git rev-parse HEAD
dc run --rm --no-deps -e BACKUP_RUN_ONCE=true backup
git fetch origin
git diff HEAD..origin/main -- docker-compose.yml nginx.conf server/src/migrations
# 本地改动已核对、备份成功后才继续；有冲突时停下处理，不要强制覆盖
git pull --ff-only
dc up -d --build
dc ps -a
curl -fsS http://127.0.0.1:3000/api/health
```

重新执行第 7 节业务验收。保留 `.env`、数据卷、Compose 项目名及本地覆盖配置；不要重置密钥。数据库迁移不一定支持反向回滚，不能只切回旧代码就认定恢复完成；需要与旧版本匹配的数据库备份及素材。

## 9. 常见问题

| 现象 | 优先检查 |
| --- | --- |
| Compose 不认识 `!override` | Compose 插件版本是否至少 2.24.4；不要删掉标签后保留两个端口映射 |
| API 启动失败 | `dc logs --tail=100 api`，检查密码、32 字节加密密钥、企业微信四项、数据库迁移 |
| 登录后仍回登录页 | 是否通过有效 HTTPS 域名访问；生产环境不要用裸 HTTP 测登录 |
| 上传失败 | MinIO 健康和 `minio-init` 退出码、Bucket、两层代理上传大小、磁盘余量 |
| 一直排队、不出图 | Worker 日志、模型是否启用、并发上限、额度、容器出站网络、Provider 配置 |
| 视频参考素材拉取失败 | 供应商是否能访问 HTTPS 签名 URL，不能使用容器内部 MinIO 地址 |
| 502/504、聊天不逐步显示 | API 健康、内外两层反向代理超时和缓冲设置 |
| 升级后显示旧页面 | 任务结束并保存后刷新浏览器，检查 Web 镜像是否重建 |
| 换机器后画布消失 | 浏览器本地存储不跨设备同步；用原浏览器导出，再在新环境导入 |
| 备份出现执行格式错误 | 服务器是否 ARM；当前备份镜像中的 MinIO 客户端是 amd64 |

排障日志先脱敏再分享，不粘贴 `.env`、Cookie、完整签名 URL 或 API Key。
