# 提示词优化付费质量矩阵

入口：`prompt-quality-matrix.ts`。这是手动运行的 QA 脚本，CI 不执行付费请求。不带 `--execute` 时只读取本地文件与 Git 基线，生成计划，网络请求为零。

## v0.5.6 定向修复复测

`prompt-repair-live-qa.ts` 仅用于本地隔离环境，固定连接 `http://127.0.0.1:3100` 和仓库 `output/prompt-optimization/repair-v1/state.sqlite`。必须先通过 SQLite 一致性备份创建专用 QA 克隆，并让 Demo 的 `DEMO_STATE_PATH` 指向该克隆；不可直接复制正在写入的 SQLite 主文件，不得指向生产库。准备模型凭据及足够余额由运行者负责。默认 dry-run 只生成计划，不调用模型；`--execute` 会创建和临时激活候选配方，仅在正常退出路径恢复，因此异常终止后须依据 ledger 核对克隆中的激活状态。

在 `server/` 运行 `bun scripts/prompt-repair-live-qa.ts` 检查计划。明确授权付费后才加 `--execute`；`PQ_REPAIR_RUN` 设置独立批次名，`PQ_REPAIR_ONLY` 用逗号分隔用例前缀，`PQ_MODEL_CONFIG_ID` 固定同批次模型。规则或输入变化必须使用新 run ID；已有尝试先查原请求，不自动重提。`--recover-download` 仅对已知原任务的结果下载失败调用恢复接口，不重新生图。

本轮的原素材和全部结果已公开在 `docs/manual/prompt-optimization/testing/`，其中 fixtures 为原始测试素材；主矩阵脚本的旧本地素材路径需按清单准备。离线发布脚本 `export-prompt-repair-evidence.ts` 只读本轮克隆与日志，核对候选配方已恢复、PNG SHA-256 一致后，按字段白名单导出到 `testing/repair-v0.5.6/`。不复制运行数据库、凭据、原始供应商响应或员工资料。已知问题和调用统计以该目录报告为准，CI 不运行这些付费脚本。

## 内容与边界

- 9 个创意场景各 10 组旧版/新版对照，共 180 条；旧版从 Git `4ed9d8d` 的真实 `buildScenePrompt` 读取，加原参考图片编号前缀。新版调用当前前端的真实 `scenePromptInput`，再经 `/api/prompt-compilations` 和 `/api/tasks`。
- 6 类工作流各 2 例、9 个模板分支各 2 例、系列配方 2 例、反推 2 例、普通输入优化开/关各 2 例、两种聊天 profile 各 2 例、批次优化开/关各 1 批（每批 2 图）。总计 224 条记录，计划 220 张图、127 次编译、4 次聊天；缓存命中、失败、阻塞会减少实际上游调用，不承诺固定费用。
- 执行时另枚举其他启用图片模型，每模型 1 个协议烟测；没有合法可选工具绑定的模型标为 `blocked`，不自动修改管理员配置。
- 旧版/新版必须使用相同实际图像模型；工具绑定不一致会在付费调用前阻止该对照。对照默认没有用户自定义全局 system prompt，未控制模型内部随机种子。
- 素材清单在 `prompt-quality-cases.ts`。一张衬衫位于 `labs/`，其余为当前工作区既有的 `output/` 测试素材，不含用户业务私密素材。移植脚本时需一并提供列出的原始素材。两个 72px 辅料样本仅作低质输入压力测试，不进入主视觉结论；其余八个辅料样本使用已查看的 1024px 两孔/四孔纽扣。高分辨率纽扣为过去 QA 的生成素材，不是实物或生产可行性证据。
- 反推与页面一致：`mode=edit`、`canvas-edit`，未指定 `outputLanguage`，使用配方默认英文 prompt 和中文摘要，只编译、不调用图片任务。
- 聊天样本只验 profile 的规划/分析响应，不执行返回工具。完整多轮纠错、工具链、生图、UI 按钮、复制、导出、刷新恢复、模板并行图与工作流完整串行链，需额外浏览器验收。
- 本矩阵没有真实 mask/蓝色选区样本，不能代表严格蒙版或本地合成验收。`success` 仅表示接口与结果取回成功，所有视觉状态始终为 `pending-manual-review`。

## 运行

