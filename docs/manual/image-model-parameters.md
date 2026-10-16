# 图片参数与接口文档核对

依据下列渠道的请求参数表；相同模型名不代表不同渠道参数相同。参数按实际 Provider 协议及公开能力标识选择，不用营销名称猜测。

## 当前入口

| 工作台名称 / API 标识 | 渠道 | 已接入的参数与限制 |
| --- | --- | --- |
| `gpt-image-2` | OpenToken Images | 画质 `auto/low/medium/high`；1K/2K/4K 像素预设、自适应和合规自定义尺寸；背景、PNG/JPEG/WebP、输出压缩质量。 |
| `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | OpenToken Images | 同上，另有 `xhigh/max`；Flare 速度优先，Sunburst 质量优先；不是当前新建配置的默认模型。 |
| `aplmart-gpt2.5-flare` / `aplmart-gpt2.5-sunburst` | Mark 独立 APIMart 通道 | 上游同名 GPT2.5；独立的分辨率 `1k/2k/4k` 与画质 `auto/low/medium/high/xhigh/max`；15 种比例、`auto` 或合规像素尺寸；最多 16 张参考图，PNG 独立蒙版；背景、输出格式和压缩质量。 |
| `aplmart-nano2.1` | Mark 独立 APIMart 通道 | 上游 `gemini-nano-banana-2.1` 官方版，不是旧 Gemini 别名；仅 `1K/2K/4K`，无独立画质、0.5K、蒙版或 GPT 格式参数；参考图工作台上限 16 张，不宣称这是平台限制。 |
| `aplmart-nano2` | 独立 APIMart 通道 | 上游 `gemini-3.1-flash-image-preview-official`，与 Nano2.1 独立；0.5K/1K/2K/4K、14 种比例及 auto，最多 14 张 JPEG/PNG/WebP 参考图、单张 10 MiB；支持 Google 搜索设置，不提供独立 quality、蒙版或 official_fallback。 |
| `aplmart-gpt2` | 独立 APIMart 通道 | 普通 `gpt-image-2`，不是 Ext；1K/2K/4K 分辨率、15 种比例、auto 或精确像素，最多 15 张参考图。不提供 GPT2.5 的独立 quality、输出格式或蒙版选项。 |
| `aplmart-grok2` | 独立 APIMart 通道 | 默认关闭，可由超级管理员单独启用。官方 `grok-imagine-image-2.0`；1K/2K、14 种比例，0–3 张 JPEG/PNG/WebP 参考图，单张 10 MiB。low/medium 画质仅无参考图时生效；有参考图时隐藏且不提交 quality。不支持蒙版。 |
| gemini / `gemini-3.1-flash-image` | 现有 OpenToken 图片兼容入口 | 对应参数文档未确认。保留原模型与调用入口，不换为其他模型；不额外提交尺寸和画质，不显示未确认选项。 |
| vcen-gpt2 / 上游 `gpt-image-2` | APIMart | 分辨率 `1k/2k/4k`；15 种比例、`auto` 或像素尺寸；官方回退与提交前内容检查；最多 15 张参考图，单张 20 MB、总计 256 MB。 |
| Nano banana2 / `gemini-3.1-flash-image-preview` | APIMart | 分辨率 `0.5K/1K/2K/4K`；14 种明确列出的比例及 `auto`；Google 文本/图片搜索、官方回退、提交前内容检查；最多 14 张 JPEG/PNG/WebP 参考图，单张 10 MB。官方版不传回退字段。 |
| Midjourney / `midjourney` | APIMart Imagine | 自由比例、`relax/fast/turbo`；高级面板提供 quality、version、style、seed、negative_prompt、stylize、chaos、weird、tile、niji、iw/cw/sw、cref/sref/dref/dw、raw、draft、hd、stop、extra、metadata、nsfw_check。重复生成字段及命令被禁止；其余字段按渠道契约透传，具体版本支持仍以上游为准，不强制版本。 |
| `aplmart-mj-blend` / `midjourney-blend` | APIMart Blend | 独立“MJ 多图融合”入口与画布配置；2–4 张参考图，单张 12 MiB；自由比例或三种 dimensions 预设；`relax/fast/turbo`；metadata、nsfw_check。不接受提示词，不提供 Imagine 专属字段；每次一个任务。 |

新配置的默认选择为 APIMart 公共别名 `aplmart-gpt2`，加载服务端目录后解析到该通道的独立配置 UUID；有效的已保存选择优先，不覆盖历史参数。该模型不可用时只从当前入口兼容的可用模型回退，不按同名上游 ID 混用 OpenToken 通道。参数按所选模型归一：普通 APIMart GPT2 使用 1K／2K／4K 分辨率，没有 GPT2.5 的独立 `high` 画质选项。

对应来源：[OpenToken 文生图](https://docs.opentoken.io/api/openai/image-generation/)、[OpenToken 图片编辑](https://docs.opentoken.io/api/openai/image-edit/)、[APIMart GPT](https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation)、[APIMart Gemini](https://docs.apimart.ai/en/api-reference/images/gemini-3.1-flash/generation)、[Imagine](https://docs.apimart.ai/en/api-reference/images/midjourney/imagine)、[Blend](https://docs.apimart.ai/en/api-reference/images/midjourney/blend)。

## 比例不能跨模型套用

- APIMart GPT：`1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 2:1, 1:2, 3:1, 1:3, 21:9, 9:21`，另有 `auto`。
- APIMart Gemini：`1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 21:9, 1:4, 4:1, 1:8, 8:1`，另有 `auto`。
- 旧 APIMart GPT-Image-2 自定义像素保持输入值；“16倍数对齐”是该旧模型的软件可选输入辅助，默认关闭，不是其渠道要求。文档示例 `1881x836` 不应自动改成另一尺寸。Mark GPT2.5 是另一套合同，宽高必须为 16 的倍数、单边不超过 3840、长短比不超过 3:1、总像素 655360–8294400。
- OpenToken GPT 2 / 2.5 的宽高须为 16 的倍数，单边不超过 3840，长短边比例不超过 3:1，总像素在 655360–8294400 之间。超过 3686400 像素的输出属于实验尺寸；4K 档方形使用 2880×2880，不伪称 4096×4096 可用。非法值明确拒绝，不回退到 1024。旧比例 16:9/4:3 及倒置按相同比例转为合法像素。
- OpenToken 背景为 auto/opaque/transparent；透明仅支持 PNG/WebP。压缩质量是 0–100 整数，仅 JPEG/WebP 提交，PNG 无损不传。画质与分辨率分开设置，高档位不保证每次视觉效果更好。
- Midjourney 接口接受自由 `w:h`；界面只列常用比例。提示词与结构化 `size` 同时出现时，按渠道文档由结构化字段优先。

## 所有图片入口固定单张

两套 API 的所有图片入口每次只创建一个单图任务，`n=1`、`count=1`，不再提供张数选择。包括独立工作台、聊天、画布、批量编辑和系列配方；批量编辑一次只接受一张待编辑原图，系列配方一次只执行一条候选分支。多参考图用于同一张结果的设计输入，不等于多图输出。可以再次主动发起独立任务，并发上限仍按后台配置，不限制为并发 1。

旧草稿或模板中保存的多张数量会在新提交时归一为 1；旧任务结果和历史记录不删除、不重写。服务端同样执行单张校验，不能通过直接调用批量接口一次提交多项。Midjourney 的一次任务返回布局仍由渠道决定，不将多宫格冒称多次独立生成；不提供自动 repeat。

自定义图片工作流在最终发送前也校验单张契约：明确的 `n/count/quantity` 固定为 1，重复命令、冲突的嵌套数量、多请求模板或无法确认单张输出的图形工作流会在调用前报错，请管理员配置已验证的单图模板。内置 GPT 模板与单输入无缝拼接协议仍可用。此约束不修改视频、文字、音频工作流及已提交任务的查询恢复。

## APIMart 独立后台入口

1. 正式服务以超级管理员登录 `/admin?tab=mark-images`，打开“APIMart 平台”。单机演示服务不开放真实管理员凭据写入；本机由服务端环境变量 `MARK_IMAGE_API_KEY` 和 `MARK_IMAGE_BASE_URL` 配置，不在浏览器保存密钥。
2. 默认 API Base URL 为 `https://api.apimart.ai/v1`。用户提供的 APIB 文档页使用这个调用地址；并不是把 `docs.apib.ai` 当作 API 主机。
3. 首次填写 API Key，设置通道与 10 款模型启用状态后保存：6 款普通图片、1 款 MJ Blend、2 款文字 `aplmart-gpt6-astra`／`aplmart-claude-sonnet-5-5`、1 款视频 `aplmart-happyhorse1.1`。图片／视频费用与并发按界面配置；文字模型此处只配置接入与开关，对话积分在“板块 API 配置”设置并受积分总开关控制，文字并发限制尚未执行。Grok2 新配置默认关闭，其他预置模型默认开启；逐个开关可单独保存，已保存的人工选择不会被默认值覆盖。显示名前缀按用户要求为 `aplmart-`，上游 API 模型 ID 不改写。密钥在服务端加密，浏览器不持久化、不回显。之后留空保留；更换地址须重新填写对应密钥。内部成本为 0 不代表供应商免费。
4. 这 10 款仅属于本次独立平台，不包括另一 API 原有模型；全部使用独立配置 UUID 路由，不覆盖 OpenToken 或旧 APIMart 的同名模型、密钥或历史。可在“板块 API 配置”为相应工具绑定；未绑定的工具由用户选择。保存通道不会解除现有后台指定模型或自动切换它们。MJ 多图融合的后台绑定和服务端执行只接受 Blend。
5. 切到 Mark GPT2.5 时，分别选择“清晰度 / 分辨率”和“图片质量”；Nano2.1 只显示支持的分辨率。公共工作台、画布与独立聊天的出图设置均按模型切换，不将 GPT 专属字段带给 Nano。
6. 模型后显示简短用途，普通 GPT2 为“日常最通用模型”；Nano2 为“日常改款与多图参考”，Nano2.1 为“复杂材质与多参考改图”。用途仅帮助选择，不是效果保证。

