# 发布证据与代码安全独立只读核验

## 结论

此前发现的两项 P2 守门缺口已由根任务修复，本次独立复核通过，状态均为**已关闭**。第一轮实际 `testing/` 导出已核验：324 个 manifest 文件全部大小与 SHA-256 匹配，无缺项或额外文件，未发现实际凭据、员工私有身份字段或运行时数据库文件。当前 `web/src` 与 `shared` 的既有扫描未发现迁移到服务端的长系统规则正文。

此结论覆盖下面标明的实际导出快照，不替代随后补充扩展 review 的最终再次导出、新 `release-web/` 和最终归档核验。

用户已明确允许原始配方文档全文公开，因此文件名中的“机密”不作为禁止发布依据。管理员后续新版本、凭据、员工私有数据和运行时数据库仍不得经普通设计师接口、缓存或证据导出分发。

本次仅阅读代码/现有文件并执行无网络、无付费的合成检查；没有运行导出器、打包、构建、SSH、Docker、部署、提交或修改产品文件。

## 第一轮实际导出检查

- 核验 `docs/manual/prompt-optimization/testing/evidence-manifest.json`，其 `exportedAt` 为 `2026-10-24T18:16:29.882Z`。共 **324 个载荷文件、335,070,693 字节**；连同 manifest 本身，实际目录共 325 个文件。逐文件重新计算大小与 SHA-256，全部匹配；目录没有缺项或未列入 manifest 的额外文件。
- 扫描实际目录中 31 个 JSON/Markdown/HTML 文本文件。一个 ZIP 含 3 项、展开合计 1,012,097 字节，已限额解包到内存检查 JSON、敏感字段和成员扩展名；与 `output/` 原始 ZIP 字节完全一致，没有改写压缩包或图片。
- 未命中 `sk-`/`sess-`、私钥头、长 Bearer [REDACTED] URL，或非空的 JSON API key/cookie/password/token 字段；未命中 email/phone/mobile/employeeId/staffId/wecomUserId/oaUserId 等敏感身份字段。
- 实际导出目录没有 `.env`、`.pem`、`.key`、`.sqlite`、`.sqlite3`、`.db`、`.dump`、`.backup`、`.bak` 等运行时文件。此前 Git 跟踪集的同类检查仅发现 3 份 `.env.example`。
- `call-accounting.json` 仍明确 `actualProviderInvoiceVerified=false`，图片和聊天实际费用均为 `null`，没有把未知费用变成零。
- 图片内容主要沿用已人工查看的合成服装素材、测试截图；本次没有对全部图片做 OCR，启发式扫描不能证明任意形式的秘密绝不存在。

## 守门修正复核：两项 P2 均已关闭

### 已关闭：带引号的 JSON 凭据字段脱敏

位置：`server/scripts/export-prompt-quality-evidence.ts` 的 `redactEvidenceJson()` 和 `publish()`。

初审发现的是纯文本正则不理解 quoted JSON；当前导出器已经先解析 JSON，递归处理对象与数组中的识别凭据字段，再执行文本清理和发布。因此该问题不再依赖原正则修复。

独立调用当前真实 `redactEvidenceJson()` 验证：嵌套数组中的 `apiKey`、`cookie`、`authorization`、`credentials` 合成值全部改为 `[REDACTED]`；空字符串和 `null` 保留，正常已授权文本不变。当前实际导出文本扫描也没有发现非空凭据字段。状态：**修复已验证，关闭**。

### 已关闭：ZIP 内部检查与运行时文件名拒绝

位置：`server/scripts/export-prompt-quality-evidence.ts` 的 ZIP 分支、`scripts/deploy-prompt-release/package.mjs:33`。

- ZIP 现在使用现有 `fflate`，在展开前累计成员 `originalSize`，超过 100,000,000 字节即拒绝；逐项只允许 JSON、图片或目录。JSON 使用拒绝模式检查识别凭据字段及画布私有规则字段，检查通过后才复制原始 ZIP 字节。
- 独立验证嵌套 ZIP JSON 检查逻辑：非空 `apiKey`、`cookie`、`systemPrompt`、`rawResponse` 四种合成字段全部抛错；实际导出 ZIP 通过同一真实校验函数，原件字节未变。
- 独立调用当前 `assertPublicPackage()`：`.env`、`.sqlite`、`.sqlite-wal`、`.sqlite3`、`.db`、`.db-wal`、`.db-shm`、`.backup`、`.bak` 9 种合成路径全部被拒绝。数据库扩展名和附属文件缺口已补齐。

