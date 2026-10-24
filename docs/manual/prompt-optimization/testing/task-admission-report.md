# 提示词优化与任务准入集成验证

新增测试：`server/tests/integration/prompt-task-admission.integration.test.ts`。

结果：9 项通过、0 失败、157 条断言；服务端 `tsc --noEmit` 退出码 0。

```powershell
# 在 server/ 目录，先确认该隔离测试依赖目录存在。
$env:PGLITE_RUNTIME_PATH = 'output/mark-admin-qa/runtime'
bun --no-env-file test tests/integration/prompt-task-admission.integration.test.ts
bunx tsc --noEmit -p tsconfig.json
```

## 实际验证

- 应用真实 migrations，在一次性 PGlite PostgreSQL 中使用 `postgresPromptRecipeStore`；运行真实 `PromptCompiler`、任务路由、公开编译路由、超级管理员配方路由、模型/板块 SQL 解析、积分预扣与审计 SQL。
- 成功时入库的是服务端编译后提示词，不是浏览器伪造的最终提示词；原始结构化用户输入、编译 ID、优化标志及任务查询返回保持一致；配方独立优化模型不采用全局聊天绑定。
- 优化器传输结果不确定、无效 JSON、包含私有规则的输出均拒绝任务准入：没有任务、没有积分预扣、余额不变。传输异常保留 `uncertain` / `PROMPT_SUBMISSION_UNCERTAIN`，GET 可恢复该状态；重复 POST 不再调用优化器，不新建任务或预扣。已知无效输出与规则泄漏保留 `failed`。
- 必须优化的创意场景缺少 `promptInput` 时，在优化器和积分预扣之前拒绝。
- 4 个同请求编号的并发 HTTP 提交，只执行 1 次优化、落 1 个编译记录、1 个任务和1 次预扣，返回相同任务 ID。
- 2 项批量只读取首项代表参考图并编译 1 次；各任务保留各自素材，共用可信提示词与编译 ID。GET 按请求编号恢复原批次；重复 POST 不再编译、不重复建任务或预扣；另一账号无法读取原批次。
- 公开优化响应只含允许字段；不返回规则、原始模型响应、输入快照、内部模型或员工标识。另一账号不能查询原编译；设计师与部门管理员不能读取配方和管理员原始记录。
- 管理员保存草稿不会激活或调用模型；可显式测试未激活版本并临时选择优化模型；激活、旧版回滚与真实审计写入均成功。
- 板块绑定图片模型 A 时，超管显式测试已保存版本可临时选择启用且能力兼容的图片模型 B；同一超管携带自己的 `adminTest` 编译记录出图时真实任务入库为 B，直接复用已测试提示词、不再调用优化器，且板块绑定仍为 A。
- 普通用户、另一超管、没有编译记录的超管，以及只持有普通公开优化记录的超管，都不能借此覆盖板块模型；普通用户即使改回 A 也不能使用他人的编译 ID。
- B 被停用后，新的测试和已测试记录的任务准入都被拒绝；选择仅有 chat 能力的目标模型同样拒绝，均不产生优化器调用、任务或预扣。
- 成本统计保留 USD 币种，实记与估算分开。

## 验证边界

- 优化器是内存替身，没有网络提供商、付费调用或 Worker。参考素材字节也是测试适配器，不表示已验收对象存储、图像解码或真实素材 ACL。
- HTTP 身份中间件由 fixture 提供，角色授权和业务路由是真实实现；不代表 OA / Cookie 认证流程已验收。
- PGlite helper 串行化完整事务；本测试验证并发请求的业务防重结果，不宣称验证了真实多连接 PostgreSQL 锁争用。
- 未修改服务端核心或其他测试。最初的夹具失败涉及部门必填字段与类型约束；服务端新增 `uncertain` 契约后，旧的传输异常 `422 / failed` 预期曾失败，已按现行 `409 / uncertain` 契约更新并增加防重证据。
- 目标模型经过真实 SQL 板块/模型解析；测试适配器按生产 runtime 相同的 `super_admin && adminTest` 条件传递内部 `allowModelOverride`，没有开放请求体绕过开关。