GPT2.5、Nano2.1 采用异步 JSON：上传本地参考图到 `/uploads/images`（该上传接口单张最大 20 MB，模型若更小则先执行其限制），随后 POST `/images/generations`，持久保存 `task_id`，再 GET `/tasks/{id}`。GPT2.5 的独立 PNG 蒙版以 `mask_url` 提交；不调用 OpenToken 的 multipart `/images/edits`。Blend 使用 `/midjourney/generations/blend`；Grok 按其官方版本头与持久化任务 UUID 的幂等键提交，并兼容 `202` 响应的 `data.id`。已知任务查询失败可恢复同一编号；提交结果不明时暂停，不自动重复收费。成品按实际字节保存，临时供应商结果链接不作为永久存储。

GPT-6 Astra 使用该平台 `/responses`，支持文字、图像输入与工具调用；保留原生 reasoning／function_call 项以便后续对话。真实测试中该平台的 `/chat/completions` 对 `reasoning_effort` 返回相互矛盾的限制，已选择验证通过的 Responses 路径，不做失败后自动重发或偷偷切换模型。

Claude Sonnet 5.5 使用原生 `/v1/messages`，以文字模型能力归组，不因型号不同从后台漏掉。对话按成功的模型调用结算站内积分，工具续答可能产生多次调用；失败、未完成响应或连接中断不当作成功，图片生成另按图片板块计费。协议与本地计费测试不等于供应商费用、全部模型参数或生成质量已经验收。

