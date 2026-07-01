# Vincent-s-Canvas

公司内部设计师使用的 AI 图片无限画布平台。目标是把项目管理、参考图、提示词、图片生成、局部编辑、批量处理、轻量节点流程、素材沉淀、历史记录、账号额度和后台监控放在同一个受控系统里。

![Vincent Canvas workbench](docs/assets/canvas-workbench.png)

## 产品目标

- `Projects`：展示所有项目卡片，支持新建项目；每个项目都是独立无限画布，项目内图片、生成结果和编辑流程互相隔离。
- `History`：用缩略图网格展示历史生成记录，并支持按时间、项目、模型、设计师和类型筛选；每条记录保留原图、结果图、提示词、模型、生成数量、消耗额度、所属项目和操作人。
- `Profile`：展示设计师姓名、角色、剩余额度、已用额度和模型价格规则；管理员可以分配额度、限制额度、查看余额，并配置积分/价格制度。
- `Project Canvas`：白底无限画布作为主工作区，图片、生成结果和编辑结果都作为节点存在；节点支持拖动、四角缩放、选中、复制、删除、下载和继续迭代。
- `Prompt panel`：左侧面板支持模型选择、提示词、参考图和出图数量；点击 Generate 后在画布旁边生成结果节点。
- `Inline image prompt`：双击图片后可直接在图片附近选择模型、输入提示词并生成；它和左侧面板共用同一套模型配置与提交逻辑。
- `Image toolbar`：选中图片后提供放大、去背景、下载、保存素材、复制、删除、Magic Edit 和框选编辑等快捷操作。
- `Mask edit`：支持矩形、圆形和自由区域局部编辑；确认后生成新图片节点，新节点可以继续作为下一轮参考图。
- `Batch mode`：支持导入文件夹或多张图片，用同一个提示词、模型和出图数量依次处理；结果进入画布，历史和额度同步更新，单张失败不会阻断整批。
- `Lightweight node workflow`：支持 `Upload Reference -> Generate -> Edit -> Upscale -> Remove BG -> Final` 这类轻量节点链，先满足内部设计流程，不一开始做 ComfyUI 级别复杂系统。

## 复用策略

这个仓库作为主项目继续演进，不整体迁移到某一个开源项目。实现新功能时优先复用成熟开源能力，不重复造轮子。

已明确参考的项目：

