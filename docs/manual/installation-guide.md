# 部署导航

先选运行模式，再按对应手册操作；不要混用登录入口和存储说明。

| 场景 | 唯一操作入口 | 登录与数据 |
| --- | --- | --- |
| Windows 本机试用 / OA 试点 | [本地部署说明](../../README-本地部署.md)，默认 `Start-LAN.bat` 试用，企业试点选 `Start-LAN.ps1 -CompanyOa` | 试用画布在浏览器；企业 OA 模式按员工保存画布原图至 SQLite，不能将试用当正式企业环境 |
| Linux 完整部署 | [Linux 部署](linux-deployment.md)，完成后按 [生产验收](production-deployment.md) 核对 | 根目录模板使用企业 OA 模式；API + Worker + PostgreSQL + Redis + S3/MinIO，画布与媒体按员工归属 |
| 宝塔离线安装 | [完整离线镜像包](baota-offline-installation.md) | 与完整部署使用同一业务后端；避免在目标服务器在线构建 |
| 本地开发 | [开发说明](../content/docs/backend/local-development.mdx) | Vite 前端与正式 API 或隔离演示 API 分开运行 |
| 既有 CentOS 7.6 环境 | [环境专用说明](centos7-installation.md) | 仅供维护既有环境，不是另一个产品版本 |

公司使用者从“企业微信 → 公司 OA → 画布”进入，复用 OA 身份，不新增扫码或密码步骤，也无需安装源码或填写模型 Key。`OA_LOGIN_ENABLED=true` 时缺失/失效身份不回退访客；`false` 才是免登录试用。正式入口及公司网络限制见 [公司 OA 接入](oa-workspace-integration.md)。

## 首次安装

Windows 需要 Git、Bun 和可用的 Node.js；版本要求及模型配置见对应手册。Linux 完整部署需要 Docker Compose、持久磁盘和备份位置。真实生成可能产生供应商费用，代码仓库不包含模型额度。

- Windows 服务端凭据填写在 `server/.env`，已有文件不要覆盖。
- 完整部署从根目录 `.env.example` 创建配置；Provider Key 由管理员在后台维护，服务器加密保存。
- 模型密钥和敏感管理操作仍受保护，所有生成仍消耗服务端模型额度。正式企业网页、API、媒体及后端端口须由 IT 限制公司网络访问；网络位置、IP 和真实员工联调尚待确认。
- 设计师图片模型显示“出图模型1、2…”，管理员保留真实模型映射。

## 更新与备份

1. 保存草稿，等待进行中的任务结束，记录结果不明任务的 ID。
2. 备份实际配置与数据。SQLite 停服后复制整个数据目录；正式服务同时备份 PostgreSQL、对象文件和加密密钥。
3. 按所选部署手册拉取代码、安装依赖、构建、执行迁移并重启。只刷新网页不能更新后端；重复运行 `Start-LAN.bat` 不会替换正在运行的旧服务。
4. 检查 `/api/health`、`/api/deployment` 与所选模式：企业模式从 OA 进入并核验本人画布、原图及员工隔离；试用模式直接进入。遇本地 Git 改动不要强制覆盖。

企业画布换设备前确认已同步，同一员工可从 OA 恢复；试用画布、未同步内容、独立聊天及创意草稿另行导出保存。旧员工或共用数据不自动迁入当前员工或访客。GitHub 只保存源码，不保存用户作品和私密配置。

上线前仍需完成的真实链路见 [待验收项](../content/docs/progress/pending-test.mdx)；自动化测试通过不等于公司服务器或每个供应商模式已经验收。
