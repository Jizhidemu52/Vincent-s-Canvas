# 提示词链路评测：初始 100 张与显式追加批次

入口 `tools/prompt-chain-eval.ts`。默认只生成离线计划，无网络、无模型请求。仅通过本项目正式应用 API 调用，不读取 `server/.env`、Provider Key 或用户浏览器凭据；不改配方，不激活版本，不动旧 557 次台账。

## 最小命令

在仓库根目录运行，需已安装项目的 Bun 和 `server/` 依赖：

```powershell
bun --no-env-file tools/prompt-chain-eval.ts plan
bun --no-env-file test tools/prompt-chain-eval
bun server/node_modules/typescript/bin/tsc --project tools/prompt-chain-eval/tsconfig.json --pretty false
```

计划和候选配置在 `output/prompt-chain-optimization/evaluation/`，该目录被 Git 忽略。`plan` 不创建预算数据库。计划每次新建快照，不覆盖既有证据。10 组输入 × 4 策略 × 2 模型 = 80；2 组 × 2 模型 × 3 轮 = 12；8 个复核名额不自动执行。可在首次初始化前缩减初始分组额度，但初始总数不可超过 100，初始化后不能修改。新增付费额度只能按下文单独授权追加，不能覆盖旧预算。

## 执行前由操作者补齐

- `config.json` 中两个图片模型的配置 UUID 和实际模型标识，固定尺寸、质量等参数；所有调用 `n=1`，不支持一次请求多图、自动重试或额外模型枚举。
- 每个场景的 `template` / `minimal` / `legacy` 版本 UUID，分别核验版本策略 `template-first` / `minimal` / `llm`。旧版本缺失策略按 `llm`。使用 `POST /api/admin/prompt-recipes/:scene/test` 测指定版本，不激活生产配方。
- 已配置模型凭据的**隔离正式 API** origin 与 `super_admin` 会话。只允许运行时 `PCE_COOKIE` 环境变量传入会话，不要写进配置、命令记录、仓库或报告。模型凭据仍完全由服务端保管。
- 可用 `image-edit` 工具绑定必须允许对照的两模型；脚本不会改变绑定。非 raw 分组使用合法的管理员版本测试 compilationId，并由服务端复核权限与输入哈希。
- `/api/models` 只用于核验公开可见性、编辑能力和启用工具，其 `modelId` 可能被隐私映射成配置 UUID；真实模型标识一律通过 `GET /api/admin/model-configuration/models` 的管理员 `modelId` 核验，同时要求模型及Provider启用、具备编辑能力。因此新raw尝试也需要super_admin会话；已有尝试恢复仍只查询原任务。
- 正式 APIMart 直连图片模型在预检中复用服务端 `preflightApiMartImageRequest`，所有新任务的公共参数必须先通过，才会预占额度、上传或编译。新starter使用GPT2/Nano2均支持的 `n=1,size=1:1,resolution=1k`，不附加quality。已有config与尝试快照不自动修改；参数有误时由负责人另建运行配置，旧失败仍保留原额度与证据。
- 核对 10 组素材的 `provenance`，逐源设置 `approvedForEvaluation=true`。初始清单来自已有公开 QA `Synthetic` 素材，不冒称真实公司样本、生产实物或真实员工照片。允许将相对仓库路径换成已获授权业务素材，脚本会重算 SHA。不要上传未经批准的员工照片或使用新的第三方平台。
- 最终设 `approvedForPaidExecution=true`。这只是执行护栏，不代替用户授权；脚本仍需显式 `--execute`。

当前示例 origin `http://127.0.0.1:13100` 是占位。`tools/dev-prod-like.mjs` 的默认 Worker 为 `TASK_MOCK_MODE=true`，不能当真实图片评测；现有 Demo 的管理接口关闭，不适合这组“同时比较指定旧/新版本”的测试。应由任务负责人准备正式隔离服务，不要为了本脚本开放生产管理权限或激活候选版本。

以下命令会付费，只有上述准备和授权已满足后执行：

```powershell
bun --no-env-file tools/prompt-chain-eval.ts run --execute --only garment-color:raw --limit 1
bun --no-env-file tools/prompt-chain-eval.ts run --execute
```

图片任务原状态查询至成功、失败、暂停或 20 分钟观察时限；不因超时重新生成。多进程可使用 `--only` 选择不同组，所有进程共享同一个 SQLite 总账，不需要手动清除进程锁。

## 唯一预算与恢复

预算固定为 `output/prompt-chain-optimization/evaluation/budget.sqlite`。不能由环境变量、`--config`、campaign/run ID 改变。SQLite `BEGIN IMMEDIATE`、WAL、`synchronous=FULL` 和数据库触发器同时实施总额度与分组额度；attempt 身份、requestId、输入指纹和占额不能被更新或删除。SQLite WAL/SHM 为数据库一部分，运行中备份用 SQLite 一致性备份，不直接复制主文件。

