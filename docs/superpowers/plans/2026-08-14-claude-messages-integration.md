# Claude Messages Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `claude-opus-5`, `claude-sonnet-5`, and `claude-fable-5` to Agent chat using APIMart's native Anthropic Messages API.

**Architecture:** A server `anthropic` chat adapter converts existing normalized Agent input and output. Credential-gated provider registration feeds the existing text-model selector, while Claude-only chat options carry stream, thinking, and output-token options.

**Tech Stack:** Bun, TypeScript, native Fetch, React, Zustand, Bun test.

## Global Constraints

- Call `POST /v1/messages` with `x-api-key`, `anthropic-version: 2025-10-01`, and `max_tokens`.
- Preserve native provider response shapes; classify errors by HTTP status and `error.code`.
- Never return or log provider keys.
- The three models are shown only when the APIMart provider is credentialed.

---

### Task 1: Claude Messages adapter

**Files:**

- Modify: `server/src/routes/chat.ts`
- Modify: `server/tests/chat.test.ts`

**Interfaces:**

- `buildClaudeMessagesRequest(input, options)` produces native body fields `system`, `messages`, `tools`, `thinking`, `stream`, and `max_tokens`.
- `readClaudeResponse(body)` produces `{ content: string; toolCalls: ToolCall[] }`.

- [ ] **Step 1: Write failing adapter tests**

```ts
test("builds a Claude request with system, image, tool and thinking", () => {
  expect(buildClaudeMessagesRequest({
    input: [{ role: "system", content: "Keep brand tone" }, { role: "user", content: [{ type: "input_text", text: "Review" }, { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" }] }],
    tools: [{ type: "function", name: "canvas_get_state", parameters: { type: "object", properties: {} } }],
  }, { maxTokens: 1024, thinking: true })).toMatchObject({ system: "Keep brand tone", max_tokens: 1024, thinking: { type: "enabled" } });
});

test("reads text and tool_use after thinking blocks", () => {
  expect(readClaudeResponse({ content: [{ type: "thinking", thinking: "..." }, { type: "text", text: "Use warm red" }, { type: "tool_use", id: "tool-1", name: "canvas_get_state", input: { scope: "selected" } }] }).content).toBe("Use warm red");
});
```

- [ ] **Step 2: Verify red**

Run: `bun test server/tests/chat.test.ts`

Expected: the new functions do not exist.

- [ ] **Step 3: Implement minimal native transport**

```ts
if (model.protocol === "anthropic") return requestClaudeCompletion(model, credentials, input);
const upstream = await fetch(`${model.base_url.replace(/\/$/, "")}/v1/messages`, {
  method: "POST",
  headers: { "x-api-key": credentials.apiKey, "anthropic-version": "2025-10-01", "content-type": "application/json" },
  body: JSON.stringify(buildClaudeMessagesRequest(input, { maxTokens: 2048 })),
});
```

Map system, base64 image, tool, and tool-result blocks. Reject remote image URLs before fetch. Read every text and tool-use response block rather than using `content[0]`.

- [ ] **Step 4: Verify green and commit**

Run: `bun test server/tests/chat.test.ts && bun --cwd server run build`

Run: `git add server/src/routes/chat.ts server/tests/chat.test.ts && git commit -m "feat: add native Claude Messages chat adapter"`

### Task 2: Credential-gated Claude model registration

**Files:**

- Modify: `server/src/demo-provider-configuration.ts`
- Modify: `server/src/demo-server.ts`
- Modify: `server/tests/demo-provider-configuration.test.ts`

**Interfaces:**

- `resolveDemoExternalProviders(...).claudeModelIds` returns all requested model IDs.
- `Anthropic Claude` uses protocol `anthropic` and the existing server-held APIMart credential.

- [ ] **Step 1: Write failing availability test**

```ts
test("declares requested Claude models", () => {
  expect(resolveDemoExternalProviders({ apiMartApiKey: "configured" }).claudeModelIds)
    .toEqual(["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]);
});
```

- [ ] **Step 2: Verify red**

Run: `bun test server/tests/demo-provider-configuration.test.ts`

Expected: `claudeModelIds` does not exist.

- [ ] **Step 3: Implement provider and entries**

```ts
const claudeModelIds = ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"] as const;
```

Register one APIMart-hosted `anthropic` provider and text/vision/tools model entries. Existing configured-model filtering must hide them with no credential.

- [ ] **Step 4: Verify green and commit**

Run: `bun test server/tests/demo-provider-configuration.test.ts && bun --cwd server run build`

Run: `git add server/src/demo-provider-configuration.ts server/src/demo-server.ts server/tests/demo-provider-configuration.test.ts && git commit -m "feat: register Claude Agent models"`

### Task 3: Claude-only Agent controls

**Files:**

- Modify: `web/src/stores/use-config-store.ts`
- Modify: `web/src/services/api/image.ts`
- Modify: `web/src/components/canvas/canvas-agent-chat-ui.tsx`
- Modify: `web/src/components/canvas/canvas-assistant-panel.tsx`
- Create: `web/tests/claude-chat-options.test.ts`

**Interfaces:**

- `isClaudeModel(model: string): boolean` gates the controls.
- Agent sends `stream`, `thinking`, and `max_tokens` only for Claude.

- [ ] **Step 1: Write failing UI-option test**

```ts
test("recognizes requested Claude models", () => {
  expect(isClaudeModel("claude-sonnet-5")).toBe(true);
  expect(isClaudeModel("gemini-3.1-pro-preview")).toBe(false);
});
```

- [ ] **Step 2: Verify red**

Run: `bun test web/tests/claude-chat-options.test.ts`

Expected: `isClaudeModel` does not exist.

- [ ] **Step 3: Implement scoped controls**

```tsx
{isClaudeModel(activeModel) ? <ClaudeChatOptions stream={settings.claudeStream} thinking={settings.claudeThinking} maxTokens={settings.claudeMaxTokens} onChange={updateSettings} /> : null}
```

Keep Gemini/OpenAI payloads and controls unchanged. In stream mode, consume native SSE text/tool events into the existing Agent response state.

- [ ] **Step 4: Verify green and commit**

Run: `bun test web/tests/claude-chat-options.test.ts && bun --cwd web run build`

Run: `git add web/src/stores/use-config-store.ts web/src/services/api/image.ts web/src/components/canvas/canvas-agent-chat-ui.tsx web/src/components/canvas/canvas-assistant-panel.tsx web/tests/claude-chat-options.test.ts && git commit -m "feat: expose Claude options in Agent chat"`

### Task 4: Regression gate

- [ ] **Step 1: Run full verification**

Run: `bun --cwd server test && bun --cwd server run build && bun --cwd web test && bun --cwd web run build`

Expected: all tests and builds pass.

- [ ] **Step 2: Check local contracts**

Verify `/api/models` returns the three Claude IDs only with APIMart configured; fetch-spy sees `/v1/messages`, `x-api-key`, and `max_tokens`; remote images fail before upstream fetch.

- [ ] **Step 3: Check scoped whitespace**

Run: `git diff --check -- server/src/routes/chat.ts server/src/demo-server.ts server/src/demo-provider-configuration.ts web/src/stores/use-config-store.ts web/src/services/api/image.ts web/src/components/canvas/canvas-agent-chat-ui.tsx web/src/components/canvas/canvas-assistant-panel.tsx`

Expected: no errors; do not stage unrelated dirty files.