在仓库的 `server/` 目录运行：

```powershell
bun scripts/prompt-quality-matrix.ts --run-id visual-v1
```

实际执行前，在当前进程环境设置：

- `PQ_API_BASE`：已配置模型与配方的 API origin，例如 `http://127.0.0.1:3100`。
- `PQ_COOKIE`：现有授权会话的完整 cookie，仅运行时使用，不写到脚本、日志或仓库。免登录部署若 `/api/auth/session` 已返回当前用户可留空。
- `PQ_CONCURRENCY`：默认 `4`，允许 `1–8`。
- `PQ_TIMEOUT_MS`：每个图片任务观察时限，默认 `1200000`。
- `PQ_POLL_MS`：查询间隔，默认 `3000`。
- `PQ_MODEL_CONFIG_ID`：可选的缺省图像模型配置 ID；已有板块绑定始终优先，不能借此绕过绑定。

先执行一组对照，再用同一 run ID 扩展：

```powershell
bun scripts/prompt-quality-matrix.ts --run-id visual-v1 --only text-to-style-01 --limit 2 --execute
bun scripts/prompt-quality-matrix.ts --run-id visual-v1 --execute
```

`--only` 接受逗号分隔的分组或 case ID 前缀，例如 `creative`、`workflow`、`template`、`series`、`batch`、`reverse`、`free`、`chat`、`protocol`。`--limit` 限制当前选中记录数。成功/明确失败项不会重发；状态不明项只查询原请求编号。

## Ledger 与恢复

本轮原始 QA 素材和结果已按用户授权发布于 `docs/manual/prompt-optimization/testing/`。移植到新工作区时可读取 `testing/call-accounting.json` 的 `fixtures` 映射，将 `testing/<path>` 复制到对应 `originalPath`；仅补缺失文件，不覆盖现有素材。`evidence-manifest.json` 提供原始字节 SHA-256，禁止用缩略图代替。

不确定场景的补充十组使用 `--extended-scenes`，case ID 为 11–20；当前只包含 `style-to-sketch` 和 `garment-colorway`，应使用独立 run ID，例如 `visual-v2-extended`。技术输出契约修正后的 v2 与原 v1 分开报告，不用新结果覆盖原失败。`prompt-contract-live-qa.ts` 为原五个缺字段输入的双模型文字复测，`prompt-quality-supplement.ts` 为已优化提示词实图对比及原始/合成蒙版分别验收；它们都需要显式执行授权。

输出位于 `output/prompt-optimization/quality-matrix/<run-id>/`：

- `plan.json`：输入、素材职责和逐例验收点，不含私有配方。
- `ledger.json`：在每个付费 POST 前持久化 attempted 标记、原请求编号、编译编号、任务状态。刷新/重跑不可自动重复该 POST。相同 run ID、输入、员工、API origin、图像模型必须保持不变。
- `report.json`：脱敏结果。原始图片字节按 magic bytes 推断扩展名，另记录 HTTP Content-Type、字节数、SHA-256；二者不一致不会伪装成请求格式。
- `review.html`：旧版/新版相邻查看，含原输入、最终提示词和验收点。需逐例人工检查，填写外部视觉审阅记录。

成功响应、请求受理、图像正确、严格选区遵循是不同结论。不能以成功计数代替视觉通过率。

实际优化费用与估算费用分栏；上游未返回的费用保留 `null`。任务的 `rmbCost` 仅是应用配置扣费，不能报告为真实图像供应商账单。报告不保存 Cookie、Provider Key、私有配方、原始模型响应、内部输入快照或带签名的结果 URL。

同一 run ID 有进程锁。若进程异常退出留下 `.run.lock`，先核实该运行进程已结束，再仅移除该 run 目录内的锁文件；不要删除 ledger，不要为绕过未知状态随便换新 run ID。中断发生在落盘后但 POST 前时也会保守地只查询，必要续交需人工判断。

## 验证

```powershell
bun test ./tests/prompt-quality-matrix.test.ts
bunx tsc --project scripts/tsconfig.prompt-quality.json --pretty false
```

测试仅访问本机临时 mock API，验证零网络 dry-run、224 个样本操作合同、原 ID 恢复、部分批次、真实 MIME、费用未知和脱敏；不会访问真实模型。