- [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas)：多画布、节点、素材、提示词库和 AI 创作工作台思路。
- [T8mars/T8-penguin-canvas](https://github.com/T8mars/T8-penguin-canvas)：节点工作流、批量执行、素材合集、RunningHub/ComfyUI 思路。
- [hero8152/Infinite-Canvas](https://github.com/hero8152/Infinite-Canvas)：多 provider/API、ComfyUI、RunningHub 接入能力。

后续不局限于这三个项目。无限画布、节点编辑器、批量任务、图片标注、素材管理、ComfyUI 工作流等功能，如果 GitHub 上已有成熟模块并且授权允许，优先搬运或改造后接入本项目。

## 当前能力

- 登录后先进入用户端首页，不直接显示画布。
- `Projects / History / Profile` 三入口已经作为用户端主结构。
- 项目卡片支持新建、打开、重命名、删除，并展示项目预览、节点数、历史数和额度消耗。
- 每个项目进入独立无限画布，画布支持缩放、平移、拖拽导入、粘贴导入、小地图和视图重置。
- 图片节点支持拖动、四角缩放、复制、删除、下载、保存素材、工具栏操作和双击内联生成。
- 左侧 Prompt 面板和图片内联入口共用模型注册表、模型能力过滤和后端提交逻辑。
- 生成、编辑、放大、去背景等结果会作为新节点放在源图旁边，并避让已有编辑节点，方便对比和继续迭代。
- 框选编辑支持 circle、rectangle、freehand，并把 mask 坐标、形状、模型、提示词和额度记录写入节点与历史。
- 批量模式支持多文件/文件夹导入、同提示词处理、并发/失败策略、进度显示、失败原因和历史写入。
- 轻量节点系统支持模块注册、端口、连线、兼容性校验、执行计划、链式运行和 Final 交付。
- 右侧 Dock 提供 Context、History、Assets、Prompts、Assistant 面板；素材和提示词可保存、搜索、筛选、复用。
- 后端托管模型密钥和 provider 配置，前端只传 `modelId`、能力、参数和业务请求。
- 管理员后台支持账号余额、额度调整、额度上限、模型注册、模型价格、操作价格、Provider 状态、团队历史、任务、用量和审计。
- 历史页支持缩略图网格、原图/结果图预览、按项目/模型/类型/设计师/时间筛选，并可导出 CSV。

## 主要文件

- `src/App.tsx`：用户端首页、项目页、History/Profile、Recraft 式画布、节点 UI、工具栏、Dock、管理员后台。
- `src/domain/workspace.ts`：画布领域模型、节点、连线、多选、批量、工作流、多图参考、撤销重做、素材和提示词。
- `src/services/modelApi.ts`：前端调用后端模型、工作区、历史、素材、提示词、额度和管理员 API。
- `server/api.ts`：后端路由、账号额度、模型价格、历史、审计、provider adapter 和请求去重。
- `server/http.ts`：本地 Node HTTP API server，包含 workspace 快照保存和模型操作接口。
- `server/storage.ts`：JSON/SQLite 存储层，负责账号、项目、历史、模型配置、provider 配置和审计日志持久化。
- `src/App.test.tsx`、`src/domain/workspace.test.ts`、`server/*.test.ts`：用户路径、画布交互、领域逻辑和后端接口测试。

## 本地运行

安装依赖：

```bash
npm install
```

启动后端 API：

```bash
npm run api
```

另开一个终端启动前端：

```bash
npm run dev
```

打开 Vite 输出地址，通常是：

```text
http://127.0.0.1:5173/
```

## 后端 API

浏览器端不保存真实模型 API key。所有模型调用通过后端接口进入 provider adapter，后续可替换为 GPT Image、Nano Banana、RunningHub、ComfyUI 或公司内部模型。

- `GET /api/models`
- `GET /api/profile`
- `GET /api/history`
- `GET /api/prompts`
- `POST /api/prompts`
- `DELETE /api/prompts/:id`
- `GET /api/assets`
- `POST /api/assets`
- `PATCH /api/assets/:id`
- `GET /api/assets/:id/content`
- `GET /api/admin/accounts`
- `GET /api/admin/audit`
- `GET /api/admin/usage`
- `GET /api/admin/jobs`
- `GET /api/admin/providers`
- `GET /api/admin/history`
- `POST /api/admin/history/archive`
- `POST /api/admin/history/restore`
- `POST /api/admin/history/delete`
- `POST /api/admin/credits`
- `POST /api/admin/credit-limit`
- `POST /api/admin/model-pricing`
- `POST /api/admin/operation-pricing`
- `POST /api/admin/models`
- `POST /api/admin/provider-settings`
- `POST /api/generations`
- `POST /api/edits`
- `POST /api/upscale`
- `POST /api/remove-bg`
- `GET /api/workspace`
- `POST /api/workspace`

写入接口使用统一的 `GenerationRequest`，返回统一的 `GenerationResult`。请求可以带 `x-request-id`，用于防止重复提交和重复扣费。

## 验证

```bash
npm test
npm run build
```

当前测试覆盖：

- 登录后首页先显示项目/历史/账号入口，创建项目后才进入画布。
- 项目隔离、项目卡片预览、重命名、删除和自动保存。
- 外部图片拖拽、粘贴、节点拖动、四角缩放、画布缩放和平移。
- 左侧 Prompt 面板和图片内联 Prompt 的双入口模型选择。
- 模型能力过滤、模型分组菜单、模型价格和操作价格展示。
- 工具栏放大、去背景、下载、Magic edit、保存素材、复制、删除和框选编辑确认。
- 批量导入、批量失败策略、暂停/恢复/重试/取消和历史写入。
- 工作流节点创建、端口连线、多图参考、执行计划、链式运行和 Final 交付。
- History 缩略图网格、筛选、项目跳转、团队历史导出和设计师历史导出。
- Profile 额度余额、额度上限、已用额度、模型价格和操作价格。
- 管理员后台调额度、设置额度上限、注册模型、配置模型/操作价格、Provider 配置、审计和用量统计。
- 后端额度扣减、重复提交保护、权限边界、账号隔离、provider 错误和存储持久化。

## 下一阶段

- 接入真实 provider adapter，例如 GPT Image、Nano Banana、RunningHub、ComfyUI 和公司内部模型。
- 继续复用 GitHub 上成熟的无限画布、节点编辑器、图片标注、素材管理和工作流模块。
- 扩展图片工具栏操作，例如裁剪、局部重绘、变体对比、Mockup、矢量化和导出规范。
- 增强团队素材库、项目权限、搜索、标签、审计和大项目性能。
