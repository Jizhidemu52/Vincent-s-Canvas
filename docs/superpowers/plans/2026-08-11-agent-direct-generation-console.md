# Agent Direct Generation Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users configure and receive image/video generation directly in the Agent chat without canvas workflow nodes.

**Architecture:** A small pure planner validates the selected mode and turns the composer choices into request-ready config. The canvas Agent panel invokes the existing queued image/video APIs, persists result attachments in the chat session, and exposes a result card action that transfers one generated image into the video composer.

**Tech Stack:** React 19, TypeScript, Zustand configuration, Ant Design, Bun test, existing `/api/tasks` generation service.

## Global Constraints

- Reuse `requestGeneration`, `requestEdit`, and `requestVideoGeneration`; do not create canvas nodes or connections.
- Default image completion behavior is `select_then_video`, never automatic paid video generation.
- Keep image and video model choices independent and persist them through the existing config store.
- Show only user-facing progress, results, retry, and image-to-video actions in chat.

---

### Task 1: Direct-generation planner

**Files:**
- Create: `web/src/lib/agent-direct-generation.ts`
- Test: `web/tests/agent-direct-generation.test.ts`

**Interfaces:**
- Produces: `AgentGenerationMode`, `AgentImageAfterAction`, `AgentGenerationSettings`, and `buildAgentGenerationPlan(settings, prompt, references)`.
- Consumed by: the composer controls and `CanvasAssistantPanel` submission handler.

- [ ] **Step 1: Write the failing test**

```ts
expect(buildAgentGenerationPlan({ mode: "image", imageModel: "image-a", videoModel: "video-a", size: "1:1", imageCount: "3", videoSeconds: "6", afterImage: "select_then_video" }, "dress on a model", [])).toMatchObject({ kind: "image", count: 3, afterImage: "select_then_video" });
expect(buildAgentGenerationPlan({ mode: "video", imageModel: "image-a", videoModel: "video-a", size: "9:16", imageCount: "1", videoSeconds: "6", afterImage: "select_then_video" }, "walk forward", [])).toMatchObject({ kind: "video", model: "video-a", requiresReference: false });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agent-direct-generation.test.ts`

- [ ] **Step 3: Write the minimal implementation**

```ts
export function buildAgentGenerationPlan(settings, prompt, references) {
  if (!prompt.trim()) throw new Error("请输入生成需求");
  return settings.mode === "image"
    ? { kind: "image", model: settings.imageModel, count: clampCount(settings.imageCount), afterImage: settings.afterImage }
    : { kind: "video", model: settings.videoModel, seconds: settings.videoSeconds, requiresReference: references.length > 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/agent-direct-generation.test.ts`

### Task 2: Chat composer controls and result media cards

**Files:**
- Modify: `web/src/components/canvas/canvas-agent-chat-ui.tsx`
- Modify: `web/src/types/canvas.ts`

**Interfaces:**
- Consumes: `AgentGenerationSettings` and model choices from the parent.
- Produces: `onSettingsChange`, `onUseImageForVideo`, and image/video-capable chat attachments.

- [ ] **Step 1: Extend the failing type-level test with a video result attachment**
- [ ] **Step 2: Verify the test fails because chat media has no video type**
- [ ] **Step 3: Add compact mode, model, size/count/duration controls below attachment thumbnails and render image/video results in the message**
- [ ] **Step 4: Run the focused test and TypeScript build**

### Task 3: Direct execution in the Agent panel

**Files:**
- Modify: `web/src/components/canvas/canvas-assistant-panel.tsx`
- Test: `web/tests/agent-direct-generation.test.ts`

**Interfaces:**
- Consumes: planner output, selected/uploaded references, `requestGeneration`, `requestEdit`, `requestVideoGeneration`.
- Produces: persisted `CanvasAssistantMessage.attachments`, a selectable image result, and direct retryable errors.

- [ ] **Step 1: Write failing tests for image-plan config isolation and reference-required video plans**
- [ ] **Step 2: Verify the focused tests fail**
- [ ] **Step 3: Route composer submission by mode; append user-visible progress then direct result messages, never call `generationFlowOps`**
- [ ] **Step 4: Wire `选此图生成视频` to switch the composer to video mode with that image as its sole reference**
- [ ] **Step 5: Run focused tests, the full web test suite, and `bun run build`**

### Task 4: Browser verification

**Files:**
- No source change expected.

- [ ] **Step 1: Open the local app and verify mode, model, count/size, duration controls appear beneath image attachments**
- [ ] **Step 2: Verify selecting an image result exposes the video handoff action without adding canvas nodes**
- [ ] **Step 3: Verify invalid empty prompt and missing-reference video requests show recoverable errors**
