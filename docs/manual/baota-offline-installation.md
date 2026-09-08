# 宝塔快速安装：上传完整离线镜像包

适合 GitHub、Docker Hub、依赖仓库下载慢的服务器。构建在 GitHub Actions 的 Linux amd64 环境完成，宝塔端只负责上传、校验、导入和运行。首次镜像包可能较大，具体大小以构建产物为准；不承诺固定下载时间。

服务器仍须先安装可用 Docker Engine 和 Compose 2.24.4+，具备 x86_64 架构、充足磁盘空间及合适的内核。CentOS 7 已结束维护，预构建镜像不能修复宿主机兼容性/安全风险。已有 Python、宝塔和网站不需要替换。

## 一、在 GitHub 生成安装包

仓库合入本功能后：

1. 打开仓库的 **Actions**，选择 **Baota offline installation package**。
2. 点击 **Run workflow**，选择要安装的代码分支。使用当前维护分支，不要运行来历不明的改动。
3. 等待构建和完整服务启动检查全部成功。
4. 在该次运行的 **Artifacts** 下载 `wireless-canvas-offline-amd64-完整提交号`。可能需要登录有仓库访问权限的 GitHub 账号。
5. 解开下载的 ZIP，得到 `.tar` 安装包与对应 `.sha256` 文件。默认产物保留 14 天，应下载留存。

工作流仅手动触发，不会每次提交都构建多 GB 镜像，不发布公开 Release，也不携带生产密钥。它构建前端、API/Worker、备份服务，并收集 PostgreSQL、Redis、MinIO、MinIO 初始化客户端，共 7 个镜像、8 个服务。

完整服务启动检查使用临时随机凭据和模拟模式，不调用付费 Provider。检查失败时不上传安装包；Ubuntu runner 通过不代表 CentOS 7 已验证。该功能刚加入时必须先成功运行一次工作流，仓库源码本身不等于已经有可下载安装包。

本地有合适 Linux amd64 构建机时，也可从仓库根目录运行：

```bash
bash ops/offline/build.sh /已确认的输出目录/wireless-canvas-offline-amd64
```

需要 Bun 1.3.13、Docker、BuildKit、可访问依赖源；输出目录必须尚不存在，上级目录必须存在。脚本会拒绝覆盖旧包。构建与启动检查是独立步骤，手动构建后还应在隔离机器运行 `ops/offline/smoke.sh`；不要对生产目录执行冒烟脚本。

## 二、通过宝塔上传到数据盘

先确认 14 TB 数据盘的实际挂载点和 Docker 数据位置，不默认认为 `/www` 或 `/data` 就是数据盘。安装文件在大盘不代表 Docker 命名卷也在大盘，必须检查 `docker info` 的 Docker Root Dir，或者事先规划本项目卷绑定。

通过宝塔「文件」上传 `.tar` 和 `.sha256` 到确认过的目录。大文件若受宝塔上传大小、超时限制，可用 SFTP 工具传同一文件；这样不依赖服务器直连 GitHub。不要上传真实 `.env` 到公共下载站，也不要用未知 GitHub 代理传递私有仓库令牌。

在宝塔终端切换到上传目录：

```bash
sha256sum -c wireless-canvas-offline-amd64.tar.sha256
# 检查通过后解包；同名目录已存在时改用新的空目录，不覆盖旧安装
tar -xf wireless-canvas-offline-amd64.tar
cd wireless-canvas-offline-amd64
bash offline.sh verify
bash offline.sh init
```

外部校验文件应与可信 GitHub 下载记录对应。校验和只能发现损坏，不能替代来源可信度验证。解包需同时容纳镜像压缩包、导入后的镜像和业务数据，请先检查磁盘空间。

## 三、配置后导入

`init` 仅在不存在 `.env` 时创建配置，不覆盖已有配置。通过宝塔编辑生成的 `.env`：

- 独立设置 `POSTGRES_PASSWORD`、`BOOTSTRAP_ADMIN_PASSWORD`、`S3_SECRET_ACCESS_KEY`。前三项可分别使用 `openssl rand -hex 24` 生成。
- `PROVIDER_ENCRYPTION_KEY` 使用 `openssl rand -base64 32` 生成并单独安全备份，不在升级时重置。
- 保留 `NODE_ENV=production`、`TRUST_PROXY=true`、`TASK_MOCK_MODE=false`。
- 不启用企业微信时四项 `WECOM_*` 全部留空；离线包模板已清空示例回调地址。
- 12 核/64 GB 机器可从 `WORKER_CONCURRENCY=8` 开始，单模型并发按供应商限制配置。内部积分可独立关闭，真实模型仍可能收费。

