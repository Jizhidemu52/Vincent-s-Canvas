# 聊天与画布助手真实 UI 验收

验收时间：2026-10-25（Asia/Shanghai）。入口为 `http://127.0.0.1:5188`，后端为 `http://127.0.0.1:3100`。使用独立 Chrome 会话与新建测试画布，无网络 mock、无服务重启、无模型绑定改动、无既有用户画布改动。

## 结果

四个案例各提交一次图片任务，共 **4 次新图片生成、4 张成功结果、4 项主要视觉目标通过**。第二轮续改的实际输入均是上一轮生成结果，原始字节 SHA-256 一致，未退回初始素材。下载失败案例的原任务恢复按钮已修复，并在原画布完成真实查询和结果插入复验，没有追加图片生成。协议成功不等于视觉验收通过：本次另行逐图检查了颜色、文字、可见结构与构图；未做严格像素不变或蒙版外不变验收。

| 案例 | 真实入口与操作 | 视觉结果 | UI 结果 |
| --- | --- | --- | --- |
| chat-1 | `creative-chat`，浅蓝衬衫改鼠尾草绿 | 通过；短袖、尖领、五颗主体纽扣、白底保留，有轻微面料/领口重绘 | 通过 |
| chat-2 | `creative-chat`，继续上一张绿色图，在画面右上胸添加 `INCHOICE` | 通过；8 个字母准确、位置正确、保留绿色与主体 | 通过 |
| canvas-1 | `canvas-assistant`，棕褐款式图改海军蓝 | 通过；米白双领片、右胸袋、五颗纽扣、米白背景保留，线条轻微重绘 | 通过 |
| canvas-2 | `canvas-assistant`，继续上一张蓝色图，在右胸袋添加 `STUDIO`，明确取消上一轮禁止文字 | 通过；6 个字母准确、口袋居中、未退回棕褐色 | 首次下载失败且缺少查询按钮；同任务 API 恢复后，按钮修复及真实 UI 查询/结果插入复验通过 |

实际模型：图片 `APIMart / gpt-image-2`（公开显示名 `aplmart-gpt2`，配置 ID `d5000000-0000-4000-8000-000000000007`）；对话 `APIMart / claude-sonnet-5-5`（配置 ID `d5000000-0000-4000-8000-000000000010`）。当前 `/api/models`、任务字段与本地 Demo 映射共同支持此判断。

## 调用与费用边界

- 新图片任务：4 次；各案例 1 张，未追加重生成。
- 对话 profile 请求：6 次（各案例依次为 1、2、2、1）；其中包含观察结果后的对话续接。
- 配置节点手动优化：2 次；均未随后提交图片生成。
- 原任务恢复：1 次，任务 ID 和 upstream ID 未改变，没有新建图片任务。
- 实际提供商费用：**未知（JSON 为 `null`）**。Demo 返回 `credits=0` 不能解释为免费，未取得可对账账单。

## 下载失败与恢复证据

案例 `canvas-2` 的任务 `45e23f0b-0bb8-4224-ba87-d2aea68ff75a`，上游为 `task_01M5QGCTEMF1Q5YJ17627VMDKJ`。首次查询得到 `paused / failed`，原因是上游已经生成、下载暂时失败；界面提示可以查询原任务，但实际按钮树没有“查询原任务”按钮。后续代码定位发现展示脱敏副本去掉了 `pendingTask`，按钮误读该副本；原始会话记录仍保留恢复信息，无需迁移原始消息。该根因由修复方代码核查提供，首次 UI 检查本身仅证明按钮缺失。

经授权仅调用一次该任务的 `/recover`，最终同一任务变为 `success / succeeded`，取回原上游图片。此时原聊天界面仍停留在错误提示，没有自动插入结果节点；因此先将 API 恢复与 UI 恢复分别记录。

修复后，在同一原画布刷新并切回网站 Agent，原消息出现“查询原任务”按钮。单击一次后，浏览器新增请求 `1249`：仅 `GET /api/tasks/45e23f0b-0bb8-4224-ba87-d2aea68ff75a`，响应仍为同一任务和 upstream。消息更新为“已取回原任务结果并放入画布，没有重新生成”，画布图片节点由 2 个变为 3 个；新节点 blob SHA-256 为 `622a8c05b396c12393d835614722f60a159bfcee2c51b4651fb013485af86a28`，与之前取得的原结果一致，1254 × 1254、1,354,528 字节。复验没有新增 `POST /api/tasks`、`POST /api/chat/responses` 或恢复 POST。

