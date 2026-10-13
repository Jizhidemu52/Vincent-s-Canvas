# 图片参数与接口文档核对

依据下列渠道的请求参数表；相同模型名不代表不同渠道参数相同。参数按实际 Provider 协议及公开能力标识选择，不用营销名称猜测。

## 当前入口

| 工作台名称 / API 标识 | 渠道 | 已接入的参数与限制 |
| --- | --- | --- |
| `gpt-image-2` | OpenToken Images | 画质 `auto/low/medium/high`；1K/2K/4K 像素预设、自适应和合规自定义尺寸；背景、PNG/JPEG/WebP、输出压缩质量。 |
| `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst` | OpenToken Images | 同上，另有 `xhigh/max`；Flare 速度优先，Sunburst 质量优先。新建配置默认 Sunburst＋high，不覆盖已保存选择或历史参数。 |
| gemini / `gemini-3.1-flash-image` | 现有 OpenToken 图片兼容入口 | 对应参数文档未确认。保留原模型与调用入口，不换为其他模型；不额外提交尺寸和画质，不显示未确认选项。 |
| vcen-gpt2 / 上游 `gpt-image-2` | APIMart | 分辨率 `1k/2k/4k`；15 种比例、`auto` 或像素尺寸；官方回退与提交前内容检查；最多 15 张参考图，单张 20 MB、总计 256 MB。 |
| Nano banana2 / `gemini-3.1-flash-image-preview` | APIMart | 分辨率 `0.5K/1K/2K/4K`；14 种明确列出的比例及 `auto`；Google 文本/图片搜索、官方回退、提交前内容检查；最多 14 张 JPEG/PNG/WebP 参考图，单张 10 MB。官方版不传回退字段。 |
| Midjourney / `midjourney` | APIMart Imagine | 自由比例、`relax/fast/turbo`；高级面板提供 quality、version、style、seed、negative_prompt、stylize、chaos、weird、tile、niji、iw/cw/sw、cref/sref/dref/dw、repeat、raw、draft、hd、stop、extra、metadata、nsfw_check。字段按渠道契约透传，具体版本支持仍以上游为准，不强制版本。 |
| Midjourney Blend / `midjourney-blend` | APIMart Blend | 2–4 张参考图，单张 12 MiB；自由比例或三种 dimensions 预设；`relax/fast/turbo`；metadata、nsfw_check。不接受提示词，不提供 Imagine 专属字段。 |

对应来源：[OpenToken 文生图](https://docs.opentoken.io/api/openai/image-generation/)、[OpenToken 图片编辑](https://docs.opentoken.io/api/openai/image-edit/)、[APIMart GPT](https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation)、[APIMart Gemini](https://docs.apimart.ai/en/api-reference/images/gemini-3.1-flash/generation)、[Imagine](https://docs.apimart.ai/en/api-reference/images/midjourney/imagine)、[Blend](https://docs.apimart.ai/en/api-reference/images/midjourney/blend)。

## 比例不能跨模型套用

- APIMart GPT：`1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 2:1, 1:2, 3:1, 1:3, 21:9, 9:21`，另有 `auto`。
- APIMart Gemini：`1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 21:9, 1:4, 4:1, 1:8, 8:1`，另有 `auto`。
- APIMart GPT 自定义像素保持输入值；“16倍数对齐”是软件可选输入辅助，默认关闭，不是该渠道要求。文档示例 `1881x836` 不应自动改成另一尺寸。
- OpenToken GPT 2 / 2.5 的宽高须为 16 的倍数，单边不超过 3840，长短边比例不超过 3:1，总像素在 655360–8294400 之间。超过 3686400 像素的输出属于实验尺寸；4K 档方形使用 2880×2880，不伪称 4096×4096 可用。非法值明确拒绝，不回退到 1024。旧比例 16:9/4:3 及倒置按相同比例转为合法像素。
- OpenToken 背景为 auto/opaque/transparent；透明仅支持 PNG/WebP。压缩质量是 0–100 整数，仅 JPEG/WebP 提交，PNG 无损不传。画质与分辨率分开设置，高档位不保证每次视觉效果更好。
- Midjourney 接口接受自由 `w:h`；界面只列常用比例。提示词与结构化 `size` 同时出现时，按渠道文档由结构化字段优先。

## “批量张数”不是上游 n

工作台的 1–10 张是软件的批量上限，不是宣称某模型支持 `n=10`。前端将其拆成独立任务，每个上游请求均为 `n=1`，各自提交和计费。Midjourney 当前界面提交一个任务，返回图片布局由渠道决定。

APIMart GPT 当前参数表写 `n=1`，而同页仍有旧 `n=2` 示例；Gemini 搜索摘要曾写 1–4，实时参数表现为 1。此处统一遵守实时参数表，并在前后端测试中固定单任务 `n=1`。

## 编辑与输入归档

- 蒙版从归档中的 `maskReferenceIndex` 定位，独立传入 Images Edits 的 `mask`，不计入普通 image 参考序列；Worker 与演示服务一致。提交前使用已部署的 ffprobe 验证 PNG 解码、alpha、大小和与第一张原图尺寸一致；不支持蒙版的模型/协议显式报错，不假装接受。
- 节点改图将当前原图固定为图片1，附加图从图片2起。托盘、@提及、画布编号和实际提交共用同一有序列表；原图不可删除或移动，数量上限包含原图。底部创建面板保持自行选择的完整参考顺序。
- 高级参数与基础参数一起保存到生成输入归档、节点元数据和草稿；恢复不替换模型或发起生成。批量编辑同样提交当前参数。

## 未接入或未确认的范围

- 没有为 OpenToken Images 文档未列出的 moderation、stream、input_fidelity 等字段增加假开关；GPT Image 2 的 input_fidelity 按官方要求省略。模型、提示词、参考文件由现有入口提供，n 固定为独立单图任务，不把鉴权或传输字段做成生成参数。
- OpenToken 的[原生 Gemini 文档](https://docs.opentoken.io/api/gemini/generate-content/)用 `gemini-3.1-flash-image` 演示图像理解，生图示例则使用 `gemini-3.1-flash-image-preview` 及 `generationConfig.imageConfig`。这不能证明现有非 preview 图片兼容入口支持同样参数。用户暂时没有其单独文档，因此不擅自替换模型。
- APIMart 参数适配保留，但本次不重新启用已停用渠道、不新增模型、不修改任何线上凭据。Midjourney repeat 会增加任务与费用，版本不支持的字段由上游报错，不自动换版本。
- Imagine 的 16 张限制是当前工作台的参考图处理上限，官方该页未列数量上限；不能把软件限制说成模型限制。

## 验证边界

参数组合、渠道映射、参考图上限、单图任务拆分、前后端请求体由本地测试核对；本轮未为核对参数额外发起收费生成。文档支持某字段不等于特定账户、渠道当前一定能成功调用，真实请求错误仍需保留并提示用户。
