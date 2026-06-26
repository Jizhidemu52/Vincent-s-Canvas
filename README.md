# Vincent-s-Canvas

公司内部设计师用的无限画布图片工作台。目标是把项目管理、图片生成、参考图、批量处理、工作流节点、素材沉淀、历史记录、设计师账号额度和后台监控放在同一个受控系统里。

![Vincent Canvas workbench](docs/assets/canvas-workbench.png)

## 当前已实现

- 登录后先进入用户端首页，不会直接显示画布。
- `Projects` 支持新建任务，每个任务进入独立无限画布。
- `Profile` 展示设计师姓名、账号角色、剩余额度和消耗记录。
- `History` 展示历史出图记录、模型、消耗额度、项目来源和生成图缩略图。
- 项目画布采用 Recraft 风格布局：顶部工具栏、左侧 `IMAGE`/Prompt 卡片、中央无限画布、右侧 Context/History/Assets/Prompts/Assistant。
- 画布支持拖拽导入图片、粘贴图片、节点自由拖动、缩放、复制、删除、撤销/重做、滚轮缩放、小地图。
- 图片节点支持双击后在图片下方直接输入 Prompt、选择模型并生成。
- 左侧面板也支持选择模型、填写 Prompt、选择出图数量并生成，提供双入口模型选择。
- 图片旁工具栏支持放大、去背景、框选编辑、保存素材、下载、Magic edit。
- 框选编辑会弹出确认窗口，选择 rectangle/ellipse/freehand 并确认后，结果图会放到原图旁边，可继续新一轮编辑。
- 批量模式支持导入文件夹或示例批处理，按同一 Prompt 逐张处理并把结果放回画布。
- 工作流模式支持从图片右侧端口拉出模块选择器，选择 Generate/Edit/Upscale/Remove BG/Upload-ref 后自动创建节点并连线。
- 多图参考支持把两张或多张图片合并成 reference group，再连到一个生成节点。
- 生成结果会自动进入右侧 `Assets` 素材库，素材可以再次点击插回画布继续使用。
- 后端托管模型接口，前端只传模型 id 和参数，不保存真实 API key。
- 管理员后台支持 provider 健康状态、审计记录、用量统计和设计师额度调整。

## Key files

- `src/App.tsx`：用户端首页、项目页、Recraft 风格画布、节点 UI、工具栏、右侧 Dock、Admin UI。
- `src/domain/workspace.ts`：无限画布领域模型、节点、连线、批量、工作流、多图参考、撤销重做、素材保存。
- `src/services/modelApi.ts`：前端调用后端模型/工作区/额度 API。
- `server/api.ts`：后端模型路由、账号额度、历史、管理员审计和 provider 状态。
- `server/http.ts`：本地 HTTP API server。
- `src/App.test.tsx`、`src/domain/workspace.test.ts`、`server/*.test.ts`：业务路径测试。

## Run

Install dependencies once:

```bash
npm install
```

Start the backend-hosted model API:

```bash
npm run api
```

Start the Vite client in another terminal:

```bash
npm run dev
```

Then open the Vite URL, usually `http://127.0.0.1:5173/`.

## Backend API

The browser UI should never store provider API keys. Model calls are routed through the server layer:

- `GET /api/models`
- `GET /api/profile`
- `GET /api/history`
- `GET /api/admin/audit`
- `GET /api/admin/usage`
- `GET /api/admin/providers`
- `POST /api/admin/credits`
- `POST /api/generations`
- `POST /api/edits`
- `POST /api/upscale`
- `POST /api/remove-bg`

Write endpoints accept a `GenerationRequest` body and optional `x-request-id` header for duplicate-submit protection. The mock adapter returns the same `GenerationResult` shape that real GPT Image, NanoBanana2, RunningHub, ComfyUI, or internal model adapters should return later.

## Verification

```bash
npm test -- --run
npm run build
```

The current tests cover project creation, entering the canvas only after a project is created, image upload/import, model and prompt controls, inline image prompting, toolbar operations, mask edit confirmation, target frame creation, batch processing, workflow module chains, asset reuse, profile/history views, backend credits, duplicate request protection, account isolation, provider adapters and admin credit adjustments.
