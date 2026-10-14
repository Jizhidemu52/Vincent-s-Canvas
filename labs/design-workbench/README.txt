文森特设计实验室 — 独立、离线运行的交互 Demo

定位与启动
本目录是设计工作台的可运行交付，不会改动正式画布，不调用模型、不上传图片。
运行时只需 Bun；不需要 npm install，也不需要账号或 API Key。

在本目录执行：
  bun --no-env-file run server.ts
然后打开 http://127.0.0.1:4328/ 。Windows 也可双击 Start-Demo.cmd。
仅监听 127.0.0.1；停止命令行服务使用 Ctrl+C。
已有服务占用端口时不要结束未知进程；可用环境变量换端口：
  PowerShell：$env:DESIGN_DEMO_PORT='4329'
  然后再执行 bun --no-env-file run server.ts，打开 http://127.0.0.1:4329/ 。
  macOS/Linux：DESIGN_DEMO_PORT=4329 bun --no-env-file run server.ts

三个工作台
1. /demo/placement 图案贴合
   拖动图案，调整宽度、角度、不透明度及混合模式；复制、显隐、排序与撤销。
   支持替换底图、上传自己的图案、工程 JSON 导入导出和原始底图尺寸 PNG 导出。
   当前是二维定位合成；没有 AI 褶皱贴合、透视变形或材质融合。

2. /demo/repeat 花型循环
   直排、半落、镜像模式；跨边拖动、厘米/DPI 尺寸、透明背景与完整周期导出。
   半落周期为 2W×H，镜像周期为 2W×2H；不是把预览图错误当作最小循环单元。
   预览最长边 1600 px；完整周期最长边 4096 px、面积不超过 1600 万像素。
   DPI 参与像素尺寸计算，未写入 PNG 元数据；工程 JSON 保存物理尺寸和 DPI。
   上传图案不自动去背景，建议使用透明 PNG。

3. /demo/recipe 系列开发与配色
   选择配方，修改系列名称、保留约束和设计方向，点击“模拟运行”。
   手动选色：数量可选 1–6 个，点编号色块后使用原生选色器，或输入 HEX 并“应用”。
   随机配色：柔和、鲜明、大地、自由四种风格；点“换一组”，之后仍可逐色调整。
   更改颜色会清除旧候选，需重新运行；配色及风格会随配方保存并写入流程导出。
   可暂停/继续、注入一次分支失败、仅重试失败项、选择候选并导出方案板 PNG。
   换色与图案候选是本地 Canvas 像素滤色/叠加，不是真实 AI 生成。
   文字约束会保存，但算法不理解提示词，不进行结构识别、语义分割或材质渲染。
   “模拟费用”仅展示工作流计算；实际模型调用次数和费用均为 0。
   依用户决定暂不接入潘通：本包没有 TCX/TPG 数据、潘通色号输入或自动匹配。
   屏幕近似色不等于实物色卡或生产染色标准。

保存边界
离开页面前使用各工作台的保存按钮或下载工程文件，不是自动保存。
浏览器本地记录与浏览器及端口绑定；清除浏览器数据会失去本地存档。
系列流程的“本地保存”只保存配方；完整输入图和候选结果用“完整流程 JSON”下载。
本目录与正式 Vincent-s-Canvas 运行逻辑分离，不代表三个工作台已接入正式产品。
其他原始开源模块的实测与限制见相邻 source-modules/。

来源和许可
工作台及内置花叶/字标是本项目演示实现；服装图复用已有合成测试素材，不代表品牌商品。
颜色运算实际使用 gka/chroma.js 3.2.0，浏览器模块本地附带，无运行时 CDN 请求。
上游：https://github.com/gka/chroma.js/tree/v3.2.0
原始许可：recipe/vendor/chroma-js/LICENSE（BSD-3-Clause，以及 ColorBrewer 的 Apache-2.0 声明）。
固定版本、上游提交、发布包校验和及构建命令见 recipe/vendor/chroma-js/来源与许可.txt。
未打包原 npm 压缩包、整份依赖源树、潘通研究资料或本机配置。
浏览器 QA 使用 Microsoft Playwright，仅是开发依赖；安装依赖不是运行 Demo 的前提。

验证与可复现测试
单元测试使用 Node.js 22 或更新版本，直接运行：
  npm test
覆盖定位模型、循环几何、任务状态和配色算法；不需要安装 Playwright。

浏览器测试另需 Node.js/npm。先在此目录执行：
  npm ci --ignore-scripts
  npx playwright install chromium
在另一个终端启动上述 Bun 服务，再执行：
  npm run test:browser
Linux 如缺少系统浏览器依赖可使用 npx playwright install --with-deps chromium。
默认测试地址是 http://127.0.0.1:4328；如换端口，需同步设置：
  PowerShell：$env:DESIGN_DEMO_TEST_URL='http://127.0.0.1:4329'
  macOS/Linux：DESIGN_DEMO_TEST_URL=http://127.0.0.1:4329 npm run test:browser
如需复用已安装 Chromium，设置 BROWSER_EXECUTABLE 为浏览器可执行文件绝对路径。
未设置时使用 Playwright 管理的 Chromium，不依赖某个用户目录或机器专属路径。

test:browser 顺序验证四个入口、定位编辑/保存/导出、循环导出逐像素周期性、
流程暂停/失败重试/上传/导出，以及手动 RGB/随机四色风格/保存恢复/窄屏适配。
截图、下载文件和 JSON 结果写入各 qa/output/，已被 .gitignore 排除；node_modules 不上传。
随包验证摘要见 VALIDATION.txt。历史截图及含大图 base64 的导出 JSON 不作为源码入库。
