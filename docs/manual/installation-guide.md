# 部署导航

先选运行模式，再按对应手册操作；不要混用登录入口和存储说明。

| 场景 | 唯一操作入口 | 登录与数据 |
| --- | --- | --- |
| Windows 局域网 OA | [本地部署说明](../../README-本地部署.md)，使用 `Build-LAN.bat` / `Start-LAN.bat` | OA Token 自动登录；员工画布、素材与任务保存在服务器 SQLite |
| Linux 完整部署 | [Linux 部署](linux-deployment.md)，完成后按 [生产验收](production-deployment.md) 核对 | API + Worker + PostgreSQL + Redis + S3/MinIO；按实际配置启用 OA 或账号体系 |
| 宝塔离线安装 | [完整离线镜像包](baota-offline-installation.md) | 与完整部署使用同一业务后端；避免在目标服务器在线构建 |
| 本地开发 | [开发说明](../content/docs/backend/local-development.mdx) | Vite 前端与正式 API 或隔离演示 API 分开运行 |
| 既有 CentOS 7.6 环境 | [环境专用说明](centos7-installation.md) | 仅供维护既有环境，不是另一个产品版本 |

已部署的设计师直接从公司 OA 或管理员提供的入口使用，不需要在每台电脑安装源码或填写模型 Key。

## 首次安装

Windows 需要 Git、Bun 和可用的 Node.js；版本要求及模型配置见对应手册。Linux 完整部署需要 Docker Compose、持久磁盘和备份位置。真实生成可能产生供应商费用，代码仓库不包含模型额度。

- Windows 服务端凭据填写在 `server/.env`，已有文件不要覆盖。
- 完整部署从根目录 `.env.example` 创建配置；Provider Key 由管理员在后台维护，服务器加密保存。
- OA 模式关闭密码、扫码和管理员登录入口。需要非 OA 管理后台时按该部署的账号体系进入，不要借用员工 Token。
- 设计师图片模型显示“出图模型1、2…”，管理员保留真实模型映射。

## 更新与备份

1. 保存草稿，等待进行中的任务结束，记录结果不明任务的 ID。
2. 备份实际配置与数据。SQLite 停服后复制整个数据目录；正式服务同时备份 PostgreSQL、对象文件和加密密钥。
3. 按所选部署手册拉取代码、安装依赖、构建、执行迁移并重启。只刷新网页不能更新后端；重复运行 `Start-LAN.bat` 不会替换正在运行的旧服务。
4. 检查 `/api/health`、`/api/deployment`、登录、原素材与画布，再恢复使用。遇本地 Git 改动不要强制覆盖。

OA 员工换设备前确认画布“已同步”；非 OA、本地草稿和独立聊天仍需导出。旧共用画布不自动归属新员工。GitHub 只保存源码，不保存用户作品和私密配置。

上线前仍需完成的真实链路见 [待验收项](../content/docs/progress/pending-test.mdx)；自动化测试通过不等于公司服务器、OA 或每个供应商模式已经验收。
