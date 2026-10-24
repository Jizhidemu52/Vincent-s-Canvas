# 提示词优化发布准备

这里只提供可审阅脚本。编写与离线测试阶段没有连接服务器，没有执行构建发布、上传、切换或模型付费调用。实际执行由发布负责人完成。

## 固定目标与边界

- 上一发布：`/home/vcan/releases/canvas-4ed9d8d-20261024`；预期 `/home/vcan/current` 指向它。
- 仅替换 `vincent-s-canvas-api-1`、`vincent-s-canvas-worker-1`、`wireless-canvas-web`；数据库、Redis、MinIO、备份容器及另一套 `newvcan-*` 不动。
- 默认独立优化模型为 `652b3d3c-9bdf-419e-851f-31c5e101daf6`。它只用于首次创建的配方设置，不修改任何 `gpt-chat` 或其他板块绑定。执行前仍验证此 UUID 的模型、Provider、工作流启用状态及 chat 能力。
- `PROMPT_OPTIMIZER_MODEL_ID` 可在**首次切换前**选择另一模型。已有配方的模型和管理员设置不被重复导入覆盖；上线后的模型变更通过超管配方页单独保存。
- 认证和计费模式沿用前一发布的 `.env`、基础 Compose 和发布覆盖文件，不使用仓库 Compose 中的默认登录模式。所有容器环境差异均阻止准备继续。

## 1. 本地最终提交与打包

先由根任务完成最终提交及发布版本记录，保证 `git status --porcelain` 为空。忽略的 `output/` 证据目录不作为业务源码。脚本不会提交、打 tag 或推送。

```powershell
# 仓库根目录；--check 不构建、不打包。
bun scripts/deploy-prompt-release/package.mjs --check
bun scripts/deploy-prompt-release/package.mjs
```

`package.mjs` 从最终 HEAD 生成 Git 归档，再在独立 `build/` 归档副本中执行 frozen-lockfile 安装和正式 Web 构建，不使用当前 `web/dist`。Windows bsdtar 显式使用 UTF-8 header charset，避免中文文件名按 ANSI 代码页解码。环境中的 `VITE_*`、`CANVAS_*` 被移除，并拒绝 standalone 构建。构建前后检查 HEAD、工作区和归档源码字节未改变。

产物位于 `output/prompt-optimization/packages/canvas-<HEAD前7位>-<UTC日期>-prompt/`。同名目录存在就拒绝覆盖。保留 `build/` 是为方便审阅构建证据，它不进入 tar 包；确认发布后可单独清理该产物目录下的构建副本。

包内包括两份已提交的用户原始文档、完整 `server/`（含 `scripts/import-prompt-recipes.ts`）、完整 `shared/`、正式静态产物和本部署目录。`SOURCE-SHA256SUMS`、`SERVER-SHA256SUMS`、`SHARED-SHA256SUMS`、`WEB-SHA256SUMS`、`ORIGINALS-SHA256SUMS`、包级 `SHA256SUMS` 分别覆盖原始归档、服务端、共享代码、静态产物、原始文档和最终包。原始文档放入 API 镜像的私有 `/opt/release/prompt-sources/`，不会复制进 Web 静态目录。

脚本拒绝私有 `.env`、密钥文件、SQLite/数据库转储与 `node_modules` 进入包；允许仓库的 `.env.example`。依赖安装和构建可能访问包管理镜像，但不是模型调用。

## 2. 负责人上传与准备

负责人单独上传 tar.gz，核对本地产物打印的 SHA-256，并解压到 `/home/vcan/releases/<完整发布名>/`。本文件不执行上传。

```bash
cd /home/vcan/releases/<完整发布名>
bash deploy/prepare.sh
```

准备阶段核对现网目标、包哈希、原始文档和容器配置，复制原 `.env`，创建权限为当前 umask 077 的备份目录。保存数据库 custom dump、`pg_restore --list` 可读性证据、原 Compose、环境和容器快照。**这些备份含凭据与员工数据，不可提交 GitHub、公开报告或粘贴完整日志。**

构建基于上一发布的 API/Web 镜像；API 使用正式 `src/index.ts`，完整复制 `server/` 与 `shared/`。准备阶段运行导入器 `--dry-run`，验证原始文档可解析成 18 个唯一 key，但不执行迁移或导入。重复准备验证已有镜像 ID，不重复覆盖已验证的备份。

