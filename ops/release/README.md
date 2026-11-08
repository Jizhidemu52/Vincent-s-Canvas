# 单一不可变镜像发布链

发布单位是同一完整 commit 构建的 API 与 Web 镜像，不是源码覆盖包。Worker 使用 API 镜像。CI 必须对这两个镜像运行正式 PostgreSQL / Redis / MinIO / API / Worker / Nginx 与七项浏览器 smoke，然后 `docker save` 导出原镜像；测试之后不重建。镜像记录完整 commit、版本、平台、registry digest 与本地 image ID。

发布 job 固定 Ubuntu 24.04、Docker Engine 28.0.4 与 classic `overlay2` image store，启动后核对实际版本和存储驱动；不继承 runner 的可变 Docker 默认值，也不修改目标服务器的 daemon。导出后，`verify-image-export.py` 在 CI 内只读核对 APP / TOOLS 的完整 config image ID 集合以及各层未压缩 SHA256 与 `rootfs.diff_ids` 的顺序一致性；不接受 OCI index 充当 config 或压缩层冒充 classic 层。两个检查通过才上传，仍须保留目标同镜像隔离验收。

CI 的 PDF Worker 探针与工具包导出通过 `--docker-host` 显式绑定该隔离 daemon 的本机 Unix socket，并校验它与当前栈的 `DOCKER_HOST` 一致；远程地址、冲突 context/TLS 环境仍拒绝。容器、镜像、commit、平台及回执约束不变；目标端 `stage-smoke.py` 继续固定使用本机默认 socket，不继承这些 CI 设置。

## 操作入口

验收环境中，仅 Web 同时连接内部业务网络和独立入口网络，并只向宿主 `127.0.0.1` 发布端口；API、Worker、合成 Provider 和数据服务仅连接内部网络。Docker 不会为仅连接 `internal` 网络的容器建立宿主端口映射，因此必须验证实际端口和浏览器入口，而不只检查容器健康。

- `ops/release/stack-smoke.sh candidate.json /new/private/evidence`：仅 GitHub 隔离测试项目；正式后端、合成 Provider、无真实付费调用。
- `ops/release/package-artifact.sh candidate.json verification.json /new/package`：验证同一镜像后导出白名单工具与镜像，不打包环境、数据库或私有配置。
- `bash ops/deploy.sh preflight /absolute/instance.json /absolute/package`：验证包、实际容器/卷/网络/配置、零待执行迁移，生成私有预检证据；不停止容器、不改数据库、不加载镜像。
- `bash ops/deploy.sh apply /absolute/instance.json /absolute/package /absolute/preflight-audit`：仅接受 15 分钟内且仍匹配的预检；先加载并核验镜像、关闭已审阅维护门、排空活动、停止三个应用服务、备份并核对数据库，再替换应用镜像。基础设施和 `newvcan-*` 不变。
- `bash ops/deploy.sh rollback /absolute/instance.json /absolute/successful-deployment-audit`：使用该发布保存的完整旧 Compose 与旧 image ID，在新的维护窗口保留当前数据并回滚应用。旧镜像、旧代码挂载目录和该审计目录必须保留。

隔离栈验证发布标记后、浏览器 smoke 与容器清理前，必须运行 `verify-container-worker.py`：绑定实际 Web 容器、精确 image ID 与 commit，核对 minified PDF worker / URL wrapper 的真实 HTTP 字节、JavaScript MIME、`nosniff`、immutable 缓存，以及 CSS、HTML/no-store 和缺失 worker 的非缓存 404。失败即阻止该栈验收与导出；成功的 `pdf-worker-http.json` 仅作为公有验证回执归档到现有 release-receipts。此探针不创建或修改容器、不访问生产、不调用模型；离线模拟测试不代替正式容器检查。

所有命令都必须使用真实目标的 `instance.json`；没有默认服务器。实例包含已核对的 Compose 文件、环境文件、实际应用容器名、数据库身份、受保护容器及 PostgreSQL/Redis/MinIO 实际 volume 名、网络、维护门脚本 SHA256、域名及本机探针。不能从示例猜生产值。实例与展开后的 Compose 含私有运行信息，应置于 0700 目录且文件 0600，不入仓库。

维护门是实例指定、哈希锁定的 Python 脚本：`python3 gate.py close|verify-closed|open|verify-open <instance.json> <audit-directory>`。该脚本负责当前宝塔站点的维护响应、Nginx 校验和外层入口验证；发布器不会替换证书、站点认证或访问限制。失败时默认保留维护门关闭，不盲目恢复服务或恢复数据库。实例可记录外层代理文件哈希供根任务实际核对。

外层 URL 必须按实际 HTTP/HTTPS 登记；HTTPS 失败不会降级，HTTP 会明确回报未加密限制且不会擅自签发证书。应用 Web 发布端口保持原端口号并缩窄为 `127.0.0.1`；回滚应用也保留该限制，避免绕过宝塔入口。成功发布的展开 Compose 保存在私有 `stateRoot/active-compose.private.json`，后续发布统一从该状态续接，不修改原环境文件。

