# 批次部分受理中断恢复验证

结果：专项 7 项通过、0 失败、82 条断言；服务端 `tsc --noEmit` 退出码 0。代码已冻结，未执行提交、部署或付费模型调用。

## 实现与影响

- `server/src/batch-admission.ts`：新增持久受理状态、原始完整输入指纹、30 秒可续期租约和服务端令牌。只有持有有效令牌的受理者能继续写入任务；过期受理者即使尚无 GET 恢复请求，也会被拒绝。
- `server/src/routes/tasks.ts`：优化器仍在任务 SQL 事务之外运行一次。批次开始受理后，同编号同输入请求只读取现状；同编号不同输入返回 `409 / BATCH_REQUEST_CHANGED`。已存在的跨账号批次或任务编号在优化器之前被拒绝。
- `server/src/tasks.ts`：每项在原有任务及预扣事务内锁定批次并检查令牌，不额外占用一个长期连接，不把 LLM 请求放在事务中。关闭的批次把缺失项计为失败；实际已受理任务继续按其执行结果汇总，避免永久 pending。
- `server/src/migrations/043_prompt_recipes.sql`：为 `batch_tasks` 增加 `admission_input_hash`、`admission_status`、`admission_token`、`admission_lease_expires_at`、`admission_failures`。旧批次默认关闭，不重放历史任务。
- GET 按请求编号恢复：有效租约期间返回 `submissionComplete: false`；租约过期后持久关闭为 interrupted，缺失索引返回 `BATCH_SUBMISSION_INTERRUPTED`。GET 不调用 LLM、不补建图片任务、不重新预扣。
- Redis 入队在 SQL 提交后失败时，已存任务与预扣保留，并记录明确失败原因；批次 GET/POST 不重放入队，由既有 Worker 队列修复机制处理。

## 真实 SQL 专项覆盖

测试文件：`server/tests/integration/batch-admission-recovery.integration.test.ts`。使用真实 migrations、配方 store/compiler、任务路由、任务写入与积分预扣；提供商调用和队列使用可计数的离线替身。

1. 批次编号相同但第二项素材改变，明确 409，不能静默复用旧批次。
2. 4 个并发 HTTP 提交共享一次优化和一个批次；受理中可观察 `submissionComplete: false`，最终每项仅一条任务和一次预扣。
3. 首项任务及预扣提交后注入 SQL 连接故障，使原请求无法完成状态写入；移除故障、令租约过期并创建全新路由实例。GET 保留首项、明确另外两项中断，LLM/任务/预扣计数不增长。首项随后成功时批次变为 partial，不永久 processing。
4. 原受理者租约过期后尝试下一项，即使没有 GET 请求先关闭批次，仍被令牌检查拒绝。
5. 每项 SQL 成功后 Redis 投递失败：保留全部已受理任务和预扣；重复 POST/GET 不再次调用优化器或投递队列。
6. 并发额度不足产生明确、持久的逐项失败，失败项没有预扣；新路由仍返回原失败证据。
7. 旧批次缺少任务时返回终态中断；反复查询不会反复改写无变化的汇总时间。

```powershell
# 在 server/ 运行。
$env:PGLITE_RUNTIME_PATH = 'output/mark-admin-qa/runtime'
bun --no-env-file test tests/integration/batch-admission-recovery.integration.test.ts
bunx tsc --noEmit -p tsconfig.json
```

关联回归已运行 batch、prompt task admission、task admission SQL、credit policy SQL、tasks 单元及两个 Worker SQL 文件：34 项通过、14 项跳过、0 失败、436 条断言。跳过的 14 项 Worker SQL 用例需要 `QUEUE_TEST_REDIS_URL`，本次环境未提供，因此不计为通过。最终由主任务统一运行服务端全量与发布验收。

## 部署保护兼容

`output/prompt-optimization/deploy/recipe-state.ts` 的批次行指纹仅减去上述 5 个新增列；原有 `id`、账号、项目、模型、prompt、数量、状态、计数、时间等字段仍参与逐行摘要，整表行数也必须一致。任务指纹仅排除该功能新增的 3 个提示词列，其余业务表完整保留。

部署合同测试现为 6 项通过、0 失败、48 条断言。实际 SQL 验证同时改动 5 个新增批次列不会误报；改动原有批次 prompt 会拒绝；改动员工余额同样会拒绝。18 配方导入、重复导入保留管理员选择及原聊天绑定的断言仍通过。

## 验证边界

- 隔离数据库为 PGlite PostgreSQL；其测试 helper 串行化完整事务。已验证真实 SQL、HTTP 并发业务结果与持久恢复，但没有宣称验证独立 PostgreSQL 多连接锁竞争。
- 崩溃用可控 SQL 连接故障加新路由实例模拟；租约过期通过测试 SQL 推进，未执行真实 OS SIGKILL 或生产服务重启。
- 已存在的跨账号请求编号会便宜拒绝；两个账号同时首次提交同一编号、都尚未创建批次时，没有在 LLM 之前建立跨账号全局预占。各自通过优化后，唯一请求编号仍保证仅一个批次可准入，失败方不建任务、不预扣。
- 没有真实图片生成、对象存储读写、远程部署或线上数据库变更。
