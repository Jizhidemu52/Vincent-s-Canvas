# 无线画布

面向设计团队的 AI 创作工作台：用一张画布整理参考图、生成图片、反复改稿和保存成果。

## 能做什么

- **画布创作**：多图参考、节点与连线、图片编辑、导入导出；OA 员工画布支持云端恢复。
- **创意设计**：款生线稿、花型提取、改款、配色、辅料等九个工作台。
- **图片 / 视频 / 对话**：共用服务端模型配置，保留生成记录与素材。
- **团队管理**：账号、权限、额度、模型与审计。设计师图片模型使用匿名编号，管理员查看真实映射。

## 选择运行方式

| 你的场景 | 从这里开始 |
| --- | --- |
| 已部署好的设计师 | 从公司 OA 或管理员提供的入口进入，无需安装 |
| Windows 局域网 OA | [本地部署说明](README-本地部署.md) |
| Linux 公司服务器 | [Linux 部署](docs/manual/linux-deployment.md) |
| 宝塔离线安装 | [完整离线包](docs/manual/baota-offline-installation.md) |
| 修改源码 / 调试 | [本地开发](docs/content/docs/backend/local-development.mdx) |

Windows OA 快速安装需要 Git、Bun、Node.js 和有效的公司 OA 接入：

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

按 [本地部署说明](README-本地部署.md) 配置 `server/.env`，再运行 `Start-LAN.bat`。OA 模式不提供密码或管理员登录，不能用裸地址代替员工入口。完整服务器部署使用不同的后端与配置，见上表。

## 仓库结构

```text
web/                 React + TypeScript + Vite 前端与测试
server/              Bun API、Worker、模型适配、数据库迁移与测试
ops/                 部署预检、离线包、备份恢复和压测
docs/                操作、部署、开发与验收文档
Build-LAN.*          Windows 前端构建入口
Start-LAN.*          Windows OA 服务启动入口
docker-compose.yml   完整服务器服务编排
```

## 使用与维护

- [操作手册](docs/manual/user-guide.md) · [文档导航](docs/index.md) · [部署与更新](docs/manual/installation-guide.md)
- [当前待验收项](docs/content/docs/progress/pending-test.mdx) · [版本记录](CHANGELOG.md)
- 更新前备份配置和实际数据；按对应部署手册拉取、构建、迁移并重启，不强制覆盖本地改动。
- OA 画布需确认“已同步”再换设备；非 OA 画布及独立聊天/创意草稿仍保存在浏览器，重要内容请导出。
- 模型调用可能收费。Key 只放服务端；`.env`、数据库、素材、测试输出和构建产物不上传 GitHub。