## 数据与回滚边界

排空同时检查图片／视频缩略图的待处理、退避重试与在途租约；这些后台写入结束前不会停止应用。新 Worker 使用有界只读心跳检查等待就绪，不以刚启动时的一次检查替代就绪确认；不会重放业务请求。

API 默认命令仅 `bun src/index.ts`，Worker 默认仅 `bun src/worker.ts`。迁移与 bootstrap 不随重启执行；首次隔离安装必须显式执行。此次已有实例发布要求数据库登记迁移名与发布清单及显式保留的历史迁移完全一致：有缺失/新增迁移即拒绝发布，不自动补跑。

发布器仅操作实例中的 API、Worker、Web。不会执行 `compose down`、删除卷、清理旧文件、更新 Provider、改价格/历史/员工数据或初始化私有配方。切换前后对全部 public 表进行行数及完整内容哈希核对，并核对 schema、迁移、序列、数据库身份和所有非应用容器。备份用原数据库容器 `pg_dump` 保存到私有审计目录；没有自动数据库 restore。

旧 fingerprinted 静态资源仅从当前 Web 的 `/usr/share/nginx/html/assets` 拷入审计目录，拒绝 symlink、HTML、JSON、map、env 和未带 hash 的文件；新 Web 只读挂载该兼容目录。其他旧源码挂载只删除实例明确列出的只读代码挂载；未知或可写代码挂载直接拒绝。

## 050/051 创意模块的独立准备

`creative-050-051.py` 用于已登记至 049、统计处理仍停用的实例，不切换镜像。050 仅扩展产品提取配置的 CHECK；051 仅新增两个创意模块的缺失开关与模型绑定，并扩展对应 CHECK。两份新默认配方只在整个配方 key 缺失时新增并激活；已有草稿、自定义设置和已发布版本一律保持原样。

包内种子仅从 `new-creative-recipes.ts` 导出两个白名单默认配方，不含旧私有配方或数据库导出。SQL、catalog、种子与工具受同一发布清单及哈希约束。操作者必须是当前启用的超级管理员，优化模型必须是当前启用的聊天模型；不会启用原本关闭的模型。

```sh
python3 -B /absolute/package/ops/release/creative-050-051.py preflight /absolute/instance.json /absolute/package --actor <enabled-superadmin-uuid> --optimizer-model <enabled-chat-model-uuid>
python3 -B /absolute/package/ops/release/creative-050-051.py migrate /absolute/instance.json /absolute/package /absolute/050-051-preflight-audit --actor <enabled-superadmin-uuid> --optimizer-model <enabled-chat-model-uuid>
# 原容器及入口恢复后，重新取得零变更发布预检，再切换同一冻结镜像。
bash /absolute/package/ops/deploy.sh preflight /absolute/instance.json /absolute/package
bash /absolute/package/ops/deploy.sh apply /absolute/instance.json /absolute/package /absolute/new-deploy-preflight-audit
```

预检绑定同一实例、包与参数，有效期 15 分钟。维护门关闭、活动排空、停止原三个应用容器和备份完成后，在固定单事务中锁表、复查完整基线并执行唯一允许的变更。全部原业务行、既有配方、序列和停用的统计状态不变；恢复同一原容器 ID 后再次核对数据库与健康，才打开入口。异常时不自动重放、不自动 restore；结果未知先查实际提交状态，已提交 schema 而入口恢复失败时保留 schema 并排查原服务。

本地 PGlite 和生命周期测试不代替 PostgreSQL 17；发布前必须取得同一冻结 commit 的 Docker CI，包括新增四项真实事务、catalog 与回滚用例的通过结果。

## 049 一键图片配置的独立准备

`quick-image-049.py` 只为已登记此前全部迁移的实例新增固定空配置表与一条迁移记录，不保存模型配置、不启用统计处理，也不切换镜像。已执行 049 的实例拒绝重复运行。包内 SQL、脚本和精确 catalog 受同一文件清单及迁移哈希约束；没有任意 SQL 输入。

```sh
python3 -B /absolute/package/ops/release/quick-image-049.py preflight /absolute/instance.json /absolute/package
python3 -B /absolute/package/ops/release/quick-image-049.py migrate /absolute/instance.json /absolute/package /absolute/049-preflight-audit
# 原容器及正常入口恢复后，重新取得零变更发布预检，再切换同一冻结镜像。
bash /absolute/package/ops/deploy.sh preflight /absolute/instance.json /absolute/package
bash /absolute/package/ops/deploy.sh apply /absolute/instance.json /absolute/package /absolute/new-deploy-preflight-audit
```

预检有效期为 15 分钟。迁移使用现有维护门、活动排空、停止原容器和数据库备份；事务内锁定所有旧表、复查完整基线，只允许新增空 `quick_image_configurations` 表及唯一 049 登记。全部旧业务行、目录、序列、旧迁移和停用的统计状态保持不变。成功时恢复同一原容器 ID，核对健康、完整数据库与保护对象后才打开入口。失败只记录明确阶段和可能关闭的维护状态，不自动重试、恢复数据库或声称入口已恢复；先查实际提交结果再处理。049 复用旧运维模块的只读快照、备份及原容器恢复方法，不执行 048 的迁移或启停操作。

