# 单一不可变镜像发布链

发布单位是同一完整 commit 构建的 API 与 Web 镜像，不是源码覆盖包。Worker 使用 API 镜像。CI 必须对这两个镜像运行正式 PostgreSQL / Redis / MinIO / API / Worker / Nginx 与七项浏览器 smoke，然后 `docker save` 导出原镜像；测试之后不重建。镜像记录完整 commit、版本、平台、registry digest 与本地 image ID。

## 操作入口

验收环境中，仅 Web 同时连接内部业务网络和独立入口网络，并只向宿主 `127.0.0.1` 发布端口；API、Worker、合成 Provider 和数据服务仅连接内部网络。Docker 不会为仅连接 `internal` 网络的容器建立宿主端口映射，因此必须验证实际端口和浏览器入口，而不只检查容器健康。

- `ops/release/stack-smoke.sh candidate.json /new/private/evidence`：仅 GitHub 隔离测试项目；正式后端、合成 Provider、无真实付费调用。
- `ops/release/package-artifact.sh candidate.json verification.json /new/package`：验证同一镜像后导出白名单工具与镜像，不打包环境、数据库或私有配置。
- `bash ops/deploy.sh preflight /absolute/instance.json /absolute/package`：验证包、实际容器/卷/网络/配置、零待执行迁移，生成私有预检证据；不停止容器、不改数据库、不加载镜像。
- `bash ops/deploy.sh apply /absolute/instance.json /absolute/package /absolute/preflight-audit`：仅接受 15 分钟内且仍匹配的预检；先加载并核验镜像、关闭已审阅维护门、排空活动、停止三个应用服务、备份并核对数据库，再替换应用镜像。基础设施和 `newvcan-*` 不变。
- `bash ops/deploy.sh rollback /absolute/instance.json /absolute/successful-deployment-audit`：使用该发布保存的完整旧 Compose 与旧 image ID，在新的维护窗口保留当前数据并回滚应用。旧镜像、旧代码挂载目录和该审计目录必须保留。

所有命令都必须使用真实目标的 `instance.json`；没有默认服务器。实例包含已核对的 Compose 文件、环境文件、实际应用容器名、数据库身份、受保护容器及 PostgreSQL/Redis/MinIO 实际 volume 名、网络、维护门脚本 SHA256、域名及本机探针。不能从示例猜生产值。实例与展开后的 Compose 含私有运行信息，应置于 0700 目录且文件 0600，不入仓库。

维护门是实例指定、哈希锁定的 Python 脚本：`python3 gate.py close|verify-closed|open|verify-open <instance.json> <audit-directory>`。该脚本负责当前宝塔站点的维护响应、Nginx 校验和外层入口验证；发布器不会替换证书、站点认证或访问限制。失败时默认保留维护门关闭，不盲目恢复服务或恢复数据库。实例可记录外层代理文件哈希供根任务实际核对。

外层 URL 必须按实际 HTTP/HTTPS 登记；HTTPS 失败不会降级，HTTP 会明确回报未加密限制且不会擅自签发证书。应用 Web 发布端口保持原端口号并缩窄为 `127.0.0.1`；回滚应用也保留该限制，避免绕过宝塔入口。成功发布的展开 Compose 保存在私有 `stateRoot/active-compose.private.json`，后续发布统一从该状态续接，不修改原环境文件。

## 数据与回滚边界

API 默认命令仅 `bun src/index.ts`，Worker 默认仅 `bun src/worker.ts`。迁移与 bootstrap 不随重启执行；首次隔离安装必须显式执行。此次已有实例发布要求数据库登记迁移名与发布清单及显式保留的历史迁移完全一致：有缺失/新增迁移即拒绝发布，不自动补跑。

发布器仅操作实例中的 API、Worker、Web。不会执行 `compose down`、删除卷、清理旧文件、更新 Provider、改价格/历史/员工数据或初始化私有配方。切换前后对全部 public 表进行行数及完整内容哈希核对，并核对 schema、迁移、序列、数据库身份和所有非应用容器。备份用原数据库容器 `pg_dump` 保存到私有审计目录；没有自动数据库 restore。

旧 fingerprinted 静态资源仅从当前 Web 的 `/usr/share/nginx/html/assets` 拷入审计目录，拒绝 symlink、HTML、JSON、map、env 和未带 hash 的文件；新 Web 只读挂载该兼容目录。其他旧源码挂载只删除实例明确列出的只读代码挂载；未知或可写代码挂载直接拒绝。

“单元/语法检查通过”不是“Docker smoke 通过”，镜像 smoke 也不是“宝塔已部署”。真实交付必须有同一 commit 的成功 CI、包哈希、目标实例预检、维护窗口切换回执、外层代理验证和实际页面验证。当前机器无 Docker 时必须如实记录，不能跳过 CI 证明。
