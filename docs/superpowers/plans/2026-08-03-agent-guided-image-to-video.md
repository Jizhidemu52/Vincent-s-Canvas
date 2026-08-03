# Agent 引导式图片转视频工作流 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give canvas Agent users explicit image/video model choices and a mandatory single-image selection gate before image-to-video generation.

**Architecture:** A new pure media-workflow module will classify prompt intent and hold serializable workflow state. The canvas assistant persists that state in message detail, renders a focused workflow card, and applies generation ops only after the user confirms the appropriate stage. Existing canvas generation continues to own provider calls and node creation.

**Tech Stack:** React 19, TypeScript, Ant Design, Zustand configuration store, Bun test.

## Global Constraints

- The Agent model remains separate from image and video generation models.
- Image and video model lists use capability-filtered models only and remember selections independently.
- An image-to-video workflow requires exactly one user-selected successful candidate before video generation.
- Never bypass HTTPS certificate verification; present it as a recoverable connection error.
- Preserve existing manual canvas generation and multi-reference image behavior.

---

## File structure

- Create `web/src/lib/canvas/agent-media-workflow.ts`: intent classification, workflow state transitions, candidate extraction, and video-gate validation.
- Create `web/tests/agent-media-workflow.test.ts`: unit coverage for routing, required selection, candidate results, and failure recovery.
- Modify `web/src/types/canvas.ts`: add serializable `CanvasAgentMediaWorkflow` detail types.
- Create `web/src/components/canvas/canvas-agent-media-workflow-card.tsx`: embedded two-stage card and controls.
- Modify `web/src/components/canvas/canvas-assistant-panel.tsx`: route tool calls, persist workflow detail, render cards, and dispatch confirmed generation ops.
- Modify `docs/content/docs/progress/pending-test.mdx`: record the user-testable Agent workflow change.
- Modify `docs/content/docs/progress/todo.mdx` only if it already lists Agent image-to-video routing as pending; otherwise leave it unchanged after verification.

### Task 1: Deterministic media-intent and workflow state module

**Files:**
- Create: `web/src/lib/canvas/agent-media-workflow.ts`
- Test: `web/tests/agent-media-workflow.test.ts`

**Interfaces:**
- Produces `classifyAgentMediaIntent(prompt: string): "image" | "video" | "image_to_video"`.
- Produces `createAgentMediaWorkflow(input): CanvasAgentMediaWorkflow`.
- Produces `selectWorkflowCandidate(workflow, nodeId)` and `canGenerateWorkflowVideo(workflow)`.
- Consumes only serializable node/result identifiers; no React or network dependency.

- [ ] **Step 1: Write the failing tests**

```ts
test("routes runway motion requests to video even when clothing is mentioned", () => {
  expect(classifyAgentMediaIntent("让模特穿这件衣服在秀场走秀")).toBe("video");
});

test("keeps an explicit first-generate-image-then-video request in staged mode", () => {
  expect(classifyAgentMediaIntent("先生成图片，再选一张生成走秀视频")).toBe("image_to_video");
});

test("requires one successful candidate before video is enabled", () => {
  const workflow = createAgentMediaWorkflow({ intent: "image_to_video", prompt: "走秀", imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" });
  expect(canGenerateWorkflowVideo(workflow)).toBe(false);
  expect(canGenerateWorkflowVideo(selectWorkflowCandidate({ ...workflow, candidates: [{ nodeId: "image-1", status: "success" }] }, "image-1"))).toBe(true);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test tests/agent-media-workflow.test.ts`

Expected: FAIL because `agent-media-workflow` does not exist.

- [ ] **Step 3: Implement the minimal pure API**

```ts
export type AgentMediaIntent = "image" | "video" | "image_to_video";

export function classifyAgentMediaIntent(prompt: string): AgentMediaIntent {
  const normalized = prompt.toLowerCase();
  if (/先.*(出图|生成图片).*(再|然后).*(视频|走秀|动画)/.test(normalized)) return "image_to_video";
  if (/(视频|走秀|运镜|镜头|动态|动画|短片|动作)/.test(normalized)) return "video";
  return "image";
}
```

Implement the workflow state helpers so only a candidate with `status: "success"` can become `selectedCandidateNodeId`.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `bun test tests/agent-media-workflow.test.ts`

