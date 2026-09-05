# 图片参数与接口文档核对

核对日期：2026-09-06。依据下列渠道的实时请求参数表，不使用搜索摘要中的旧规格；相同模型名不代表不同渠道参数相同。

## 当前入口

| 工作台名称 / API 标识 | 渠道 | 已接入的参数与限制 |
| --- | --- | --- |
| open gpt2 / `gpt-image-2` | OpenToken Images | 画质 `auto/low/medium/high`；界面提供文生图和编辑共同列明的 `1024x1024/1536x1024/1024x1536`；PNG 默认输出。 |
| gemini / `gemini-3.1-flash-image` | 现有 OpenToken 图片兼容入口 | 对应参数文档未确认。保留原模型与调用入口，不换为其他模型；不额外提交尺寸和画质，不显示未确认选项。 |
| vcen-gpt2 / 上游 `gpt-image-2` | APIMart | 分辨率 `1k/2k/4k`；15 种比例、`auto` 或像素尺寸；最多 15 张参考图，单张 20 MB、总计 256 MB。 |
| Nano banana2 / `gemini-3.1-flash-image-preview` | APIMart | 分辨率 `0.5K/1K/2K/4K`；14 种明确列出的比例及 `auto`；最多 14 张 JPEG/PNG/WebP 参考图，单张 10 MB。 |
| Midjourney / `midjourney` | APIMart Imagine | 提示词、自由比例、`relax/fast/turbo`；支持参考图引导。原生 MJ 参数可以写入提示词；不再擅自强制版本 6.1。 |
| Midjourney Blend / `midjourney-blend` | APIMart Blend | 2–4 张参考图，单张 12 MiB；自由比例或三种预设；`relax/fast/turbo`，默认 relax；不接受提示词，不提供版本参数。 |

对应来源：[OpenToken 文生图](https://docs.opentoken.io/api/openai/image-generation/)、[OpenToken 图片编辑](https://docs.opentoken.io/api/openai/image-edit/)、[APIMart GPT](https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation)、[APIMart Gemini](https://docs.apimart.ai/en/api-reference/images/gemini-3.1-flash/generation)、[Imagine](https://docs.apimart.ai/en/api-reference/images/midjourney/imagine)、[Blend](https://docs.apimart.ai/en/api-reference/images/midjourney/blend)。

## 比例不能跨模型套用

- APIMart GPT：`1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 2:1, 1:2, 3:1, 1:3, 21:9, 9:21`，另有 `auto`。
- APIMart Gemini：`1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 21:9, 1:4, 4:1, 1:8, 8:1`，另有 `auto`。
- GPT 自定义像素保持输入值；“16倍数对齐”是软件可选输入辅助，默认关闭，不是渠道要求。文档示例 `1881x836` 不应自动改成另一尺寸。
- Midjourney 接口接受自由 `w:h`；界面只列常用比例。提示词与结构化 `size` 同时出现时，按渠道文档由结构化字段优先。

## “批量张数”不是上游 n

工作台的 1–10 张是软件的批量上限，不是宣称某模型支持 `n=10`。前端将其拆成独立任务，每个上游请求均为 `n=1`，各自提交和计费。Midjourney 当前界面提交一个任务，返回图片布局由渠道决定。

APIMart GPT 当前参数表写 `n=1`，而同页仍有旧 `n=2` 示例；Gemini 搜索摘要曾写 1–4，实时参数表现为 1。此处统一遵守实时参数表，并在前后端测试中固定单任务 `n=1`。

## 未接入或未确认的范围

- OpenToken 文生图页面另列 `2048x2048/auto`，编辑页面没有同时列出；当前共用界面使用三个明确的共同尺寸，避免选中后因编辑模式而失效。输出格式、背景等文档字段未全部开放为界面控件，保留当前默认值，不表示模型没有这些能力。
- OpenToken 的[原生 Gemini 文档](https://docs.opentoken.io/api/gemini/generate-content/)用 `gemini-3.1-flash-image` 演示图像理解，生图示例则使用 `gemini-3.1-flash-image-preview` 及 `generationConfig.imageConfig`。这不能证明现有非 preview 图片兼容入口支持同样参数。用户暂时没有其单独文档，因此不擅自替换模型。
- APIMart Gemini 的联网搜索、官方回退、Midjourney 的更多原生字段并未全部做成图形控件。已接入字段会真实传给上游；未接入的字段不显示虚假开关。
- Imagine 的 16 张限制是当前工作台的参考图处理上限，官方该页未列数量上限；不能把软件限制说成模型限制。

## 验证边界

参数组合、渠道映射、参考图上限、单图任务拆分、前后端请求体由本地测试核对；本轮未为核对参数额外发起收费生成。文档支持某字段不等于特定账户、渠道当前一定能成功调用，真实请求错误仍需保留并提示用户。
