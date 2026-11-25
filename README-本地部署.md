# Windows 本地与局域网部署说明

适用于 Windows 10 / 11。准备 Git、Bun 和 [兼容的 Node.js](docs/content/docs/backend/local-development.mdx#模型-https-运行要求)，按 [Windows 快速开始](README.md#windows-快速开始) 安装锁定依赖并构建。严格蒙版和服务端媒体处理需要 FFmpeg / ffprobe。

## 配置模型与试款台

首次配置时，从 `server/.env.example` 复制出 `server/.env`。已有配置直接编辑。按实际使用的服务填写服务端 API 地址和密钥。模型凭据保存在服务端；真实生成消耗对应服务商额度。

若要在免登录的本机试用中打开试款台，在 `server/.env` 设置 `DEMO_CANVAS_TRYOUT_ENABLED=true`，并按[本地开发说明](docs/content/docs/backend/local-development.mdx)配置试款模型服务。此开关适用于回环地址上的单机试用。

## 启动方式

| 用途 | 入口 | 数据与访问 |
| --- | --- | --- |
| 本机试用 | `Start-Local.bat` | 监听 `127.0.0.1:5188`。画布保存在浏览器，服务端素材和任务使用本机 SQLite。 |
| 受信局域网试用 | `Start-LAN.bat` | 使用脚本打印的局域网地址。访问者须在允许的网络内，运行电脑保持开机。 |
| 公司 OA 试点 | `Start-LAN.ps1 -CompanyOa` | 按 [OA 接入说明](docs/manual/oa-workspace-integration.md) 配置。从公司 OA 进入，以员工身份加载画布和原图。 |
| 正式部署 | [生产部署手册](docs/manual/production-deployment.md) | 按正式栈配置 PostgreSQL、Redis、对象存储、入口和备份。 |

局域网脚本在健康检查通过后打印服务地址。再次启动会复用现有服务。局域网运行日志位于 `server/.data/lan-server.out.log` 和 `server/.data/lan-server.err.log`。

## 更新与备份

1. 导出重要画布和未同步资料，等待在途生成结束。
2. 保存本机 `server/.env`。停服后备份整个 `server/.data`，以便保留 SQLite 及其关联文件。正式服务按部署手册同时备份数据库和对象存储。
3. 拉取更新后重新安装锁定依赖，运行 `Build-LAN.ps1`，再按原模式启动。企业会话失效时从 OA 重新进入。

## 常见问题

- 同事打不开时，检查脚本打印的地址、电脑是否休眠，以及访问者和主机的网络与防火墙设置。
- 生成失败时，检查对应的服务端密钥、模型配置、额度和上游网络。服务端配置修改后重启该实例。
- 生成等待时间受任务排队、模型响应和网络影响。正式环境核对项见 [生产部署手册](docs/manual/production-deployment.md)。
