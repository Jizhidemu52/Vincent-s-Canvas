# 无线画布

面向设计团队的 AI 创作工作台，在一张画布里整理参考图、生成图片、反复改稿和保存成果。

## 主要功能

- **无线画布**：拖放素材、自由缩放、多图参考和导入导出。
- **AI 创作**：图片生成与编辑、视频创作、对话助手。
- **素材复用**：管理图片、提示词和生成记录。
- **团队管理**：公司版支持账号、分组、额度和模型配置。

## 拉取与安装（Windows / 局域网）

已部署好？直接打开管理员提供的地址，无需重复安装。

首次安装，先准备 [Git](https://git-scm.com/downloads) 和 [Bun](https://bun.sh/)，然后在 PowerShell 执行：

```powershell
git clone https://github.com/Jizhidemu52/Vincent-s-Canvas.git
cd Vincent-s-Canvas
cd web
bun install
bun run build
cd ..\server
bun install
cd ..
```

配置与启动：

1. 若没有 `server/.env`，复制 `server/.env.example` 为 `.env`，按 [模型配置说明](README-本地部署.md) 填入自己的模型 Key。
2. 双击根目录的 `Start-LAN.bat`；首次若提示防火墙权限不足，右键以管理员身份运行一次。
3. 打开启动窗口显示的网址。同事使用同一地址，且须在同一局域网；运行电脑保持开机。

## 拉取最新版本

先备份 `server/.env`、`server/.data` 和重要画布；在项目根目录执行：

```powershell
git pull --ff-only origin main
cd web
bun install
bun run build
cd ..\server
bun install
cd ..
```

更新后刷新网页；若更新了服务端或 Key，等待生成任务结束，停止旧的本项目服务后再运行 `Start-LAN.bat`。重复双击启动脚本只会复用已有服务，不会自动重启。若拉取提示本地改动冲突，先保留改动，不要强制覆盖。

## 详细手册

- [全板块操作手册](docs/manual/user-guide.md)：生成、改图、下载与备份。
- [Windows / 局域网安装](README-本地部署.md)：在电脑上运行，供同事访问。
- [Linux 服务器部署](docs/manual/linux-deployment.md)：公司服务器安装与维护。
- [宝塔离线安装](docs/manual/baota-offline-installation.md)：服务器下载或编译较慢时使用。

## 使用须知

- AI 生成需要配置模型服务，费用按服务商实际用量计算。
- 画布保存在当前浏览器；分享链接不等于跨设备同步，重要成果请导出备份。
- API Key 只保存在服务端，不要上传到 GitHub。

[版本更新](CHANGELOG.md) · [完整安装指南](docs/manual/installation-guide.md)