## 048 使用分析的独立准备与启停

`deploy.py` 的零数据库变更合同不变；它既不执行 048，也不开启统计处理。离线包仅额外携带固定 `048_usage_daily_facts.sql`、专用 operator 和精确结构清单；SQL 文件 SHA256 必须同时匹配包文件清单及迁移清单。没有任意 SQL、迁移目录或版本号参数。

以下命令在 Linux 目标宿主执行，使用同一已验证包内的脚本和真实实例文件，所有路径必须为绝对路径；审计目录由命令输出，不能代用其他实例的回执。

```sh
python3 -B /absolute/package/ops/release/usage-048.py preflight /absolute/instance.json /absolute/package
python3 -B /absolute/package/ops/release/usage-048.py migrate /absolute/instance.json /absolute/package /absolute/048-preflight-audit

# migrate 成功且原服务与正常入口恢复后，重新取得当前状态的发布预检。
bash /absolute/package/ops/deploy.sh preflight /absolute/instance.json /absolute/package
bash /absolute/package/ops/deploy.sh apply /absolute/instance.json /absolute/package /absolute/new-deploy-preflight-audit

# 只接受上一步成功切换同一 commit / image IDs 的 apply 审计。
python3 -B /absolute/package/ops/release/usage-048.py enable /absolute/instance.json /absolute/package /absolute/successful-apply-audit
python3 -B /absolute/package/ops/release/usage-048.py disable /absolute/instance.json /absolute/package
```

顺序必须是：**停用态 schema 准备 → 原三个应用容器 same-ID 恢复并打开正常入口 → 原零变更发布器切换镜像 → 独立 enable**。不允许在镜像切换中顺带回填。默认 `processing_enabled=false`；应用重启不改变它。普通源业务按日期与自身事务写入 `usage_source_invalidations`，不争用分析队列或控制状态行；关闭只停止统计入队、调度、处理与失败回写，不清空事实表、任务、dirty 天数或源变更标记。

048 预检有效期 15 分钟，绑定实例、数据库集群身份、容器、配置、包和 SQL SHA。`migrate` 复用现有 `deployment.lock`、维护门和排空检查，停止原应用后保存并验证 `pg_dump`。固定 SQL 与唯一迁移登记在同一事务执行；提交前精确核对全部原业务行/哈希、序列、旧迁移记录，以及 6 张新表、14 个索引（含主键/唯一约束索引）、14 个约束、3 个函数、10 个触发器、停用态种子及初始空的源变更表。PostgreSQL 18 额外暴露的 NOT NULL 约束只从约束列表中排除；同一空值限制仍由列结构逐项精确校验，其他定义不做近似容错。

成功后只 `docker start` 原容器 ID，不创建或替换服务。固定配置、挂载、网络身份、网关及前缀不变；仅已验证的动态 IPv4 同网段租约变化可接受。数据库状态在旧服务启动后再次完整核对，才重新打开维护门。

启停使用与 Worker 一致的事务级 advisory 控制锁：分析事务持共享锁，运维持排他锁。`disable` 等待已经在途的分析事务结束后才返回；它不以“存在超过 30 秒的分析事务”为由提前拒绝。`enable` 另核对成功 apply 回执的封存证据、实际应用镜像、同一数据库身份与精确 048 结构。控制事务只能改 `usage_rollup_state.processing_enabled`，拒绝该表上的额外触发器/规则；启用后 Worker 可立即处理，因此不拿启用前的全库哈希去否定正常统计写入。

SQL 锁等待、语句和宿主命令都有界限。超时或连接中断一律记录“结果未知”，不自动重试、不自动 restore，也不假定迁移回滚。失败默认保留当前维护状态，先核对私有审计的 `phase`、数据库中的 048 登记/结构/开关以及原容器 ID，再决定恢复；不得直接再次运行 migrate，也不能删除表、dirty 记录或清空回执来重试。若 schema 已提交而恢复入口失败，应保留该 schema 和数据，查明服务/入口问题后恢复原应用。

本地 Python 合同与 PGlite SQL 检查不等同目标部署；CI 的 `RUN_DOCKER_COMPOSE_CONTRACT_TESTS=true` 还会在无宿主端口、无持久数据卷的独立 PostgreSQL 17 容器验证真实 catalog 与事务回滚。正式发布仍须等待同一冻结 commit 的完整 CI、目标 048 预检/迁移回执、镜像切换回执和业务页面验收。

“单元/语法检查通过”不是“Docker smoke 通过”，镜像 smoke 也不是“宝塔已部署”。真实交付必须有同一 commit 的成功 CI、包哈希、目标实例预检、维护窗口切换回执、外层代理验证和实际页面验证。当前机器无 Docker 时必须如实记录，不能跳过 CI 证明。
