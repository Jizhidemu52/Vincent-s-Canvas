# 提示词优化：非聊天前端交接

## 实现范围

- 9 个创意场景提交 `PromptInputData`：只含用户字段、当前有效控件、参考图职责与顺序。移除前端 `buildScenePrompt`、选区硬编码长提示词等写作规则；预览显示原始字段，生成记录显示服务端最终提示词。
- 系列配方提交完整表单、候选索引、图案参考角色；保留原有运行、暂停、失败重试和表单导出。
- 内置画布模板仍为每个模板 3 个并行节点，没有改变图结构；节点携带公开结构化字段。
- 串行工作流提供 `white_bg / recolor / on_model / detail_shot / scene / custom` 六类步骤，沿用已有连线与逐步执行逻辑。
- 图像工作台、画布快捷生成、普通配置节点提供可选“一键优化提示词”。不点按钮不优化；优化后文字可编辑。相同输入/参考图时带 `compilationId`，缓存验证由服务端执行。
- 批量改图优化开关默认关闭；启用时只发一个公共 `batch-optimize` 输入；每张图片仍独立生成一张。
- 图片反推提示词改为真实 `reverse-prompt` 编译调用，输出文字节点。原请求状态不明时只查询原 `requestId`，不创建第二次调用。
- 任务历史与结果保存 `userInput`、最终 `prompt`、`optimized`。归档不再保存系统提示词内容；参考图字节/顺序与 mask 最后位置保持原流程。
- `image.ts` 为聊天 Agent 接入 `chatProfile` / `profileContext`，指定 profile 时不再发送浏览器系统消息。

## 异常与隔离

- 优化接口只 POST 一次；丢失回应后按原 request ID 查询。失败/不确定不会静默编造提示词或重新提交。
- 图像任务、批次在未知 POST 结果时查询原 task/compilation/batch，不重放 POST。
- 优化晚到时，输入文字、模型、参考图或员工已变化不会覆盖当前内容。
- 批次上传后、POST 前持久化每个结果节点的 request ID；明确拒绝释放绑定，不确定保留绑定并提示待查询。
- 创意场景在 POST 前持久化同一历史记录、原请求编号、用户字段、实际已冻结提交参考图；刷新后恢复待查记录。查询只 GET；若已优化但没有图片任务，必须点击继续按钮，重新查询后仍用原 requestId + compilationId 幂等续交。迟到的原任务会直接恢复，不另建第二张。相同未结束输入不能创建新请求，修改输入后才创建新 ID；失败单张重试也先落盘。
- 仅服务端明确 `optimized: false` 时显示回退状态，前端没有自带回退写作规则。

## 已执行验证

- `web`: `bunx tsc --noEmit --pretty false` 通过。
- 最终定向合并回归：25 文件，237 测试，1233 断言，0 失败（含刷新恢复与历史测试）。
- 后续追加优化中 409 与部分批次恢复两项测试；对应结构化生成文件 7 项全过。主 Agent 的全量集成回归另行统计，不与此定向数字混算。
- 新增 `prompt-compilations.test.ts`（5）、`prompt-structured-generation.test.ts`（5）、`prompt-optimize-button.test.tsx`（4）；增加批次明确拒绝/不确定绑定测试。
- 已覆盖原请求查询、仅一次提交、结构化输入与 mask 顺序、批次一次编译、模板并行图、6 种工作流类型、旧结果不覆盖与员工隔离。
- `creative-scene-recovery.test.ts` 执行真实 hook 闭包，覆盖提交前落盘、刷新不提交、输入变更新 ID、相同 ID 显式续交、迟到原任务复用、未知状态及员工切换。
- 修改范围的 whitespace 检查通过；其他 Agent 的 `canvas-assistant-image-edit.test.ts` EOF 已单独提醒其修复。
- 本子任务没有真实浏览器端到端点击，也没有付费模型调用；不能把这些单元/类型结果当作视觉质量验收。

## 集成边界与仍需检查

1. 根 Agent 实现并验证 `/api/prompt-compilations`、`/api/tasks`、`/api/tasks/batch`、`/api/tasks/batches/by-request/:requestId`。前端接受普通编译结果或 `{code,data,msg}` 编译包裹；任务 API 延续现有任务结构。
2. 局部改款保留原项目“主图 + 蓝色选区示意图 + 本地合成”链路，发送 `fields.selectionGuide=true`，不把蓝色示意图伪称 provider mask。独立真实 mask 仍最后上传并带 `maskReferenceIndex`。
3. 创意刷新恢复现已实现。继续按钮沿用原 task requestId；服务端必须保证先查既有任务，再复用 compilation，并以唯一约束幂等 enqueue，防止旧 POST 与显式续交的并发竞态。根 Agent 已确认此约定。
4. 配置节点连线/模型或参考图在优化后变化时，服务端必须按实际模型/字节/顺序验证 `compilationId`，不得复用错图缓存。
5. 运行真实 QA 时核对所有入口的最终 prompt 复制/导出、优化状态、失败回退标识；不要仅依赖页面文案或 HTTP 成功。
6. 已修复反推入口的操作合同：有参考图时 `reverse-prompt` 使用 `mode=edit` 搭配 `canvas-edit`，避免 `generate` 被映射到工具不支持的 `image_generation`。语言仍按配方默认英文 prompt / 中文摘要，未强制中文 prompt。

## 付费 QA 脚本交接

- `server/scripts/prompt-quality-matrix.ts` 与 `prompt-quality-cases.ts` 已交付，使用正式公开 API；默认 dry-run，没有我方真实付费调用。
- 224 条业务记录：180 条旧新对照、44 条其他流程；执行时补其他启用图像模型协议烟测。
- 6 个 mock API 测试、259 个断言全过，脚本独立 TypeScript 检查通过，反推修复后的 web TypeScript 检查通过。
- 逐请求 ledger 在付费 POST 前落盘，未知只查询；原始图片按真实 MIME 存储，费用缺失记 null，全部视觉结果待人工核对。
- 执行参数、素材依赖与局限见 `server/scripts/README.prompt-quality.md`。9 个场景选项按真实 UI 枚举对齐；两项 72px 辅料只作低质压力样本，其余使用 1024px 已查看素材。

没有 Git 提交或发布。报告位于忽略的 `output/`，不含凭据或私有配方。