保留 [首次失败界面](chat-live-ui/canvas-2-download-failed-ui.png) 和 [修复后真实回收界面](chat-live-ui/canvas-2-recovered-ui.png)。边界：该任务此前已由获准 API 恢复成功，本次 UI 覆盖原消息查询入口、同任务结果回收和节点插入，没有再次触发暂停任务下载。另有一条独立的旧错误说明消息仍留在历史中；实际结果消息已更新，此残留不影响节点插入。

## 附加验收

| 项目 | 结果与范围 |
| --- | --- |
| 配置节点优化 1 | 真实上传 `garment.png`，提交暖米白改色描述；编译 `bb986812-0365-4466-b4a4-9d3353790b29` 成功，编辑框完整文本与响应一致；未生成图片 |
| 配置节点优化 2 | 移除旧参考、改用 `source-shirt.png` 并整体替换用户描述；编译 `ba775e52-a9ca-4d25-be58-341d66a14efe` 成功，编辑框完整文本与响应一致；未生成图片 |
| 批量改图 | 真实打开批量弹窗，“批量统一优化提示词”默认关闭；未执行批量生成 |
| 画布 ZIP | 经界面导出，递归扫描全部 JSON（包括撤销历史）；用户输入、最终提示词、两个 compilation ID 保留，未发现私有规则、原始模型响应或凭据字段；两份源图字节 hash 与原素材一致 |

ZIP 检查字段包括 `systemPrompt`、`system_prompt`、`fieldTemplate`、`modelOverrides`、`fallbackPrompt`、`rawResponse`、`inputSnapshot`、`rulesText`、`apiKey`、`api_key`、`providerApiKey`、`authorization`。结果仅证明本次导出物中未发现这些字段，不扩大为所有历史数据或任意字段名的证明。

## 文件

- [完整机器可读报告](chat-live-ui-report.json)：每例用户原文、实际完整提示词、任务 ID、upstream ID、引用顺序、素材与结果 SHA-256、模型、调用数量、补充请求与响应。
- 四张原始结果：[chat-1](chat-live-ui/chat-1.png)、[chat-2](chat-live-ui/chat-2.png)、[canvas-1](chat-live-ui/canvas-1.png)、[canvas-2](chat-live-ui/canvas-2.png)。均为 PNG，1254 × 1254，未转码或修改。
- 界面证据：[chat-1](chat-live-ui/chat-1-ui.png)、[chat-2](chat-live-ui/chat-2-ui.png)、[canvas-1](chat-live-ui/canvas-1-ui.png)、[canvas-2 首次失败](chat-live-ui/canvas-2-download-failed-ui.png)、[canvas-2 修复后回收](chat-live-ui/canvas-2-recovered-ui.png)。
- 补充证据：[优化 1](chat-live-ui/config-optimize-1-ui.png)、[优化 2](chat-live-ui/config-optimize-2-ui.png)、[批量默认关闭](chat-live-ui/batch-default-off-ui.png)、[真实导出 ZIP](chat-live-ui/config-node-export.zip)。

## 其他观察与限制

`canvas-2` 最终提示词已正确撤销旧的禁止文字约束，但仍携带上一轮“棕褐色改海军蓝”要求；同文另有保持当前海军蓝、不得退回棕褐色的约束。这是冗余历史改色指令，本次图片没有回退，完整原文已保留，不因视觉通过而省略。

Demo 的 `/api/tasks/events` 返回 404，客户端回退 GET 轮询仍取得任务成功结果。新建画布默认指向未运行的本机 Agent，本次通过该独立画布的界面切换为网站 Agent，未启动或重启服务。

本次仅覆盖上述真实路径与主目标，不证明严格局部编辑保真、完整生产工艺准确性或所有故障类型。原下载失败及缺少恢复按钮作为独立负面证据保留，不被最终成功图覆盖。