Expected: PASS for routing, selected-candidate gate, empty candidates, and failed candidates.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/canvas/agent-media-workflow.ts web/tests/agent-media-workflow.test.ts
git commit -m "feat: add agent media workflow state"
```

### Task 2: Persist guided-workflow details in Agent sessions

**Files:**
- Modify: `web/src/types/canvas.ts:107-123`
- Modify: `web/src/lib/canvas/agent-media-workflow.ts`
- Test: `web/tests/agent-media-workflow.test.ts`

**Interfaces:**
- Produces `CanvasAgentMediaWorkflow` with `id`, `intent`, `prompt`, `imageModel`, `videoModel`, `candidates`, `selectedCandidateNodeId`, `imageStatus`, `videoStatus`, and `error`.
- `CanvasAssistantMessage.detail` stores `{ mediaWorkflow?: CanvasAgentMediaWorkflow }` without breaking existing tool detail objects.

- [ ] **Step 1: Add serialization regression tests**

```ts
test("preserves selected candidate and model choices through serialization", () => {
  const workflow = selectWorkflowCandidate({
    ...createAgentMediaWorkflow({ intent: "image_to_video", prompt: "走秀", imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" }),
    candidates: [{ nodeId: "image-2", status: "success" }],
  }, "image-2");
  expect(JSON.parse(JSON.stringify(workflow))).toMatchObject({ selectedCandidateNodeId: "image-2", imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" });
});
```

- [ ] **Step 2: Run the focused test to verify the expected baseline**

Run: `bun test tests/agent-media-workflow.test.ts`

Expected: PASS at runtime for the pure object; the next step adds the exported canvas type and persistence contract without changing the serialized shape.

- [ ] **Step 3: Extend the canvas types and helpers**

```ts
export type CanvasAgentMediaWorkflow = {
  id: string;
  intent: "image" | "video" | "image_to_video";
  prompt: string;
  imageModel: string;
  videoModel: string;
  candidates: Array<{ nodeId: string; status: "pending" | "success" | "failed"; url?: string }>;
  selectedCandidateNodeId?: string;
  imageStatus: "idle" | "running" | "success" | "failed";
  videoStatus: "idle" | "running" | "success" | "failed";
  error?: string;
};
```

Make `CanvasAssistantMessage.detail` preserve this type alongside existing tool metadata.

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `bun test tests/agent-media-workflow.test.ts`

Expected: PASS including JSON round-trip and failed-stage recovery state.

- [ ] **Step 5: Commit**

```bash
git add web/src/types/canvas.ts web/src/lib/canvas/agent-media-workflow.ts web/tests/agent-media-workflow.test.ts
git commit -m "feat: persist agent media workflows"
```

### Task 3: Build the embedded two-stage workflow card

**Files:**
- Create: `web/src/components/canvas/canvas-agent-media-workflow-card.tsx`
- Modify: `web/src/components/canvas/canvas-assistant-panel.tsx:647-651`
- Test: `web/tests/agent-media-workflow.test.ts`

**Interfaces:**
- Consumes `workflow: CanvasAgentMediaWorkflow`, `imageModels: string[]`, `videoModels: string[]`, and callbacks `onImageModelChange`, `onGenerateImages`, `onSelectCandidate`, `onVideoModelChange`, `onGenerateVideo`, `onRetry`.
- Produces an embedded card with image stage, candidate selection, and gated video stage.

- [ ] **Step 1: Keep the workflow eligibility tests as the card contract**

```ts
test("does not expose video submission state until exactly one candidate is selected", () => {
  const workflow = createAgentMediaWorkflow({ intent: "image_to_video", prompt: "走秀", imageModel: "gpt-image-2", videoModel: "happyhorse-1.0" });
  expect(canGenerateWorkflowVideo(workflow)).toBe(false);
});
```

- [ ] **Step 2: Run the test to establish the card contract**

Run: `bun test tests/agent-media-workflow.test.ts`

Expected: PASS; Task 1 owns the pure eligibility rule, and the card must use that rule rather than duplicate it.

- [ ] **Step 3: Implement the card**

Render image-model and video-model `Select` controls independently. Render successful candidates as radio-style image tiles; clicking a tile calls `onSelectCandidate(nodeId)`. Disable the video button and show “请选择一张成功候选图” until `canGenerateWorkflowVideo(workflow)` is true. Render stage-local error text and retry buttons without clearing model choices or selection.

- [ ] **Step 4: Render the card from assistant messages**

```tsx
{message.detail?.mediaWorkflow ? (
  <CanvasAgentMediaWorkflowCard
    workflow={message.detail.mediaWorkflow}
    imageModels={imageModels}
    videoModels={videoModels}
    onGenerateImages={() => runWorkflowImageStage(message.id)}
    onSelectCandidate={(nodeId) => selectWorkflowCandidate(message.id, nodeId)}
    onGenerateVideo={() => runWorkflowVideoStage(message.id)}
  />
) : null}
```

- [ ] **Step 5: Run focused tests and production build**

Run: `bun test tests/agent-media-workflow.test.ts && bun run build`

Expected: PASS and TypeScript build succeeds.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/canvas/canvas-agent-media-workflow-card.tsx web/src/components/canvas/canvas-assistant-panel.tsx web/tests/agent-media-workflow.test.ts
git commit -m "feat: add guided image to video card"
```

### Task 4: Integrate deterministic routing and generation dispatch

**Files:**
- Modify: `web/src/components/canvas/canvas-assistant-panel.tsx:30-31,375-462,1058-1155`
- Modify: `web/src/pages/canvas/project.tsx:837-866,2972-3050`
- Test: `web/tests/agent-media-workflow.test.ts`

**Interfaces:**
- `runWorkflowImageStage(messageId)` applies only image generation ops.
- `runWorkflowVideoStage(messageId)` refuses without `selectedCandidateNodeId`, then applies video generation ops that reference that one image node.
- `classifyAgentMediaIntent` overrides a model-selected image tool when the user prompt is a direct-video request.

- [ ] **Step 1: Write failing integration-shape tests**

```ts
test("builds a video workflow for a runway request without an image run", () => {
  const workflow = createAgentMediaWorkflowForPrompt("让模特在秀场走秀", models);
  expect(workflow.intent).toBe("video");
  expect(workflow.imageStatus).toBe("idle");
});

test("builds video input from only the selected image node", () => {
  expect(videoReferenceNodeIds({ selectedCandidateNodeId: "image-2", candidates: [{ nodeId: "image-1", status: "success" }, { nodeId: "image-2", status: "success" }] })).toEqual(["image-2"]);
});
```

- [ ] **Step 2: Run the integration-shape test to verify it fails**

Run: `bun test tests/agent-media-workflow.test.ts`

Expected: FAIL because the workflow factory and single-reference helper do not exist.

- [ ] **Step 3: Update the Agent instruction and tool conversion**

Add explicit instruction: direct dynamic requests call video; composite requests create a staged workflow and do not auto-run video. In `onlineToolToOps`, route direct-video wording to `mode: "video"` even if the model selected `canvas_generate_image`. For composite intent, persist a workflow card instead of immediately issuing the video op.

- [ ] **Step 4: Dispatch user-confirmed stages only**

Use `selectableModelsByCapability(effectiveConfig, "image")` and `selectableModelsByCapability(effectiveConfig, "video")` for card options. Save image choice to `effectiveConfig.imageModel` and video choice to `effectiveConfig.videoModel` via `updateConfig`. Apply image ops with the card image model. Apply video ops only after selection, with `referenceNodeIds: [selectedCandidateNodeId]` and the card video model.

- [ ] **Step 5: Map outcomes back into the workflow card**

When generated image nodes become successful, append their node IDs and URLs as candidates. On a certificate error, set the current stage to `failed` and surface “连接证书校验失败，请检查 API 地址、证书链或网络代理后重试。” Preserve the other stage state.

- [ ] **Step 6: Run focused tests and the full frontend suite**

Run: `bun test && bun run build`

Expected: all existing tests plus media-workflow tests pass; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/canvas/canvas-assistant-panel.tsx web/src/pages/canvas/project.tsx web/src/lib/canvas/agent-media-workflow.ts web/tests/agent-media-workflow.test.ts
git commit -m "feat: route agent media workflows explicitly"
```

### Task 5: Document and manually verify the user workflow

**Files:**
- Modify: `docs/content/docs/progress/pending-test.mdx`
- Modify: `docs/content/docs/progress/todo.mdx` only if a matching pending task exists.

- [ ] **Step 1: Update the pending-test record**

Add a concise entry stating that Agent image-to-video workflows now require manual candidate selection, expose separate image/video models, and route runway-motion requests to video.

- [ ] **Step 2: Verify no unrelated todo entry needs movement**

Run: `rg -n -i "agent|视频|走秀|图片转视频" docs/content/docs/progress/todo.mdx docs/content/docs/progress/pending-test.mdx`

Expected: only relevant matching entries are changed; do not create unrelated todo content.

- [ ] **Step 3: Run local manual acceptance checks**

1. Start the demo API on `127.0.0.1:3100` and Vite on `127.0.0.1:5173`.
2. Ask the Agent “让模特穿这件衣服在秀场走秀”; verify a video workflow is offered and no image task is auto-submitted.
3. Ask “先生成图片，再选一张生成走秀视频”; generate candidates, verify the video button remains disabled until one image is clicked, then verify the video request contains only that image reference.
4. Simulate an upstream certificate failure; verify the affected stage offers retry and preserves model choices plus selected candidate.

- [ ] **Step 4: Commit**

```bash
git add docs/content/docs/progress/pending-test.mdx docs/content/docs/progress/todo.mdx
git commit -m "docs: record guided media workflow testing"
```
