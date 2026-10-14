原源码模块实验室（独立于正式画布）

这是六个上游项目的局部原源码测试及中文实验适配器，不是六套产品部署，也不是正式画布已接入。
只包含自行编写的 harness、配置、固定依赖锁、源码清单和精简结论；上游源码由下载脚本获取，不随本仓库复制。
模型、数据库等外部服务的替身明确标注。未运行付费模型、GPU 推理或真实生产登录。

快速开始（Windows PowerShell，在本目录运行）

前提：Git、Node 22.18 或更新版本（此前使用 Node 25.2.1），npm；品牌/插件测试另需 Bun。
只想检查 InvokeAI 选区模块时，不需要安装三个网页实验的依赖，也不需要 Python。

1. 获取指定固定源码，并保留上游 LICENSE、Git commit 与原始文件。
   .\Setup-Sources.ps1 -Only invoke
   默认省略 -Only 会下载六个源码；也可选 fabric、tldraw、loomic、sdk、comfy。
   .\Setup-Sources.ps1 -Only invoke -VerifyOnly
   下载脚本仅接受 source-manifest.json 中的官方仓库地址和完整提交号。
   已有目录若提交、origin 或工作区状态不匹配则报错，不重置、不覆盖。

2. 安装本实验共享的 Playwright 测试驱动。
   npm ci --ignore-scripts --no-audit --no-fund
   npx playwright install chromium
   如已有可用 Chrome/Chromium，可将 BROWSER_EXECUTABLE 环境变量设为其可执行文件完整路径。
   测试默认使用 Playwright 管理的 Chromium；代码不依赖开发者机器路径或浏览器登录状态。

3. 运行轻量原源码测试。
   npm run test:invoke
   它启动临时回环地址，真实浏览器直接导入固定源码，测试后关闭自己创建的服务。
   预期 9 通过、1 假设性边界探针失败，退出码 1；这是保留的负面证据，不是全部通过。
   结果位于 invoke-comfy/reports/，该目录不提交。

三个网页实验（按需安装；不是正式应用入口）

Fabric：
   .\Setup-Sources.ps1 -Only fabric
   Push-Location fabric
   npm exec --yes --package=pnpm@8.4.0 -- pnpm install --frozen-lockfile --ignore-scripts
   Pop-Location
   .\Start-Source-Labs.ps1 -Only fabric
   打开 http://127.0.0.1:4330/，运行原 App、编辑器与 core 插件；账号/模板/字体网络服务未连接。
   从文件菜单导入自己的本地素材，或执行 npm run test:fabric，测试会从相邻
   ../design-workbench/assets/ 读取本仓库的 garment.png / flower.svg 夹具并生成 qa/native-project.json。
   生成的项目可再从“文件”→“导入文件”打开；未生成前该 JSON 不存在。

tldraw：
   .\Setup-Sources.ps1 -Only tldraw
   npm ci --prefix tldraw --no-audit --no-fund
   .\Start-Source-Labs.ps1 -Only tldraw
   打开 http://127.0.0.1:4332/；运行原 image-pipeline App/Editor/执行器/节点。
   npm run test:tldraw
   结果面板需运行测试后才有数据。返回图是有明确文字标记的本地 SVG，不是 AI 生成质量样本。
   SDK 使用锁定的 npm tldraw 5.5.2，而非从 monorepo 重建 SDK；17 个节点执行函数保持原样。

品牌工具与插件 SDK：
   .\Setup-Sources.ps1 -Only loomic,sdk
   npm ci --prefix brand-sdk --no-audit --no-fund
   Push-Location brand-sdk
   bun --no-env-file run source-tests.ts
   node build-sdk.mjs
   Pop-Location
   .\Start-Source-Labs.ps1 -Only brand-sdk
   打开 http://127.0.0.1:4331/，然后可执行 npm run test:sdk-ui。
   原 SDK 的 buildPlugin 编译原 sticky-note；React 宿主/updateMetadata/localStorage 是明确标注的测试适配器。
   不代表正式画布插件加载、安全沙箱或云端持久化已验收。

