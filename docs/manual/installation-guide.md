# 无线画布安装与部署指南

这份手册放在 GitHub，负责从下载源码到启动、接入模型、更新和备份；软件各板块的用法请看 [图文操作手册](user-guide.md)。

当前实际技术栈是 `web/` 的 React + TypeScript + Vite，以及 `server/` 的 Bun / TypeScript 服务。正式部署使用 PostgreSQL、Redis 和 S3/MinIO；不是仅打开 HTML 文件即可完成模型生成的离线工具。

## 安装前准备

个人 Windows 试用需要 Windows 10/11、Bun、现代浏览器、能够访问模型服务商的网络，以及你自己有权限使用的模型 Key。下载与安装 Bun 时使用 [Bun 官方网站](https://bun.sh/)，安装后重新打开 PowerShell，确认 `bun --version` 能运行。

更新代码推荐安装 Git；不装 Git 也可在仓库网页选择 `Code → Download ZIP` 后解压，但以后需要自行保留 `server/.env` 与作品备份，不能把旧目录中的全部配置直接覆盖。

公司完整部署需要支持 Docker Compose 的服务器、数据库与对象存储持久化磁盘、备份空间；多人长期使用还要准备域名、HTTPS 和访问控制。企业微信登录另需公司自建应用权限，不是个人单机试用的前置条件。

## 下载源码

安装了 Git 后，在准备放项目的位置打开 PowerShell：

```powershell
git clone https://github.com/Jizhidemu52/Vincent-s-Canvas.git
cd Vincent-s-Canvas
```

已存在这个仓库时不必重新克隆。后面的“项目根目录”就是同时含有 `web`、`server`、`docker-compose.yml` 的 `Vincent-s-Canvas` 文件夹。

## 1. 先确认自己用的是哪一种模式

| 模式 | 怎么启动 | 登录与积分 | 数据与适用场景 |
| --- | --- | --- | --- |
| Windows 单机 / 局域网试用 | `Start-LAN.bat`，底层运行 `server/src/demo-server.ts` | 默认免登录、不扣项目内部积分 | 适合个人使用或可信内网试用；服务端演示数据在内存中，不能当公司多人正式系统 |
| 本地开发 | 分别启动 `server` 与 `web` | 由后端部署开关决定 | 方便开发、排错；运行 demo 服务时仍只有演示级持久化能力 |
| 公司完整部署 | 根目录 `docker compose up -d --build` | 可启用账号、角色、积分，也可按需关闭 | API + Worker + PostgreSQL + Redis + S3/MinIO，适合正式业务数据与权限管理 |

无论哪种模式，外部图片、视频、文本模型都可能收费。页面隐藏“积分”只是关闭本项目的内部额度限制，不会免除 API 服务商的费用。

单机免登录服务使用固定演示设计师身份，不具备正式账号间的数据隔离。拿到访问地址的人可能使用同一套服务端模型额度和演示数据，所以只给可信人员使用，不直接开放到公网。

## 2. 在自己的电脑启动

### 2.1 已经能打开网页时

直接使用当前浏览器地址，不需要为了看指南重新部署。比如 `http://127.0.0.1:3001/` 是当前电脑上的一个本地地址，不是 GitHub 地址，也不是其他同事可以直接访问的地址。

`localhost`、`127.0.0.1`、局域网 IP、域名，以及不同端口，都是不同的网站来源。浏览器保存的本地画布不会自动跟着地址变化；换地址前先导出画布。

### 2.2 Windows 最简单的单机启动

准备好 Bun，在 PowerShell 运行 `bun --version` 应能显示版本号。然后在项目根目录安装依赖、构建网页：

不会打开命令窗口时：用文件资源管理器打开 `Vincent-s-Canvas` 文件夹，在空白处右键选 `在终端中打开`。确认窗口当前路径末尾是 `Vincent-s-Canvas`，再逐行执行下面命令，每行按一次回车，等待它结束后继续下一行。

```powershell
cd web
bun install
bun run build

cd ..\server
bun install
```

如果 `server/.env` 不存在，从 `server/.env.example` 复制一份；已存在就编辑原文件，不要覆盖。模型 Key 的填写方法见第 3 节。

刚才的命令最后停在 `server` 文件夹，可以直接运行这段“仅在没有配置时复制”的命令：

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
notepad .env
```

记事本打开后，按第 3 节填写模型配置，按 `Ctrl + S` 保存，然后关掉记事本。`.env` 是完整文件名，不要另存成 `.env.txt`。这个文件属于你自己的私密配置，不发群、不上传 GitHub。

双击项目根目录的 `Start-LAN.bat`，使用启动窗口实际打印的地址。脚本默认使用 `5188` 端口，可能显示：

```text
http://192.168.1.115:5188/
```

这个 IP 只是例子，每台电脑不同。脚本创建的防火墙规则限定为本地子网；如果提示没有权限创建规则，可按提示以管理员身份运行一次。不要为了排错关闭整个 Windows 防火墙。

给同一局域网同事使用时，分享脚本打印的局域网地址；运行电脑必须保持开机、不休眠，服务也必须保持运行。脚本发现端口已有服务时不会自动替换旧进程，因此改配置或更新代码后，需要停止原服务再重新启动；不要同时开多个占用同一端口的实例。

看到“already listening”只表示该端口已经有程序，并不能证明新配置已加载。若不知道怎样停止后台的单机服务，可先保存/下载重要成果，再重启运行电脑，然后双击 `Start-LAN.bat`。这是单机启动方式，不适用于公司生产服务器；不要为了重启随意结束不认识的进程。

成功检查：网页能打开 → 页面显示免登录创作 → 图片模型下拉中有可用模型。最后是否真实出图，需要你自行确认费用后点一次生成；本指南不会因为网页能打开就声称模型已验证成功。

详细步骤见 [本地与局域网部署说明](../../README-本地部署.md)。

### 2.3 开发时分别启动前后端

以下命令使用演示后端，方便在自己电脑上免登录调试界面。先安装两端依赖，再开两个 PowerShell 窗口。

窗口一，在项目根目录执行：

```powershell
cd server
$env:LOCAL_STANDALONE = "true"
bun run dev:demo
```

窗口二，在项目根目录执行：

```powershell
cd web
bun run dev
```

后端默认 `3100`，前端默认 `3000`；如端口已占用，以 Vite 输出的实际网址为准。开发前端通过 `/api` 代理到后端，代理目标可由 `web/.env` 中的 `VITE_API_PROXY_TARGET` 设置。只启动 Vite 并不会启动模型、登录或素材服务。

`server` 的 `bun run dev` 则运行正式 API，需要 PostgreSQL、Redis、对象存储等配置，不等同于 `dev:demo`。正式环境和多人使用请按 [生产部署与验收手册](production-deployment.md) 部署完整服务。

### 2.4 开关怎么设置

正式部署在根目录 `.env` 配置，开发 API 在其实际使用的服务端环境配置；修改后重启相关 API / Worker：

| 设置 | 行为 |
| --- | --- |
| `AUTH_ENABLED=false` | 普通创作免登录，正式服务为浏览器分配访客身份；同时关闭内部积分扣费 |
| `CREDITS_ENABLED=false` | 保留登录与权限，但新任务不冻结、不扣内部积分 |
| `ROLE_PORTALS_ENABLED=false` | 隐藏角色选择入口，不取消后台鉴权 |

这些是服务端开关，不是在浏览器改个偏好就能获得权限。正式免登录模式的管理员仍从 `/admin/login` 登录；访客不能访问后台。清掉访客 Cookie 后也不能自动找回原访客身份。

前端还有构建时的 `VITE_STANDALONE_EDITION=true` 精简版开关，会移除管理相关页面；一般使用上述运行时开关或 `Start-LAN.bat` 即可，不必额外设置它。

## 3. 模型先配置好，网页才能真正生成

### 3.1 单机版：运行电脑配置 Key

编辑 `server/.env`，按自己已购买的服务填写。OpenToken 使用：

```dotenv
OPENTOKEN_BASE_URL=https://cn2.gw.opentoken.io/v1
OPENTOKEN_API_KEY=填写你自己的Key
```

APIMart 使用：

```dotenv
APIMART_BASE_URL=https://api.apimart.ai/v1
APIMART_API_KEY=填写你自己的Key
```

不必两家都配，也不要把示例中文作为真实 Key。保存后重启演示服务。可用模型由服务端根据凭据和模型配置返回；没配 Key 的服务不会因为前端出现一个模型名字就自动可用。显示名称如 `open gpt2`、`gemini` 是项目中的名称，实际请求由后端映射到供应商模型 ID。

供应商是否开放某个模型、是否有余额、能否接受当前图片或视频参数，最终取决于供应商账号。这个仓库本身不附送 API 额度。

### 3.2 公司版：超级管理员统一配置

1. 打开 `/admin/login`，使用管理员账号登录。首次初始化管理员账号来自部署环境，首次登录按要求改密。
2. 进入 `板块 API 配置`，选择文生图、图片编辑、细节增强、角度控制、无缝拼接或视频板块。
3. 选择已有 API 服务，或新增服务，填写协议、Base URL 和 API Key。
4. 填模型显示名、供应商要求的模型 ID、能力、并发限制和成本。图像、聊天、视频、音频能力不能互相代替。
5. 普通模型接口不必配置工作流；RunningHub、ComfyUI 和内部流程才使用 `工作流（高级）`。
6. 点击 `保存并同步到设计师端`，确认模型与 Provider 已启用、板块已配置。
7. 回到创作页，选择该模型，先用一张小规格图片验证；“真实测试出图”和点击“生成”都可能产生供应商费用。

设计师不需要拿到 Key，只选择管理员提供的模型。正式服务把 Provider Key 加密存入数据库，依赖 `PROVIDER_ENCRYPTION_KEY` 解密；单机演示服务主要从 `server/.env` 读取 Key。这两种方式都不应把真实 Key 放进前端 `VITE_` 变量、提示词、截图或 GitHub。

模型协议和复杂 Provider 配置见 [操作手册的 API 章节](operation-manual.md#8-管理员怎么接入模型-api)。

## 4. 公司服务器完整部署

### 4.1 建立配置

在项目根目录从 `.env.example` 复制出 `.env`。Windows PowerShell：

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
```

Linux 服务器首次部署可用 `cp .env.example .env`；已有 `.env` 时先备份并编辑原文件，不要覆盖。至少替换示例中的数据库密码、初始管理员密码、对象存储密码和 Provider 加密密钥；检查所有 `replace-with` 占位值。

Provider 加密密钥可在有 OpenSSL 的环境生成：

```bash
openssl rand -base64 32
```

把输出放入 `PROVIDER_ENCRYPTION_KEY` 并单独安全备份，不公开粘贴。这个值负责解密数据库中的模型 Key，不能每次重启重新生成。

### 4.2 预检、构建、启动

在有 Bun 的服务器运行：

```bash
bun ops/preflight/production-preflight.ts
docker compose up -d --build
docker compose ps
curl http://localhost:3000/api/health
```

需要企业微信验收时，预检加 `--require-wecom`。没有 Bun 的服务器按 [生产部署手册](production-deployment.md) 使用 Bun 容器执行预检。

成功结果应是相关容器健康运行，健康接口返回成功，而不是仅仅看到 Docker 已下载镜像。首次启动会迁移数据库、初始化对象存储和首位管理员。若失败：

```bash
docker compose logs --tail=100 api worker
```

根据脱敏日志补齐配置再重启，不通过删除数据库卷来消除报错。

### 4.3 第一次进入并开通使用

1. 打开 `http://服务器地址:3000/admin/login`，使用 `.env` 设置的管理员账号和初始密码。
2. 按提示修改初始密码；确认管理员创建成功后，从部署环境移除 `BOOTSTRAP_ADMIN_PASSWORD` 并安全保存正式登录方式。
3. 在后台创建部门、账号；有首次改密要求时让使用者自行完成。
4. 按第 3 节配置板块模型、Key、并发与成本，决定是否启用内部积分。
5. 用一位设计师账号测试登录、参考图上传、一次真实生成、素材下载、历史和额度结算，再扩大使用范围。

测试生成可能收费。需要先验证队列而不调用外部模型时使用 `TASK_MOCK_MODE=true`；这不算真实模型验收，正式使用前应改回 `false` 并重启 API 与 Worker。

### 4.4 上线与备份

内网长期部署或公网部署都要控制访问范围；对外服务通过网关/反向代理提供 HTTPS。不要把 PostgreSQL、Redis、MinIO 管理端口直接暴露公网。免登录创作建议只在可信内网或已有访问网关内开放。

生产环境需要同时保护：

- PostgreSQL：账号、项目、任务、额度、素材元数据、审计。
- S3/MinIO 文件：原图、生成结果与数据库备份文件。
- 安全配置：`.env`、Provider 加密密钥等，单独受控保管。
- 浏览器画布：让用户自行导出 ZIP；数据库备份不能替代本地画布备份。

现有 Backup 容器按部署配置定期备份数据库；查看 `docker compose logs --tail=100 backup` 确认实际成功，并按生产手册演练恢复。不要未经验证就把“容器在运行”当成“备份可用”。

企业微信回调、对象存储、备份恢复、并发验收与上线检查，以 [生产部署与验收手册](production-deployment.md) 为完整操作依据。

## 5. 源码、GitHub 与更新

仓库的主要部分是：

```text
web/                 React + TypeScript + Vite 前端
server/              Bun / TypeScript 服务端、任务与供应商适配
docs/manual/         用户与运维手册
ops/                 预检、备份、压测等运维脚本
docker-compose.yml   完整服务编排
Start-LAN.bat/.ps1   Windows 局域网试用入口
```

GitHub 保存的是源码、配置示例、测试、脚本和文档，不会自动保存浏览器画布、数据库、素材文件、`.env` 或模型额度。代码“全部上传”与用户作品“全部备份”必须分别做。

更新时先备份作品和安全配置，确认工作区没有尚未处理的个人改动，再拉取仓库更新并重建前端。Windows 本地安装可参考：

```powershell
git status --short
git pull --ff-only origin main

cd web
bun install
bun run build

cd ..\server
bun install
```

若 Git 提示本地改动冲突，先保留并处理，不使用强制重置来“修复”。构建后重启自己正在使用的服务；公司部署按生产手册更新完整容器。不要用网页热刷新代替后端重启，也不要把 `web/dist`、`node_modules` 或本地日志当成必须上传 GitHub 的源代码。