使用有 Docker 权限的终端执行：

```bash
bash offline.sh load
bash offline.sh up
bash offline.sh status
curl -fsS http://127.0.0.1:3300/api/health
```

`load` 校验包后导入全部镜像；`up` 校验配置并使用 `--no-build --pull never`，因此不会再从 GitHub、包仓库或镜像站下载软件。**实际 AI 调用仍需要联网**。

如果已有同名项目容器，`up` 会停止并提示按升级流程处理，不会自动重启它们。配置错误或缺镜像也直接报错，不偷偷在线下载。`minio-init` 完成后退出码 0 正常；其余常驻服务应正常运行。

默认仅监听 `127.0.0.1:3300`，Compose 项目名固定为 `wireless-canvas`。数据使用命名卷；需要本机端口/数据盘绑定定制时，新建 **`compose.local.yml`**，不要修改受校验保护的 `compose.json`。脚本会加载该本地覆盖文件。卷的文件系统、SELinux 标签、权限和持久挂载由运维先核实，不能把新目录直接替换到旧业务卷上。

## 四、宝塔网站配置

复用宝塔已有 Nginx：新增独立站点，绑定实际域名，申请或配置有效 SSL 证书，再设置反向代理目标为 **`http://127.0.0.1:3300`**。不要公开数据库、Redis、MinIO 端口。

生产登录需要 HTTPS，访问 `https://实际域名/admin/login`。登录后修改初始密码，在「板块 API 配置」录入供应商和模型；API Key 不包含在安装包里。

长请求/流式对话的内外两层代理超时和缓冲仍需按实际使用校验。不要将“页面打开成功”当成完整验收，至少测试重新登录、上传、生成、下载、第二项任务提交、备份。

## 五、升级与恢复保护

不要直接将新包解压覆盖运行目录；先创建新目录并校验，查看 `REVISION` 和 `image-manifest.json`。新包包含完整依赖，升级是否涉及 PostgreSQL/Redis 等镜像应先审阅，不能自动当成仅前端更新。

1. 等待任务结束，导出浏览器画布，备份数据库、素材及密钥，记录旧版本和本地配置。
2. 安全复制旧 `.env`、`compose.local.yml` 到新目录，保留原项目名和数据卷映射；不要替换成示例配置。
3. 在新目录执行 `bash offline.sh load`。导入不会重建现有容器。
4. 用下方手动命令在维护窗口应用升级，然后验收。Compose 会保留卷，但数据库迁移可能不可逆。

```bash
# 在新版本目录定义，与脚本使用完全一致的配置
dc() {
  local args=(-p wireless-canvas -f compose.json)
  if test -f compose.local.yml; then args+=(-f compose.local.yml); fi
  docker compose "${args[@]}" "$@"
}
dc config --quiet
# 首次改密后删除 BOOTSTRAP_ADMIN_PASSWORD 整行，可用此只读复验
dc run --rm --no-deps --pull never -v "$PWD:/workspace:ro" -w /workspace \
  api bun ops/preflight/production-preflight.ts --after-bootstrap
# 上一步成功、备份已核实、无运行任务后再执行
dc up -d --no-build --pull never
dc ps -a
```

首次管理员改密后移除初始密码，也按上述只读复验与维护窗口重建方式操作。备份服务默认将数据库备份写入同一 MinIO，这不是异机灾备；14 TB 数据盘仍需要独立副本。不要用 `down -v`、清卷或 `prune --volumes` 排障。回退代码不保证回退数据库，恢复前核实兼容备份。

## 六、排障与当前边界

- `permission denied`：检查 Docker 权限、SELinux 和数据卷标签，不关闭安全策略绕过。
- 提示镜像不存在：确认下载的是完整 Artifact，执行校验和 `load`；不要改成自动拉取掩盖漏包。
- `Illegal instruction` / 内核调用错误：旧 CentOS/CPU 的运行兼容性问题，离线包无法修复，应迁移到受支持系统。
- 宝塔域名 502：检查站点代理是否指向 3300，以及 `docker compose ... ps` 的 Web/API 健康状态。
- 一直排队：看 Worker、模型配置、供应商并发/额度和网络，不反复提交付费任务。
- Artifact 过期：重新运行工作流或使用已保存的校验通过安装包；不要把过期下载链接当成永久安装地址。

安装包不包含 Docker Engine 本身、证书、生产配置、用户作品或数据库。首次安装 Docker 和域名证书仍需独立准备。