三组都安装后可双击 Start-Source-Labs.cmd。所有服务只绑定 127.0.0.1；遇到占用端口即报错，绝不停止已有进程。
网页服务在本机持续运行；关闭终端并不自动关闭已启动的后台服务。原进程退出后再运行启动器即可。
运行日志、编译产物、上游下载和测试输出均被 .gitignore 排除。

可选 ComfyUI 模块测试

   .\Setup-Sources.ps1 -Only comfy
   python -m venv invoke-comfy/.venv
   invoke-comfy/.venv/Scripts/python -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cpu
   invoke-comfy/.venv/Scripts/python -m pip install -r invoke-comfy/requirements-test.txt
   invoke-comfy/.venv/Scripts/python -I invoke-comfy/tests/comfy-tests.py
需兼容 torch 2.10.0 wheel 的 Python；原实测环境为 Python 3.14.3 + torch 2.10.0+cpu。
依赖装进独立虚拟环境，不安装完整 ComfyUI，也不下载模型。当前发布未重新创建整套 Python/GPU 环境。

真实结论与未通过项（原固定提交实测，不按“协议成功”冒充业务验收）

Fabric：14 项正例，2 项原始缺口。JSON 不保存底图锁定字段；清空调用已不存在的 canvas.clearHistory。
PNG 为 1024×1024；JSON 重开前后有 0.0287% 像素差异，不承诺完全无损往返。
只测试离线素材/图层/文档操作，未验证线上模板、账号和云端保存。

tldraw：12 场景为 7 通过、5 缺口（断言成功确认了缺口，不等于产品通过）：
  下游可能沿用过期上游结果；重跑没有请求级缓存；失败节点可能停留执行中且兄弟请求晚写回；
  停止不取消在途请求；旧请求可能覆盖新结果。
不应将这个示例执行器原样接入正式任务系统。

InvokeAI：9 通过、1 假设性边界探针失败。全选后同域反选，alpha 全空但 hasSelection 为 true。
“活动但全空的选择态”是否应等于“取消选区”未有明确契约，不据此断言产品 bug 或整图误改。
只运行原像素选区/预览/项目身份守卫模块，不是完整 InvokeAI 后端与生成测试。

ComfyUI：13 项通过。真实 graph/graph_utils/caching/cache_provider，节点注册是最小测试夹具。
手工重排不是自动重试；稳定缓存键不是磁盘持久化；内容缓存不是项目/租户隔离。
重复 release 回调可产生负计数，调用适配器需保证一次性释放；未测试 GPU、完整服务器或崩溃恢复。

Loomic/SDK：12 项行为探针完成，其中 4 项确认已有边界；插件另有 7 组浏览器交互通过。
Loomic 丢失图片 role，签名失败仍返回原路径，数据库错误与套件缺失混同。
SDK 的 definePlugin 只提供类型辅助，不做运行时校验，也不构成插件安全沙箱。
Supabase 数据库/存储是内存夹具；真实认证、RLS、签名服务和 LLM 主动调用未验收。

来源与许可

完整来源、固定 commit、检出目录、原 LICENSE 路径见 source-manifest.json。
Fabric/Loomic/infinite-canvas 根许可为 MIT；InvokeAI 为 Apache-2.0；ComfyUI 为 GPL-3.0。
tldraw 根 LICENSE.md 为其自定义许可，与模板 README 的许可叙述存在差异；保留原声明和 SDK 许可角标。
本实验只用于内部开发测试，不把技术测试当成商业授权或闭源复制许可。正式集成前应核实各原许可义务。
上游原实现不复制到 harness。中文展示替换、外部服务替身与源文件保持范围可从适配器代码审查。

此次仓库打包验证

共享 npm 锁文件可安装；浏览器脚本不再使用个人绝对路径；PowerShell 5.1 语法与 UTF-8 BOM 已检查。
Setup-Sources.ps1 已从官方 GitHub 拉取并核实 SDK 固定提交。其余五源未在此次打包时全部远程重拉。
迁移后的 InvokeAI 测试真实运行得到相同 9/1 结果且 pageErrors 为空，源码由原固定检出的本地副本提供。
其他原有效测试结论沿用同一固定提交证据；未声称此次全量重装、GPU 或正式画布集成已完成。
精简计数与边界见 validation-summary.json；大截图、base64 图片、网络日志及原输出保留在本机交付目录，不上传。
