# Claude Messages Integration Design

## Goal

Add `claude-opus-5`, `claude-sonnet-5`, and `claude-fable-5` as selectable Agent LLMs through APIMart's native Anthropic-compatible Messages API.

## Provider and model availability

- Reuse the existing APIMart provider credential; no browser-side key is introduced.
- Register a dedicated `Anthropic Claude` provider with protocol `anthropic` and base URL `https://api.apimart.ai`.
- Register the three requested model IDs as text/vision/tool-capable models.
- Expose the models only when the APIMart credential is configured and the provider is enabled.

## Native protocol adapter

- Send `POST /v1/messages` with `x-api-key`, `anthropic-version: 2025-10-01`, and JSON content.
- Preserve multi-turn `user`/`assistant` messages and map the application's system message to the top-level `system` field.
- Map image data URLs to Anthropic base64 image blocks; reject unsupported remote-only image URLs with a clear Chinese error.
- Map canvas tools to Anthropic `tools` / `input_schema`; map tool calls and tool results across follow-up turns.
- Support `thinking` request configuration and parse all response content blocks, collecting `text` blocks while retaining `tool_use` blocks.
- Add an explicit streaming transport for SSE, preserving upstream message events without a `{ code, data }` wrapper.

## User interface

- The existing Agent LLM selector receives the configured Claude models automatically from the server model list.
- The Agent chat composer gains visible controls for Claude-compatible advanced options: streaming, extended thinking, and maximum output tokens.
- These controls appear only for Claude selections; Gemini/OpenAI model behaviour stays unchanged.

## Error handling and safety

- Use HTTP status and the provider's `error.code` for classification; do not depend on `error.type`.
- Do not expose credentials in API responses, task logs, browser state, or error text.
- Preserve upstream request IDs in safe error detail where supplied.

## Verification

- Unit-test request conversion for system, multi-turn, image, tools, thinking, and unsupported image input.
- Unit-test normal and SSE Claude response parsing, including text plus thinking plus tool-use blocks.
- Verify the three models are absent without a configured APIMart credential and present with one.
- Build both applications and manually verify the Agent’s Claude options and a non-billed protocol preflight/mock response.