每次新尝试先持久化唯一 requestId、输入快照与 1 个名额，提交成功后才允许任何外部写入。成功、失败、不确定、上传/编译阶段异常、POST 前崩溃都不退名额。只允许创建该占额的进程提交一次；已存在的尝试永远 query-only，即使原任务查不到。恢复只发 GET，不上传素材、不编译、不发生成任务、不调用任务 resume 接口。

```powershell
bun --no-env-file tools/prompt-chain-eval.ts status
bun --no-env-file tools/prompt-chain-eval.ts recover
```

失败或不确定不自动重发。如果负责人已核对原任务并决定消耗预留额度复核，显式提供原尝试 key 与全新复核 key；新尝试仍占固定总账中的一个名额：

```powershell
bun --no-env-file tools/prompt-chain-eval.ts run --execute --retry-of prompt-chain-100:garment-color:raw:model-a --retry-key review-garment-01
```

不允许通过删除数据库、换工作区或复制空台账重置额度。这是本次任务的唯一预算，不是每个分支/设备各 100 张。数据库被丢失、损坏或外部调用绕过本工具时，应停止执行，先核对服务器原任务与已发生调用，不能重新初始化假装零次。

## 有用户明确授权时追加一个固定批次

没有新授权时，初始 100 张仍是上限。`run`、`status`、`recover` 不会自动安装追加预算结构，也不会选择下一个批次。即使用户授权继续迭代，操作者仍需明确每一批的 `single`、`sequence`、`reserve` 数量；脚本没有无限循环或自动补满功能。

先将用户已经给出的授权原话和可核查来源记录在私有 `output/` JSON 中。以下是格式示意，**不是已有用户授权，不可照抄作为真实授权**：

```json
{
  "version": 1,
  "authorizationId": "user-authorization-unique-id",
  "sourceReference": "实际用户消息的引用或记录位置",
  "authorizedAt": "2026-11-11T00:00:00Z",
  "userStatement": "替换为用户已明确给出的授权原话",
  "scope": "prompt-chain-evaluation",
  "allowAdditionalPaidBatches": true
}
```

字段必须完整且没有其他字段；时间使用 UTC ISO 格式。`authorizationId` 是不可变身份，不能用同一 ID 改写原话；同一授权允许追加多个明确批准的小批次，但每次仍需下面的完整命令。此命令只写预算证据，**不调用网络或模型**：

```powershell
bun --no-env-file tools/prompt-chain-eval.ts authorize-batch --authorization output/prompt-chain-optimization/authorization.json --batch-id iteration-01 --single 40 --sequence 0 --reserve 0 --approve-budget
```

该命令要求已有且已绑定账号/应用 origin 的唯一总账。一次事务只新增授权、批次、attempt 归属表及额度触发器；保留原 `budget`、`binding`、全部 `attempts` 和 `events`。回执包含原尝试/事件数、授权 SHA、历史前后 SHA；二者必须一致。重复相同命令幂等，不增加第二份额度；改动同名批次或授权内容会拒绝并回滚。

例如旧账本已占 96/100，追加 40 后就是“初始 96/100 + iteration-01 0/40”，累计已授权 140、已占 96。初始剩余 4 张不会转入新批，也不会由新批自动使用。失败、不确定和 POST 前崩溃仍永久占当前批名额。各批及各分组额度分别约束，多进程竞争仍在同一 SQLite 事务中计数。

给新批另存一份 `config-iteration-01.json`，不要修改历史配置。它的 `allocation` 必须与已批准分组额度完全相同；场景、原话、模型、素材与 API origin 等仍需完成前述核对。新增批次 ID 为 1–40 位字母/数字/下划线/连字符，不能使用保留名 `initial`。先离线检查，再显式执行：

```powershell
bun --no-env-file tools/prompt-chain-eval.ts plan --config output/prompt-chain-optimization/evaluation/config-iteration-01.json --batch-id iteration-01
bun --no-env-file tools/prompt-chain-eval.ts run --config output/prompt-chain-optimization/evaluation/config-iteration-01.json --batch-id iteration-01 --execute
bun --no-env-file tools/prompt-chain-eval.ts recover --config output/prompt-chain-optimization/evaluation/config-iteration-01.json --batch-id iteration-01
```

