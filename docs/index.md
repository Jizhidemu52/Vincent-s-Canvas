# 无线画布文档导航

## 使用与部署

- [操作手册](manual/user-guide.md)：画布、创意设计、图片、视频、聊天、素材与后台。
- [部署导航](manual/installation-guide.md)：区分本机试用、企业 OA 和完整服务器部署。
- [公司 OA 接入](manual/oa-workspace-integration.md)：企业微信 → 公司 OA → 画布，身份、云端保存与 IT 网络交接。
- [Windows / 局域网](../README-本地部署.md)：安装、配置、启动和更新。
- [Linux 服务器](manual/linux-deployment.md) · [宝塔离线包](manual/baota-offline-installation.md) · [生产验收](manual/production-deployment.md)。
- [当前待验收项](content/docs/progress/pending-test.mdx)：真实环境的缺口，不是历史测试流水账。

## 功能与参数

- [功能总览](content/docs/overview/features.mdx)。
- [画布操作](content/docs/canvas/canvas-node-manual.mdx) · [快捷键](content/docs/canvas/canvas-shortcuts.mdx)。
- [图片参数](manual/image-model-parameters.md) · [视频参数](manual/video-model-parameters.md) · [聊天参数](manual/chat-model-parameters.md)。模型协议资料供管理员维护；设计师端的图片模型使用匿名编号。
- [提示词模板](manual/prompt-template-guide.md)。历史公司管理参考：[小组与模块](manual/groups-and-module-switches.md) · [共享额度](manual/group-shared-credit-pool.md) · [设计效能](manual/design-performance-dashboard.md)；不是当前创作的前置步骤。

## 开发入口

| 目录 | 职责 |
| --- | --- |
| `web/src/` | React / Vite 前端；页面、画布、状态与 API 客户端 |
| `server/src/` | Bun / TypeScript API、Worker、Provider 适配与数据库迁移 |
| `web/tests/`、`server/tests/` | 自动化测试 |
| `ops/` | 部署预检、离线包、备份恢复与压测 |
| `docs/manual/` | 用户与运维手册 |
| `docs/content/docs/` | 功能、数据结构、开发与验收说明 |

- [本地开发](content/docs/backend/local-development.mdx)。
- [画布数据结构](content/docs/backend/canvas-data-structure.mdx) · [数据库与迁移](content/docs/backend/backend-database.mdx)。
- [安全问题](content/docs/support/security.mdx) · [版本记录](../CHANGELOG.md)。

## 当前架构边界

`OA_LOGIN_ENABLED=true` 为企业模式：从公司 OA 复用员工身份，不新增扫码或密码步骤；画布、原图与生成记录按员工归属。`false` 保留本机免登录试用，Windows 使用共用身份，完整后端使用浏览器访客会话。Windows 的 `demo-server.ts` 使用 SQLite；正式 `index.ts` 配合 Worker、PostgreSQL、Redis 和 S3/MinIO。两种模式都关闭内部积分和角色入口，模型 Key 与敏感维护保持受保护。

企业画布使用员工分区的本地缓存和云端文档/媒体；确认已同步后可由本人从 OA 恢复。独立聊天和创意草稿仍为员工分区的浏览器数据，不是全部云同步。试用画布通过 localforage / IndexedDB 保存在同一浏览器、同一地址，换设备或清理前导出。旧账号与共用数据不自动迁移、合并或公开。

正式公司网络限制覆盖网页、API、媒体和直接后端端口；服务器位置及公司出口 IP 尚待 IT 确认并配置。真实 OA 员工、目标服务器及公司外网拒绝访问尚未验收，不以本机或自动化测试通过代替。

`server/.env`、`server/.data/`、`output/`、依赖及构建产物留在本机，不提交源码仓库。历史计划从 Git 历史查看，不再维护第二套当前说明。
