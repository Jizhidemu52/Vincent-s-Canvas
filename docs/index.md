# 无线画布文档索引

## 项目介绍

- [快速开始](/docs/overview/quick-start)
- [功能介绍](/docs/overview/features)
- [Docker 部署](/docs/overview/docker)
- [生产部署与验收](manual/production-deployment.md)

## 操作手册

- [完整新手操作手册](manual/operation-manual.md)
- [第一阶段验收矩阵](manual/phase-one-acceptance.md)
- [画布节点操作手册](/docs/canvas/canvas-node-manual)
- [画布快捷键](/docs/canvas/canvas-shortcuts)

## 开发与数据

- [本地开发](/docs/backend/local-development)
- [画布数据结构](/docs/backend/canvas-data-structure)

## 当前架构

- 账号、部门、项目、任务、额度账本、历史和审计以 PostgreSQL 为业务数据源。
- Redis 保存 Session、限流状态和任务队列；Worker 统一调用图片、视频、音频及工作流 Provider。
- Provider API Key 只在管理员端提交并由服务端加密保存，设计师浏览器不保存外部模型密钥。
- 素材元数据写入 PostgreSQL，文件写入 S3/MinIO；设计师之间按稳定用户 UUID 隔离。
- 画布仍保留本地草稿缓存，正式生成结果与上传素材会同步到服务端素材库。

## 安全

- [漏洞提交](/docs/support/security)

## 项目进度

- [更新日志](/docs/progress/changelog)
- [待测试](/docs/progress/pending-test)
- [TODO](/docs/progress/todo)
