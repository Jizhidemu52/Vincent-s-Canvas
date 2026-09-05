# 聊天模型参数与接口对应

本文说明当前代码实际发送的参数，不以模型名字推测未接入的能力。后台是否启用、账号是否有该模型权限，仍由实际配置和渠道响应决定。

## Claude 原生接口

ApiMart 的 `/v1/messages` 文档要求按 Anthropic Messages 语义处理请求，返回原生消息对象；工具续轮必须原样保留思考签名，不能只取 `content[0].text`。[ApiMart Claude 接口](https://docs.apimart.ai/en/api-reference/texts/general/claude-messages)

本项目当前配置的 `claude-opus-5`、`claude-sonnet-5`、`claude-fable-5` 使用以下处理：

| 页面设置 | 当前请求行为 |
| --- | --- |
| 流式输出 | 发送 `stream: true`，按 SSE 内容块增量展示文字；关闭后读取普通 JSON |
| 自适应思考 | Opus 5 / Sonnet 5 开启时发送 `thinking.type: adaptive`，关闭时明确发送 `disabled` |
| Fable 5 | 始终使用 `adaptive`，页面不提供无效的关闭开关 |
| 总输出预算 | 页面提供 1024 / 2048 / 4096 / 8192 / 16384；后端字段为 `max_tokens` |

Claude 5 不接受旧式 `enabled + budget_tokens`；Fable 5 不允许关闭思考。当前界面不展示思考内容，发送 `display: omitted`，工具续轮仍原样携带返回的签名块。[Anthropic 思考配置](https://platform.claude.com/docs/en/build-with-claude/thinking)、[旧预算模式迁移说明](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

16384 是本项目目前的输出预算上限，不是模型官方最大值，也不代表只计算可见答案。当前未开放 `effort`、采样温度等额外调参入口，不会提交页面不存在的设置。ApiMart 文档里的示例模型列表不是当前账号权限清单；保留已经配置的模型 ID，不自动替换为文档示例型号。

## Gemini 原生接口

原生对话使用 `/v1beta/models/{model}:generateContent`，不把图片生成参数混入普通问答。[ApiMart Gemini 原生接口](https://docs.apimart.ai/en/api-reference/texts/gemini/quickstart)

项目适配层将消息转换为 `contents` / `parts`，图片使用内联数据，工具调用使用 `functionCall` / `functionResponse`。已返回的 `thoughtSignature` 会在同一次工具续轮中保留。是否附带搜索工具取决于调用模式；界面没有提供通用的“思考预算”滑块。

## Responses 接口

配置为 Responses 协议的模型走 `/responses`，当前发送模型、输入、工具与工具选择；画布工具循环禁用并行工具调用，按顺序等待实际执行结果。[ApiMart Responses 接口](https://docs.apimart.ai/en/api-reference/texts/openai/responses)

普通问答不会因为进入 Agent 界面而自动提交图片或视频。媒体生成由明确的生成请求或工具步骤触发；工具执行前确认开关决定写入步骤是否先等待用户确认。

## 验证边界

自动化检查覆盖 Claude 流式签名拼接、两次工具调用的完整回传、最终文本展示、Gemini 签名保留和画布工具执行顺序。本轮参数核对没有新增收费调用，不能把模拟接口测试说成所有模型已实付验证。