状态：**修复已验证，关闭**。这些检查仍是明确字段、扩展名和当前材料的防护，不宣称能识别任意伪装秘密；通用 JSON 文件不能只按文件名判定安全，最终产物内容扫描仍保留。初审未发现实际泄漏，本次也没有发现新增实际泄漏；复核人员未自行改动产品脚本。

## 前端规则与管理员隔离

从 `server/src/prompt-chat-profiles.ts` 和 `server/src/prompt-compiler.ts` 抽取 43 段至少 80 字符的字符串，精确扫描 `web/src`、`shared`、现存 `web/dist` 共 1,472 个文本文件：

| 范围 | 结果 |
| --- | --- |
| 当前 `web/src`、`shared` | 无规则长字符串命中；公共共享文件仅含类型、校验与场景词汇 |
| 现存旧 `web/dist` | 两个旧 JS chunk 命中大量历史系统规则；文件时间为 2026-10-24 23:52，与当前源代码扫描结论不同 |
| 最终新 `release-web` | 尚未生成，本次没有替代最终产物检查 |

旧 chunk 为 `canvas-assistant-panel-D1epe8Uk.js` 和 `index-CSfC2TKc.js`。`Dockerfile.web` 明确保留旧指纹资源以兼容在途旧页面；根任务已说明历史已公开模板不承诺收回，且本轮不删除这些兼容资源。因此这是**已知历史公开残留，不认定为本次新增泄漏**。仍须验证本次新 bundle 不再嵌入服务端规则或管理员新版本。

当前源码的普通编译响应经 `publicPromptCompilation()` 显式白名单输出；按请求查询带当前用户 ID。管理员路由先检查 `super_admin`，普通/管理员响应均设置 `Cache-Control: no-store`。管理员客户端同样使用 `cache: no-store`，绑定 owner、身份变化即中止并在响应解码后复核；页面按 owner 重建，仅使用内存状态。所审查管理员目录与请求文件未使用 localStorage、localforage 或持久化缓存保存配方正文。

相关依据：`server/src/routes/prompt-recipes.ts:12`、`:18`、`:28`，`server/src/prompt-recipe-store.ts:166`，`web/src/services/api/admin-prompt-recipes.ts:22`、`:31`，`web/src/pages/admin/prompt-recipes/index.tsx:13`。既有针对性测试覆盖普通/部门管理员拒绝、公共字段白名单、跨 owner、no-store 和身份 ABA；本轮是代码核验，未重新执行整套运行测试。

## 发布脚本边界

`package.mjs` 从干净且固定的最终 Git HEAD 归档，在独立目录 frozen-lockfile 安装与新构建，清除构建环境 `VITE_*` / `CANVAS_*`、拒绝 standalone，并核对源码、HEAD、工作区及多层 SHA-256；它不会直接使用当前旧 `web/dist`。

`prepare.sh` / `cutover.sh` 限定发布路径和应用容器，`umask 077` 保存配置/数据库备份，不把运行时备份纳入公共证据。导入前排空任务，迁移与导入后检查非配方业务表及原配方版本/历史；回滚只恢复应用，不自动恢复数据库或删除历史。原文进入 API 镜像专用目录，不复制至新 Web 静态目录。

这些是当前脚本的静态核验结果，不表示已在远端运行成功。导出器只从专用 QA 数据库只读提取计量字段，不复制数据库文件；实际费用保持未知值 `null`，未把 Demo 零积分解释成提供商免费。

## 最终交接

第一轮实际导出已完成独立文件完整性与敏感内容检查，两个守门缺口已关闭。根任务补入扩展 review 并再次导出后，应刷新最终 manifest 检查，再核对新构建及最终归档；原图 SHA-256、负面证据和费用未知状态继续保留。

本报告只更新在 `output/prompt-optimization/publication-audit-report.md`，第一轮已导出目录中的旧报告副本未手动改写，以免破坏已验证 manifest；根任务最后再导出时会纳入本修订版。无需为这次复核再做真实 UI、付费调用或构建。
