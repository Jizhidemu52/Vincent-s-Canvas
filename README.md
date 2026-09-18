# 无线画布

面向设计团队的 AI 创作工作台：用一张画布整理参考图、生成图片、反复改稿和保存成果。

## 能做什么

- **画布创作**：多图参考、节点与连线、图片编辑、导入导出；企业 OA 模式按员工保存画布与原图到服务器，本机试用保存在浏览器。
- **创意设计**：款生线稿、花型提取、改款、配色、辅料等九个工作台。
- **图片 / 视频 / 对话**：共用服务端模型配置，保留生成记录与素材。
- **复用公司 OA**：企业微信 → 公司 OA → 画布，不新增扫码或密码步骤；图片模型使用匿名编号，模型密钥保留在服务端。

## 选择运行方式

| 你的场景 | 从这里开始 |
| --- | --- |
| 公司使用者 | 从企业微信中的公司 OA 点击画布，无需另行扫码或安装 |
| 本机试用 | 直接打开试用地址，不代表企业身份隔离环境 |
| Windows 局域网 | [本地部署说明](README-本地部署.md) |
| Linux 公司服务器 | [Linux 部署](docs/manual/linux-deployment.md) |
| 宝塔离线安装 | [完整离线包](docs/manual/baota-offline-installation.md) |
| 修改源码 / 调试 | [本地开发](docs/content/docs/backend/local-development.mdx) |

Windows 快速安装需要 Git、Bun 和 Node.js：

```powershell
git clone https://github.com/Jizhidemu52/Vincent-s-Canvas.git
cd Vincent-s-Canvas
cd web
bun install --frozen-lockfile
cd ..\server
bun install --frozen-lockfile
cd ..
.\Build-LAN.ps1
```

按 [本地部署说明](README-本地部署.md) 配置 `server/.env`，再运行 `Start-LAN.bat` 可本机免登录试用。企业部署显式使用 `OA_LOGIN_ENABLED=true`，由公司 OA 提供可验证的员工身份，不回退访客；接入、HTTPS 和公司网络范围见 [公司 OA 接入](docs/manual/oa-workspace-integration.md)。模型凭据与敏感维护接口始终受保护。

## 仓库结构

```text
web/                 React + TypeScript + Vite 前端与测试
server/              Bun API、Worker、模型适配、数据库迁移与测试
ops/                 部署预检、离线包、备份恢复和压测
docs/                操作、部署、开发与验收文档
Build-LAN.*          Windows 前端构建入口
Start-LAN.*          Windows 试用 / 企业 OA 试点启动入口
docker-compose.yml   完整服务器服务编排
```

## 使用与维护

- [操作手册](docs/manual/user-guide.md) · [文档导航](docs/index.md) · [部署与更新](docs/manual/installation-guide.md)
- [当前待验收项](docs/content/docs/progress/pending-test.mdx) · [版本记录](CHANGELOG.md)
- 更新前备份配置和实际数据；按对应部署手册拉取、构建、迁移并重启，不强制覆盖本地改动。
- 企业画布与原图按员工云端保存；确认已同步后可恢复，独立聊天与创意草稿仍为员工分区的浏览器数据。本机试用画布仅本地保存，换设备或清理前先导出；旧账号与共用数据不自动迁移或公开。
- 公司正式入口仅允许公司网络访问，网页、API 和媒体均需网关/防火墙限制。服务器位置、出口 IP 和真实员工联调尚待 IT 提供并验收，当前试用地址不等于正式部署完成。
- 模型调用可能收费。Key 只放服务端；`.env`、数据库、素材、测试输出和构建产物不上传 GitHub。