`plan` 只列计划，不代表预算已批准。`run` 先核对整组选中任务的剩余额度，再预检网络；真实并发最终仍由数据库触发器限额。新 key 统一为 `batch:iteration-01:<原任务key>`，连续改图的上一轮依赖同步加前缀，避免串到旧实验。`--only` 使用此前的子串过滤规则。新增批的 `--retry-key` 输入不带前缀的新 key，脚本自动加前缀；`--retry-of` 必须是账本中原 attempt 的完整 key，复核消耗当前批的 `reserve`。每次命令只处理指定批次，没有批次参数的 `run` 仍只使用 `initial`。

`recover --batch-id` 仅 GET 查询该批；不带批次参数的 `recover` 查询所有已有批次，但不会新建尝试或产生付费调用。`status` 报告包含 `initialImageLimit`、`authorizedImageLimit` 和每批分组的已占/剩余值；旧 `hardImageLimit` 现在表示累计已批准的实际总限额，不能只看历史 `allocation` 判断追加批次。

## 证据与结论

每个 attempt 保存原话、预期改/保留项、场景、策略与实际 `method`、模型身份、参数、指定配方版本、参考图来源/顺序/职责/SHA、真实执行提示词、原结果字节/SHA、状态、观察耗时及服务器开始/完成时间。输出图按原始字节保存，不重新编码；签名结果 URL、Cookie 和原始供应商响应不落盘。

`template-first` 可以回退到 `minimal`；报告记录实际 method，不能把回退样本计作纯模板。编译存在 `questions`、非成功状态、方法不符或身份不符时禁止出图。连续改图后续轮用上一轮已存结果，并校验 SHA；“回原图重做”的第三轮明确回到原源，不继承上一轮领口改色。

旧llm版本可能不存method。只有legacy分组、明确expectedExecutionStrategy=llm、配置中指定optimizerModelConfigId，且管理员详情核对配方版本/图片模型/优化模型全部一致、编译与请求ID一致、公开与管理结果均success且optimized=true时，才兼容归为llm并记methodEvidence=legacy-admin-details。template/minimal缺method仍阻止出图；未指定optimizer不能猜测。此兼容不补发已有失败尝试，复核须另用预留额度与新key。

`compilationApiAttempts` 是编译接口尝试次数，**不是 LLM 次数**。`confirmedPlanningModelCalls` 只统计证据确认的非缓存模型调用；模板/缓存命中不计，未知归入 `unknownPlanningCallCount`。历史字段 `planningAttempts` 与编译接口次数等义。规划实际/估算费用分别保留；图片 API 目前不暴露供应商账单，`imageCost.actual=null`，不能用应用配置扣费 `applicationChargeRmb` 代替。不同币种不合并，未知不能计零。

缓存依据管理详情的显式布尔cacheHit或合法reusedFromId（null表示原调用，UUID表示缓存源）；两者并存须一致，缺失/类型错误/矛盾则unknown。sourcePlanningCost保留详情中的源费用；明确缓存命中时本次planningCost.actual=0，不重复累计源调用，缓存证据未知则本次费用未知。

每次 `status`、`run` 或 `recover` 新建只读式 JSON 报告快照；API 成功不等于视觉通过，所有结果保持 `pending-manual-review`，必须逐图按改动/锁定项检查。当前工具不会自动给出胜率或通过结论。

## 候选 10 组（待负责人核准）

路径前缀均为 `docs/manual/prompt-optimization/testing/fixtures/`，均保留既有 `Synthetic` 来源说明：

| 输入 | 源文件 | 只改 | 保留/重点核验 |
|---|---|---|---|
| 整件指定改色 | shirt.png | 衣身鼠尾草绿 | 领、门襟、纽扣、袖口、纹理、白底 |
| 局部领口 | flat.png | 领口海军蓝 | 领型、胸袋、纽扣、其他颜色；非像素级承诺 |
| 款式线稿 | shirt.png | 白底黑线 | 可见结构；不补不可见暗袋/背面 |
| 花型提取 | knit.png | 平面白底提取 | 图形、数量、颜色、相对位置 |
| 花型改色 | knit.png | 砖红色块改深绿 | 其他配色、形状、数量、比例、排列 |
| 花型工艺 | flower.png | 平针刺绣 | 花瓣数量、轮廓、珊瑚色/黄色 |
| 定位印花 | shirt.png + flower.png | 左胸单花 | 图片分工、原服装结构/颜色 |
| 配色参考 | shirt.png + knit.png | 衣身取海军蓝 | 不带入几何图案与针织纹理 |
| 指定文字 | flat.png | 一行 SUMMER 2026 | 字符、胸袋、纽扣、衣身/背景 |
| 多图组合 | flower.png + leaf.png | 排布与刺绣效果 | 每图身份、可见数量、配色 |

`plan` 生成的 JSON 含每个源文件的完整相对路径、字节数和 SHA-256，可用于替换前后对照。