HappyHorse 1.1 支持 3–15 秒、720P／1080P、文生视频、首帧和多图参考，参数按对应供应商型号展示，提交仍使用独立配置 UUID；视频上传、提交、查询和恢复均使用 Mark 凭据，不借用旧 APIMart 密钥。当前模型没有音频参考或音频开关，不显示这些不支持的控件。

接口来源：[APIB GPT2.5](https://docs.apib.ai/cn/api-reference/images/gpt-image-2.5/generation)、[APIB Nano2.1](https://docs.apib.ai/cn/api-reference/images/gemini-nano-banana-2.1/generation)、[APIMart 图片上传](https://docs.apimart.ai/cn/api-reference/uploads/images)、[任务查询](https://docs.apimart.ai/cn/api-reference/tasks/status)、[Responses](https://docs.apimart.ai/cn/api-reference/texts/openai/responses)。实际付费与视觉结果分别记录：接口成功不等于按钮数量、角度、图案几何或局部改动范围完全合格。

## 编辑与输入归档

- 蒙版从归档中的 `maskReferenceIndex` 定位，独立传入 Images Edits 的 `mask`，不计入普通 image 参考序列；Worker 与演示服务一致。提交前使用已部署的 ffprobe 验证 PNG 解码、alpha、大小和与第一张原图尺寸一致；不支持蒙版的模型/协议显式报错，不假装接受。
- 独立字段提交正确不保证模型严格遵循边界。Flare 的真实矩形蒙版测试出现蒙版外左袖、左领和整片左衣身一起改色；蒙版 alpha 与请求字节均核对正确，该样本的严格局部编辑未通过，尚不能区分渠道忽略蒙版与模型越界。
- 应用现在另外执行服务端严格合成：原件先存档，再按蒙版 alpha 将结果合回第一张原图，保存无损 PNG 主图。保护区保留原图解码 RGBA，选区使用模型结果，半透明边缘混合。严格路径限定 8 位、单边 8192 以内且总像素不超过 16777216；返回尺寸不符不拉伸，任务暂停且原件可取。该后处理不是渠道原生蒙版能力通过，也不承诺选区内结构或接缝质量。
- 原图/蒙版若含 EXIF 旋转或镜像方向，提交前提示先另存为正常方向 PNG；返回图或普通跨格式转换同样拒绝方向异常，避免删除方向信息后画面翻转。匹配格式且无需重编码时保留原字节和 EXIF。方向探针在本机 ffprobe 8.1.1 验证，目标服务器仍需核对 FFmpeg/ffprobe 版本与运行结果。
- 节点改图将当前原图固定为图片1，附加图从图片2起。托盘、@提及、画布编号和实际提交共用同一有序列表；原图不可删除或移动，数量上限包含原图。底部创建面板保持自行选择的完整参考顺序。
- 高级参数与基础参数一起保存到生成输入归档、节点元数据和草稿；恢复不替换模型或发起生成。批量编辑同样提交当前参数。

## 未接入或未确认的范围

- 没有为 OpenToken Images 文档未列出的 moderation、stream、input_fidelity 等字段增加假开关；GPT Image 2 的 input_fidelity 按官方要求省略。模型、提示词、参考文件由现有入口提供，n 固定为独立单图任务，不把鉴权或传输字段做成生成参数。
- OpenToken 的[原生 Gemini 文档](https://docs.opentoken.io/api/gemini/generate-content/)用 `gemini-3.1-flash-image` 演示图像理解，生图示例则使用 `gemini-3.1-flash-image-preview` 及 `generationConfig.imageConfig`。这不能证明现有非 preview 图片兼容入口支持同样参数。用户暂时没有其单独文档，因此不擅自替换模型。
- 旧 APIMart 参数适配保留，不自动重新启用已停用渠道；Mark 新增独立配置入口，须由管理员填写凭据后启用。版本不支持的字段由上游报错，不自动换版本。
- Imagine 的 16 张限制是当前工作台的参考图处理上限，官方该页未列数量上限；不能把软件限制说成模型限制。

## 验证边界

### 独立 APIMart 平台

以下真实生成记录来自早期九模型范围，由隔离本机前端、单机服务与实际账户完成，保留任务编号、提交参数、原始结果字节和视觉检查；正式后台另以隔离 SQL 引擎验证该阶段配置、加密、重开库、权限和浏览器保存。不因当前目录增加到十模型而扩大既有付费结论，也不把后续无付费回归算作新增真实调用。后者不是公司 PostgreSQL／Worker／S3 的生产部署验收。

本轮在授权最多 50 次内停止于 50 次上游提交：44 次图片、4 次文字、2 次视频；其中 48 次成功返回、2 次早期文字接口报错。该数字包含失败提交，是预算计数，不是供应商扣款账单。没有等待中的付费任务；页面操作或离线复放记录不额外计费，失败证据不删除。

- 基础生图、细节增强、图片编辑、角度、无缝拼接、九种创意场景、系列配方、聊天出图均完成两种复杂毛衫用例；MJ Blend 另测 2 图与 4 图输入，均只提交一个无提示词任务。普通 GPT2 与 Grok2 各补两种 1K／2K 场景，两个渠道的同名 GPT2 保持独立 UUID，不混用凭据。
- GPT2.5 支持独立分辨率与质量控件；Grok 无参考图发送 quality，参考编辑不发送 quality。真实 2K GPT2 返回 1536×2048，2K Grok 返回 1776×2368，不能把所有平台的“2K”解释为最长边恒等于 2048。GPT 系列及 Blend 原件为 PNG；Nano 与 Grok 部分结果是 JPEG，按实际字节保存。
- 最后新增的 Nano2 Official 完成一例复杂毛衫参考改图，1K 返回实际 1024×1024 JPEG；8 颗钮扣改为海军蓝，绞花、提花与完整款式大体保留。不以单例替代全部参数或生产素材验收。
- GPT-6 Astra 已完成两个 Responses 规划样本，聊天出图结果可用；早期 Chat Completions 的两个错误请求仍计入提交预算，不隐藏失败。一个已付费的规划响应曾因测试驱动取错工具字段被误判，修正后离线原样复放该响应，只新增图片调用，没有重复收费规划。
- HappyHorse1.1 完成首帧与双参考两种 3 秒 720P 请求，返回可播放 MP4；实测 960×960／24fps／约 3.04 秒，720P 是平台档位，不代表方形边长 720。第一例放大过多裁切衣身，第二例主要三分之四视角可用，未展示完整背面。仅确认存在 AAC 音轨，不冒称已做音质验收。
- 视觉失败单独保留：首个毛衫与 Grok 文生图的钮扣数量偏差；部分换色扩散到罗纹／其他色区；指定侧视角、独立花型提取及局部改款未完全满足；无缝图 2×2 拼铺仍有针织轮廓接缝。Blend 是自由多图融合，结果可能只呈现局部，不承诺保留整件款式。这些不是接口或本地单图规则通过就能消除的问题，不靠额外付费重试掩盖。
- 浏览器最终检查覆盖新增模型、画布与独立页、390px 布局、旧 count=3/10 的单图归一、批量多文件上传前拒绝，以及旧系列多候选保留／每次只继续一支；请求被拦截验证，不计为上游付费。资产／模板和本地设计工具另有无付费操作检查；企业权限、员工跨设备和服务器网络仍保留待验收。

### 原 OpenToken 通道

参数组合、渠道映射、参考图上限、单图任务拆分、前后端请求体由本地测试核对。经明确预算授权后，四个现有 OpenToken 模型各完成两次真实单图改色，另测 Flare 2K/xhigh、Sunburst 4K/max、Flare 独立蒙版及 GPT 2 双参考图，共 12 次均返回图片；这不是全部参数组合或生产部署验收。

- Flare 实际返回 2048×2048，Sunburst 实际返回 3840×2160。请求中的 xhigh/max 被接受，但无法由单次成图证明内部质量档位或质量优于 high。
- 两次高分辨率请求分别指定 WebP、JPEG，渠道原件实际均为 PNG；不能把接口成功算作渠道输出格式/压缩参数通过。Gemini 两次默认输出实际为 JPEG。服务端按真实字节识别格式，原件不转码、不覆盖；有明确格式/压缩要求时另外实际编码。严格蒙版主图固定为 PNG，JPEG/WebP 为额外导出副本，有损副本不承诺保护区逐像素一致；JPEG 透明区域铺白。节点下载可选主图、渠道原件及已有格式副本。
- 已有失败样本离线复放验证了严格主图保护区 999176 个像素的 RGBA 差异为 0、原始文件哈希不变，以及 JPEG/WebP 的真实编码；没有新增付费生成。权限、服务重启、单张任务结果和下载字节另有回归，仍需目标部署验收。后处理失败不自动重发模型请求，导出副本失败保留可用 PNG 并提示。
- GPT 2 双参考图样本能按图片1保留衬衫结构、按图片2完成紫红改色，但不代表所有多图复杂指令通过。Flare 蒙版样本的范围限制未通过，见上节。
- 测试从本地调用当前请求构建与输入预处理代码及真实渠道；本地界面和 Worker/Demo 落地另有离线回归，不冒充已部署后的完整线上链路。未实测的透明背景、其他质量/压缩值、Gemini 高级能力与更多业务样本仍待验证。

文档支持某字段不等于特定账户、渠道当前一定能完整执行；真实请求错误、格式偏差及质量限制应如实保留，不自动重发收费任务。
