# CentOS 7.6 专用安装手册

**宝塔服务器下载慢时，优先使用 [完整离线镜像包安装流程](baota-offline-installation.md)。** 本文的系统、数据盘、Docker 和兼容性检查仍须执行；应用源码构建部分可替换为离线导入。

适用机器：**CentOS 7.6.1810 / x86_64，12 核 CPU、64 GB 内存、14 TB 数据盘，已有 Python 3.7.9**。

本手册使用仓库的 Docker Compose 完整平台，不启动内存型 `demo-server.ts`。以下命令在服务器 Bash 执行；系统安装、Docker 配置由有 sudo 权限的运维人员操作。没有连接你的服务器，本手册已核对源码和官方资料，但不能替代服务器实测。

## 1. 先明确兼容性和部署范围

硬件适合先进行本平台的部署与负载验证；实际容量取决于视频处理、磁盘性能、素材大小和供应商限流，不能由 12 核直接推算同时生图人数。调用外部模型 API 不需要本机 GPU。Python 3.7.9 **不参与项目运行**，不需要升级或替换，也不要改 `/usr/bin/python`，以免破坏 yum 或已有管理面板。

**CentOS Linux 7 已于 2024-06-30 结束维护**；当前 Docker 安装文档面向受维护的 CentOS Stream，而不是 CentOS 7。本方案仅用于明确接受风险后的内网过渡/验证，不应直接作为公网长期生产基线。[CentOS 官方生命周期](https://www.centos.org/centos-linux/)、[Docker 支持范围](https://docs.docker.com/engine/install/centos/)。

长期方案是在新服务器或受支持的虚拟机系统上迁移；Docker 容器共享宿主机内核，不能消除 CentOS 7 的内核和安全风险。不要在这台有 14 TB 数据的机器上直接重装或原地升级系统来“试一下”。

本文保留现有系统，不自动升级内核、不全量 `yum update`、不卸载现有 Docker、不格式化数据盘、不关闭 SELinux/防火墙。若前置检查不通过，先停止相关步骤，由运维处理后再继续。

## 2. 只读检查服务器

```bash
cat /etc/centos-release
uname -m
uname -r
lscpu
free -h
lsblk -f
df -hT
findmnt
getenforce
systemctl is-active docker
command -v docker
command -v nginx
ss -lntp
```

如已安装 Docker，再运行：

```bash
sudo docker version
sudo docker compose version
sudo docker info
sudo docker ps -a
sudo docker volume ls
```

重点记录：

- 实际内核版本，不能只凭系统名称猜测。Overlay2 对 RHEL/CentOS 的历史要求是 `3.10.0-514` 或更高；这只是存储驱动前提，不是本项目全部镜像可运行的保证。
- CPU 指令集及镜像运行结果。老 CPU、老内核上的 Bun 必须执行第 5 节实际镜像检查。
- 14 TB 数据盘**实际挂载点**及文件系统，例如 `/data` 或 `/www`，不要把例子当成实际值。
- Docker 是否已被其他业务/管理面板使用；如果是，不能停服务迁移整个 Docker 数据目录。
- 443、3000 是否已有服务；已有 HTTPS 网关/面板 Nginx 时复用，不并排安装第二套抢占端口。

官方参考：[Overlay2 前提](https://docs.docker.com/engine/storage/drivers/overlayfs-driver/)。Bun 官方说明推荐较新内核，并对部分旧内核降级支持；仍需验证仓库固定的镜像版本：[Bun 安装要求](https://bun.sh/docs/installation)。

## 3. 14 TB 数据盘布局

只在**已挂载、确认可用**的数据盘创建本项目目录。下面会要求输入真实挂载点，且拒绝根目录，不执行分区、格式化或挂载：

```bash
read -r -p '输入已确认的14TB数据盘挂载点: ' CANVAS_DISK
CANVAS_DISK=$(readlink -f -- "$CANVAS_DISK")
test -n "$CANVAS_DISK" && test "$CANVAS_DISK" != / && mountpoint -q "$CANVAS_DISK" || {
  echo '不是独立已挂载目录，停止'; exit 1;
}
findmnt -T "$CANVAS_DISK"
df -hT "$CANVAS_DISK"
```

再次人工核对输出确实属于目标数据盘。若是 XFS，运行 `xfs_info "$CANVAS_DISK"`，核实 `ftype=1`；如为 `ftype=0`，不要重格式化有数据的磁盘，也不要继续把 Overlay2 数据放在该文件系统上。NFS/CIFS 不作为本指南的 Docker/数据库存储路径。

建议布局（不固定划分或预占 14 TB）：

| 路径 | 用途 |
| --- | --- |
| `实际挂载点/wireless-canvas/app` | Git 源码和本机部署配置 |
| `实际挂载点/wireless-canvas/docker` | 仅新装、独占 Docker 时的镜像、容器层和命名卷 |
| `实际挂载点/wireless-canvas/exports` | 人工导出和迁移文件，不作为异机备份 |
| 独立服务器/独立对象存储 | 数据库、素材、密钥的灾备副本 |

```bash
sudo mkdir -p "$CANVAS_DISK/wireless-canvas/app" "$CANVAS_DISK/wireless-canvas/exports"
sudo chown "$(id -u):$(id -g)" "$CANVAS_DISK/wireless-canvas/app" "$CANVAS_DISK/wireless-canvas/exports"
```

以上只调整新建项目目录本身，不递归修改整块盘权限。预留至少约 20% 空闲空间作为起步监控线；这是运维建议，不是配额，也不能替代监控。确认数据盘通过 UUID 等稳定方式开机挂载，重启后仍在同一路径；没有持久挂载方案前不要设无人值守启动。

## 4. Docker：已有环境先复用，新装使用受控历史包

### 4.1 已有 Docker

如果现有 Docker、Compose 能通过版本、存储与镜像检查，优先复用。Compose 必须至少 **2.24.4**，因为本手册的端口覆盖用到 `!override`。不要使用依赖 Python 的旧 `docker-compose` v1。

已有业务容器时，**跳过第 4.3 节全局 data-root 调整**，由运维为本项目单独规划第 6 节的数据盘命名卷绑定；不要卸载、降级或停止整台主机的 Docker。

### 4.2 全新 Docker 环境

先确认 yum 仓库可用：

```bash
sudo yum repolist
```

CentOS 7 的旧 mirrorlist 可能失效。失败时先让运维备份 `/etc/yum.repos.d/` 并配置公司批准的 EL7 归档源；官方归档为 [CentOS Vault](https://vault.centos.org/)。7.9.2009 归档不是持续安全更新；从 7.6 引入归档依赖也可能更新系统库，必须审阅事务。不要全局替换 repo、禁用 GPG 校验、关闭 TLS 校验或全量更新系统。

仅对**没有既有 Docker 业务的新安装**，在系统依赖源正常后执行：

```bash
sudo yum install yum-utils ca-certificates curl git openssl
sudo yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo yum list --showduplicates docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin
```

已在 Docker 官方 EL7 x86_64 包目录核实下列历史包存在，可作为**兼容性试装候选**，不是当前安全推荐版本：[官方 EL7 包目录](https://download.docker.com/linux/centos/7/x86_64/stable/Packages/)。

```bash
# 先预览完整事务；确认只涉及预期软件且没有删除/替换现有业务依赖
sudo yum install --assumeno \
  docker-ce-26.1.4-1.el7 docker-ce-cli-26.1.4-1.el7 \
  containerd.io-1.6.33-3.1.el7 docker-compose-plugin-2.27.1-1.el7 \
  docker-buildx-plugin
# 运维审核上面的事务后，执行同一命令但去掉 --assumeno；不加 -y，保留事务确认
```

如找不到包、GPG 校验失败、依赖冲突或要求降级已有组件，停止，不使用 `--skip-broken`、`--nodeps`、EL8/EL9 包混装。不要直接运行网上“一键安装最新 Docker”脚本。记录最终 `rpm -qa` 中本次安装的版本，包括 Buildx 和自动解析的依赖。

### 4.3 新装独占 Docker：第一次启动前把数据放到大盘

只有尚无容器/卷数据的新 Docker 环境适用。先查看 `/etc/docker/daemon.json` 和 systemd 的 Docker 启动参数；文件已存在时合并配置，不覆盖。将 `实际挂载点` 替换为已核实值：

```json
{
  "data-root": "/实际挂载点/wireless-canvas/docker",
  "storage-driver": "overlay2",
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
```

创建该新目录。SELinux 为 Enforcing 时，由运维使用 `semanage fcontext`/`restorecon` 为这个专用目录配置等价于 `/var/lib/docker` 的标签，不将整块盘重标记、不关闭 SELinux。若缺工具或存在既有规则，先核对系统策略。

建议给 `docker.service` 添加 systemd drop-in：

```ini
[Unit]
RequiresMountsFor=/实际挂载点/wireless-canvas/docker
```

先确认目标挂载已正确配置，再校验、启动：

```bash
sudo dockerd --validate --config-file=/etc/docker/daemon.json
sudo systemctl daemon-reload
sudo systemctl enable --now docker
sudo docker info
sudo docker run --rm hello-world
sudo docker compose version
```

`docker info` 中 Docker Root Dir 必须位于数据盘，Storage Driver 为预期驱动。若启动失败，查 `journalctl -u docker --no-pager -n 100`，不要反复切换驱动；切换 data-root 不会自动搬迁已有镜像和卷。

## 5. 检查项目运行时，避免构建半天才发现不兼容

无需在宿主机安装 Node、Bun 或修改 Python。用仓库固定镜像执行：

```bash
sudo docker run --rm oven/bun:1.3.13 bun --version
sudo docker run --rm oven/bun:1.3.13-alpine bun --version
sudo docker run --rm oven/bun:1.3.13-alpine bun -e 'console.log(await Bun.file("/etc/os-release").text())'
```

这只是启动冒烟检查，不代表 PostgreSQL、MinIO 或业务已验证。出现 `Illegal instruction`、缺失 syscall、段错误、seccomp 或内核错误时，保存日志并停止；不要为绕过问题给业务容器加 `--privileged` 或关闭 seccomp。优先迁移到受支持系统进行部署。

## 6. 安装项目、绑定数据与配置参数

```bash
cd "$CANVAS_DISK/wireless-canvas/app"
# 目录必须没有既有源码；已有安装请走升级流程
git clone https://github.com/Jizhidemu52/Vincent-s-Canvas.git .
umask 077
test -e .env || cp .env.example .env
chmod 600 .env
```

编辑根目录 `.env`，保留其全部必要字段，分别生成随机密码和 32 字节 Base64 加密密钥：

```bash
openssl rand -hex 24
openssl rand -hex 24
openssl rand -hex 24
openssl rand -base64 32
```

前三个分别填入 `POSTGRES_PASSWORD`、`BOOTSTRAP_ADMIN_PASSWORD`、`S3_SECRET_ACCESS_KEY`；最后一个填 `PROVIDER_ENCRYPTION_KEY`。加密密钥另存安全位置，升级不重新生成。

对这台机器建议初始 `WORKER_CONCURRENCY=8`，后台单模型并发从 `2` 开始，依据真实供应商额度和实测逐步调整。不是因为有 12 核就必须开 12/40 并发；视频探测、上传和代理也需要资源。暂不添加未经压测的 PostgreSQL 内存参数或容器内存硬限制。

保留：`NODE_ENV=production`、`TRUST_PROXY=true`、`TASK_MOCK_MODE=false`、`AUTH_ENABLED=true`。要关闭内部积分可设置 `CREDITS_ENABLED=false`，但真实 API 仍可能收费。不使用企业微信时将 `WECOM_CORP_ID`、`WECOM_AGENT_ID`、`WECOM_SECRET`、`WECOM_CALLBACK_URL` **全部清空**。

创建本机 `docker-compose.override.yml`，不覆盖已有文件。默认采用同机 HTTPS 代理，并绑定不与常用 3000 冲突的 **127.0.0.1:3300**（仍应先查端口）：

```yaml
services:
  web:
    ports: !override
      - "127.0.0.1:3300:3000"
```

**若第 4.3 节已将新装 Docker data-root 放到大盘**，默认命名卷也在那里，不需再做绑定。

**若复用已有 Docker，且它的数据目录仍在系统盘**，在首次启动本项目前，创建数据盘专用的 `wireless-canvas/volumes/postgres`、`redis`、`minio` 三个空目录，然后在上述覆盖文件追加以下顶层段落，替换所有实际路径：

```yaml
volumes:
  postgres-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /实际挂载点/wireless-canvas/volumes/postgres
  redis-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /实际挂载点/wireless-canvas/volumes/redis
  minio-data:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /实际挂载点/wireless-canvas/volumes/minio
```

SELinux 标签、目录权限和开机挂载由运维在这些专用目录上配置并验证；不要 `chmod -R 777`。已有同名业务卷时不能套用此步骤改变路径，必须先做迁移。此方案只把业务卷放在大盘，镜像/构建缓存仍在原 Docker 根目录，需要保留系统盘空间。已有业务主机上添加挂载依赖也需审阅影响，不能直接改其他服务启动策略。

## 7. 预检、构建、启动

新开终端后先进入仓库，再定义简写；全文保持项目名不变：

```bash
dc() { sudo docker compose -p wireless-canvas -f docker-compose.yml -f docker-compose.override.yml "$@"; }
dc config --quiet
sudo docker run --rm --env-file .env \
  -v "$PWD:/workspace:ro" -w /workspace \
  oven/bun:1.3.13 bun ops/preflight/production-preflight.ts
```

必须 0 项错误再继续。SELinux 拒绝源码只读挂载时，请运维仅对项目目录配置所需标签；不能把宿主根目录挂进容器或全局关闭 SELinux。

```bash
dc up -d --build
dc ps -a
dc logs --tail=100 api worker minio-init backup
curl -fsS http://127.0.0.1:3300/api/health
sudo docker volume inspect wireless-canvas_postgres-data wireless-canvas_redis-data wireless-canvas_minio-data
```

核对卷的 Mountpoint/Options 最终落在数据盘。`minio-init` 的 `Exited (0)` 正常；其余常驻服务应运行，配置了健康检查的服务应健康。API 自动执行迁移和初始化管理员。

如果本机 Bun 构建或 BuildKit 不兼容，不盲目降级项目：可由受支持的 Linux amd64 构建机从同一提交构建并导出镜像，再传到服务器加载。导入镜像只绕过构建问题，仍然共享旧宿主机内核，不能绕过运行兼容性检查。

## 8. HTTPS 和首次使用

同机 Nginx/管理面板反向代理的目标设为 **`http://127.0.0.1:3300`**；不是 3000，也不是 API 的 3100。如果主机已有宝塔或其他管理面板，只在现有站点系统中增加独立站点，不修改已有 Python，不猜其安装路径。

域名和证书未提供，因此先留待实际配置。证书、两层代理超时/缓冲的完整示例见 [Linux 通用指南](linux-deployment.md#5-启动完整服务与-https)，使用时将示例上游的 **3000 改为 3300**。生产 Cookie 使用 Secure，正式登录必须通过有效 HTTPS；健康检查可在主机回环 HTTP 执行。

不要把 3300、3100、5432、6379、9000、9001 开放到公网；旧 Docker 对回环端口隔离也不应作为唯一边界，应配合公司入口网关、网络 ACL 和实际外部连通性检查。SELinux 拦截 Nginx 到上游的网络访问时，核查 AVC 日志，由运维审阅是否启用所需网络访问策略，不关闭 SELinux。

首次使用：

1. HTTPS 打开 `/admin/login`，用初始化账号登录并修改密码。
2. 在「板块 API 配置」录入供应商协议、Base URL、API Key、模型能力和并发上限；密钥不进前端和仓库。
3. 建立设计师账号及额度；上传一张测试图，再做一次有预算的真实生成、下载。
4. 提交任务 A 后继续提交 B，确认前端可以连续提交；模型达到并发上限时后端排队是正常的。
5. 视频/音频引用素材需要外部可访问的受控 HTTPS 对象地址 `S3_PUBLIC_ENDPOINT`，不能让供应商访问 `http://minio:9000`，也不能把 Bucket 改成匿名公开。
6. 旧 Windows 浏览器导出画布并下载素材，再在新环境导入；旧演示内存和浏览器数据不会因部署自动迁移。

管理员确认改密且能重新登录后，删除 `.env` 中 **整行** `BOOTSTRAP_ADMIN_PASSWORD`，按通用指南执行 `--after-bootstrap` 只读复验，再在无运行任务时重建 API/Worker。不要只将密码留空。

## 9. 备份、验收与升级

```bash
dc logs --tail=100 backup
dc run --rm --no-deps -e BACKUP_RUN_ONCE=true backup
df -hT
sudo docker system df
```

数据库备份默认每 15 分钟保存到 MinIO，保留 30 天。**14 TB 很大，但同一数据盘上的备份不能防整盘故障**：数据库备份、素材对象及必要版本、Provider 加密密钥必须有独立副本，浏览器画布另行导出。以上只查用量，不执行 `prune` 或 `down -v`。

验收应覆盖：HTTPS 重新登录、上传/下载、真实任务、并发任务、账号隔离、备份可读，以及安排维护窗口验证机器重启后的挂载和服务恢复。所有卷落在预期数据盘、异机副本可恢复前，不算部署完成。

升级先等待任务结束、导出画布、备份并记录 Git 提交，审阅本地 override/Nginx 改动，然后 `git pull --ff-only` 和 `dc up -d --build`。不自动升级 Docker/系统，不随意更换项目名，不覆盖密钥。更详尽的恢复和回滚约束见 [生产部署与验收](production-deployment.md#7-备份与恢复)。

## 10. 需要现场确认的四项

- `uname -r` 与 Docker/Compose 当前版本。
- 14 TB 数据盘的真实挂载点、文件系统与 XFS `ftype`。
- 是否已有 Docker、宝塔/其他管理面板、Nginx 或业务容器。
- 实际 HTTPS 域名，以及是仅内网使用还是对公网开放。

这些信息不影响手册交付，但决定哪些安装分支可以执行。在确认前不要把本文路径占位符直接粘贴运行，也不要对已有服务进行迁移或重启。
