# 提示词配方管理端验证报告

## 交付范围

- 新页面 `/admin/prompt-recipes`，管理中心仅超级管理员显示入口；页面与 API 客户端再次校验 `super_admin`、有效身份与 `active` 状态。
- 运行设置：名称、启停、配方独立优化模型绑定、停止 / 回退策略。不会借用聊天模块的全局模型；回退策略须有已保存的非空回退提示词。
- 版本管理：编辑系统提示词、字段模板、模型覆盖规则、回退提示词、输出语言和说明；保存只创建新版本草稿，显式激活才改变线上版本；选择旧版本并激活即回滚。
- 逐字段双栏版本对比，完整显示对照文本与当前编辑文本；标记差异，切换时提醒未保存修改。
- 测试台：版本、只读场景标识、字段 JSON、用户要求、参考图分工、生成 / 编辑模式、目标图像模型和临时优化模型。场景固定为当前配方，最多 8 张参考图；上传保留原文件字节，优化与实际出图分别触发。
- 实际出图使用正常 `/api/tasks` 路线，携带成功编译的 `compilationId` 和冻结输入；`generate` 对应 `image_generation/image`，`edit` 对应 `inpaint/image-edit`。每条测试结果最多显式提交一次出图，数量固定为 1。
- 支持同时对比两次测试的提示词、说明、诊断和图片；最近 20 条服务端优化记录可另外选两条比较。
- 统计按 `costs[].currency` 分组展示实记、估算、未知，不合并币种或将实记与估算相加。记录保留未报告 Token / 成本为未知。
- 状态不确定时保留请求编号，只查询原请求 / 原任务；不自动重试 POST。切换身份或离开页面会停止本地查询，不取消已提交任务。
- 配方正文、版本、原始响应与当前测试结果仅存于本页内存；没有新增浏览器业务缓存。

## 验证结果

在 `web/` 目录运行：

```powershell
bun test tests/admin-prompt-recipes-client.test.ts tests/admin-prompt-recipes-model.test.ts
bunx tsc --noEmit -p tsconfig.json
bunx playwright test --config e2e/admin-prompt-recipes.config.ts
```

- 单元测试：8 通过、0 失败，49 条断言。
- TypeScript：退出码 0。
- 隔离浏览器：8 条流程通过；独立端口 `5211`，所有 API、WebSocket 和非本地请求均被测试接管，没有真实提供商请求。
- 出图同步防重锁补充后，针对上传 / 冻结快照与不确定出图恢复的 2 条浏览器流程再次通过。
- 对齐真实编译器契约后，新增 1 条浏览器验证通过：场景只读、最多保留 8 张参考图，选择第 9 张会提示且不触发上传或模型请求。该检查单独输出至 `admin-e2e/contract-check/`，原 8 条流程截图保留。

浏览器覆盖：

1. JSON 错误阻止保存；保存草稿不激活；激活、回滚、模型独立绑定、缺少回退文本时拒绝回退策略。
2. 无效字段阻止上传 / 优化；参考图上传字节一致；仅优化不创建任务；修改表单后，先前测试的出图仍使用原始快照；一次图像任务，`count=1`。
3. 优化 POST 断连后，只有一次 POST，按原请求 GET 查询，`uncertain` 不允许出图。
4. 出图 POST 断连后按原请求 GET 找回原任务，不创建第二个任务。
5. 部门管理员不能读取私有配方 API。
6. 设计师不能读取私有配方 API。
7. 权限变化后移除配方正文；不再请求管理数据；没有配方文本进入 `localStorage`。API 单测另覆盖 A→B→A 会话变化和读取响应体期间身份变化。
8. 通过应用主题按钮切换真实深色主题，390px 窄屏无页面或主内容水平溢出，编辑控件可达。

保留截图位于 `output/prompt-optimization/admin-e2e/test-results/`：`version-diff.png`、`test-with-reference-and-image.png`、`editor-dark-390.png`。内容均为隔离测试样本，不含真实员工、密钥或配方原文。

## 边界与未覆盖项

- 本报告证明管理端交互、请求载荷与边界行为；模拟浏览器成功不等于正式服务、真实模型的协议和视觉验收成功。真实任务路由与隔离 PostgreSQL 的独立验证见 `task-admission-report.md`；真实 Worker / 提供商另行验收。
- 没有运行付费模型、提交 Git、部署或更改线上配方。模拟金额不是实际账单。
- 本页本轮不提供蒙版上传，测试输入明确 `hasMask=false`；普通参考图编辑受目标模型能力和参考图上限约束。
- 当前页面的测试对比和图像预览不跨刷新保留；优化历史与正常任务由服务端保存。离开页面不会撤销服务端任务。
- 主题沿用项目统一配置，没有独立深色分支。Ant Design 6 的组件使用参考了[官方组件文档](https://ant.design/llms-full.txt)。

## 文件边界

运行代码仅新增 `web/src/pages/admin/prompt-recipes/**`、`web/src/services/api/admin-prompt-recipes.ts`；`web/src/router.tsx` 增加 2 行，`web/src/pages/admin/index.tsx` 增加 1 行入口。其余新增为此管理端专用单测和隔离浏览器测试配置；没有修改非管理创作流程或服务端实现。
