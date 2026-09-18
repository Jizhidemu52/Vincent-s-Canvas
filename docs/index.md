# 无线画布文档导航

## 使用与部署

- [操作手册](manual/user-guide.md)：画布、创意设计、图片、视频、聊天、素材与后台。
- [部署导航](manual/installation-guide.md)：先区分 Windows OA、开发环境与完整服务器部署。
- [Windows / 局域网](../README-本地部署.md)：安装、配置、启动和更新。
- [Linux 服务器](manual/linux-deployment.md) · [宝塔离线包](manual/baota-offline-installation.md) · [生产验收](manual/production-deployment.md)。
- [当前待验收项](content/docs/progress/pending-test.mdx)：真实环境的缺口，不是历史测试流水账。

## 功能与参数

- [功能总览](content/docs/overview/features.mdx)。
- [画布操作](content/docs/canvas/canvas-node-manual.mdx) · [快捷键](content/docs/canvas/canvas-shortcuts.mdx)。
- [图片参数](manual/image-model-parameters.md) · [视频参数](manual/video-model-parameters.md) · [聊天参数](manual/chat-model-parameters.md)。模型协议资料供管理员维护；设计师端的图片模型使用匿名编号。
- [提示词模板](manual/prompt-template-guide.md) · [小组与模块](manual/groups-and-module-switches.md) · [共享额度](manual/group-shared-credit-pool.md) · [设计效能](manual/design-performance-dashboard.md)。

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

Windows OA 服务使用 `server/src/demo-server.ts` 与 SQLite，按员工隔离画布、素材和任务。正式 API 使用 `server/src/index.ts`，配合 Worker、PostgreSQL、Redis 和 S3/MinIO。

OA 画布是“本地缓存 + 员工云端文档”；非 OA 画布和独立聊天/创意页面的草稿仍是浏览器本地数据。云同步不是实时多人协作，也不替代导出与备份。

`server/.env`、`server/.data/`、`output/`、依赖及构建产物留在本机，不提交源码仓库。历史计划从 Git 历史查看，不再维护第二套当前说明。