## 3. 负责人切换

```bash
# 默认 optimizer，或在首次导入前显式传入替代 UUID：
PROMPT_OPTIMIZER_MODEL_ID=652b3d3c-9bdf-419e-851f-31c5e101daf6 bash deploy/cutover.sh deploy
```

只有当前无 waiting/processing 任务才切换；先排空并停止 Web，再等待任务为零，停止 API/Worker。每次尝试创建独立切换备份，不覆盖前次数据库快照。流程顺序固定为：

1. 验证独立优化模型，记录除配方表与迁移记录外全部 public 表的行数及内容指纹；任务排除新增三个列，批次排除新增五个受理元数据列，以兼容 043 前后比较，旧字段仍逐行校验。
2. 执行正式 `src/migrate.ts`，确保 `043_prompt_recipes.sql` 已记录。
3. 显式执行镜像内的 `scripts/import-prompt-recipes.ts`，从已发布原始系统提示词文档导入 18 个配方，使用 `--model` 与 `--activate`。已有当前版本不切换，已有设置不覆盖；重复导入按内容哈希复用版本。
4. 校验全部 18 key 有当前版本；旧版本、编译历史、员工、计费、任务及板块配置均保留。只有新增配方使用指定优化模型。
5. 启动三个应用容器，验证完整源码哈希、Web 哈希、REVISION、API 健康、Worker 心跳和稳定性、未登录私有端点、认证/计费模式完全一致；确认基础设施与另一套容器身份未变，才更新 `current`。

成功后再次执行 `deploy` 只核对目标镜像并返回 `ALREADY_DEPLOYED_NO_REIMPORT`。失败会尝试恢复旧应用镜像和软链接；迁移与导入产生的新表、新版本、历史记录保留，绝不自动恢复旧数据库快照。

## 4. 停用与回滚

```bash
# 仅设置 18 配方 enabled=false；保留版本、编译和历史数据。
bash deploy/cutover.sh disable

# 整版回到上一应用镜像；要求无活动任务，保留所有新增表和数据。
bash deploy/cutover.sh rollback
```

停用是“停止使用这些配方”，不是静默恢复旧的浏览器直拼提示词：必需配方的创作入口可能明确报不可用。若需要恢复完整上一版本行为，使用应用回滚。回滚不执行 `DROP`、删除配方或恢复数据库/媒体卷，也不退还或改写任何计费记录。已回滚再执行只验证旧运行态。

`ROLLBACK_FAILED_MANUAL_RECOVERY_REQUIRED` 表示自动恢复未验证通过，负责人必须检查容器和备份；脚本不会把失败说成成功。备份恢复数据库是独立高风险操作，不包含在这些脚本中。

## 离线验证

```powershell
& 'C:/Program Files/Git/bin/bash.exe' -n scripts/deploy-prompt-release/prepare.sh
& 'C:/Program Files/Git/bin/bash.exe' -n scripts/deploy-prompt-release/cutover.sh
$env:PGLITE_RUNTIME_PATH='D:/重新部署的无限画布/Vincent-s-Canvas/output/mark-admin-qa/runtime'
bun --no-env-file test scripts/deploy-prompt-release/deploy.test.ts
```

合同测试只在临时 Git 仓库、文件夹及隔离 PGlite 数据库运行，不调用 Docker、SSH、curl 或模型。完整远端构建、真实容器环境、OA 登录、真实模型输出与视觉验收均留给根任务负责，不由离线测试代替。

当前离线结果：7 项合同测试通过、0 失败、57 条断言；两份 shell 脚本 `bash -n` 通过。新增真实 Git 归档中文文件名、gzip 编码和字节一致性往返检查；Windows 调用显式指定工作目录与 UTF-8 header charset。隔离 PostgreSQL 测试实际导入 18 配方，随后修改管理员设置与版本，再重复导入，确认原管理员选择、员工余额和原 chat 绑定均保留。批次指纹只排除本次新增的 5 个 admission 元数据列：同时改动这 5 列不会误报；故意修改原有批次 prompt 或员工余额时保护校验均正确拒绝。最初测试夹具将同一 SQL 参数同时用于 UUID/text 曾失败，已拆分参数后通过，未因此修改产品代码。
