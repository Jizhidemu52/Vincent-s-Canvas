# Generation Reliability Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Make model selection capability-aware, make generated media tasks traceable and safely recoverable, and require an explicit Agent image-to-video confirmation.

**Architecture:** The server owns a video-model capability manifest and validates the same payload through a non-billing preflight route and the billing submission route. The web client consumes the manifest, tracks returned task IDs through the existing queue, and the Agent turns an image result into a confirmation card before creating a video task.

**Tech Stack:** Bun, TypeScript, native Fetch server, React 19, Zustand, Radix UI, Bun test.

## Global Constraints

- Do not return, persist in task metadata, log, or render provider API keys.
- A recover/query action must never issue a second upstream submit request or deduct credits.
- Only enabled models with configured credentials are selectable.
- Keep the existing Agent result-first UI; do not expose workflow nodes in the Agent panel.
- Preserve all existing user changes outside the files named by each task.

---

## File Structure

- \`server/src/video-models.ts\`: pure video capability manifest and normalized input validation.
- \`server/src/demo-server.ts\`: authenticated capability, preflight, task-lifecycle, and query-only recovery routes.
- \`server/tests/video-models.test.ts\`: contract and reference-limit tests.
- \`server/tests/demo-server.test.ts\`: route-level preflight, unavailable-model, and recovery tests.
- \`web/src/services/api/generation-tasks.ts\`: capability fetch, preflight submit, typed task state, recovery transport.
- \`web/src/services/api/video.ts\`: video path that preflights before the one paid submission.
- \`web/src/lib/agent-direct-generation.ts\`: pure confirmation state and canvas-result helpers.
- \`web/src/components/canvas/canvas-agent-chat-ui.tsx\`: confirmation card UI.
- \`web/src/components/canvas/canvas-assistant-panel.tsx\`: controls, selection, confirmation, and task-status rendering.
- \`web/tests/generation-tasks.test.ts\` and \`web/tests/agent-direct-generation.test.ts\`: browser-independent regression tests.

## Task 1: Define the video capability contract

**Files:**
- Modify: \`server/src/video-models.ts\`
- Modify: \`server/tests/video-models.test.ts\`

**Interfaces:**
- Produce \`VideoModelCapability\`, \`videoModelCapabilities\`, \`getVideoModelCapability(model)\`, and \`preflightVideoProviderRequest(model, prompt, parameters, sources)\`.
- \`VideoModelCapability\` has \`model, seconds, resolutions, sizes, minImages, maxImages, firstFrameRequired, supportsAudio\`.
- Preflight returns the normalized request or throws a user-safe validation error before any billing work.

- [ ] **Step 1: Write failing contract tests**

\`\`\`ts
test("declares per-model video limits", () => {
  expect(getVideoModelCapability("wan2.7")).toMatchObject({
    seconds: [2, 15], resolutions: ["720P", "1080P"], maxImages: 2,
  });
});

test("rejects over-limit references before submission", () => {
  expect(() => preflightVideoProviderRequest("wan2.7", "walk", {}, [publicImage, publicImage, publicImage]))
    .toThrow("wan2.7 accepts one first frame or a first and last frame");
});
\`\`\`

- [ ] **Step 2: Run the focused test to verify it fails**

Run: \`bun test server/tests/video-models.test.ts\`

Expected: the new capability and preflight exports do not exist.

- [ ] **Step 3: Implement the immutable manifest and shared preflight**

\`\`\`ts
export type VideoModelCapability = {
  model: SupportedVideoModelId;
  seconds: readonly [number, number];
  resolutions: readonly string[];
  sizes: readonly string[];
  minImages: number;
  maxImages: number;
  firstFrameRequired: boolean;
  supportsAudio: boolean;
};

export function preflightVideoProviderRequest(
  model: SupportedVideoModelId,
  prompt: string,
  parameters: VideoProviderParameters,
  sources: ProviderVideoSource[],
) {
  const request = buildVideoProviderRequest(model, prompt, parameters, sources);
  return { request, normalized: {
    seconds: request.duration, resolution: request.resolution,
    size: request.size, referenceCount: sources.length,
  }};
}
\`\`\`

The four entries must exactly match existing provider builders: MiniMax 4–15 seconds/one image; Seedance 4–30 seconds/up to 30 images; Wan 2–15 seconds/up to two images; HappyHorse 3–15 seconds/up to nine images.

- [ ] **Step 4: Verify and commit**

Run: \`bun test server/tests/video-models.test.ts && bun --cwd server run build\`

Expected: all contract tests and the server typecheck pass.

\`\`\`powershell
git add server/src/video-models.ts server/tests/video-models.test.ts
git commit -m "feat: define video model capabilities"
\`\`\`

## Task 2: Add server-side preflight and task evidence

**Files:**
- Modify: \`server/src/demo-server.ts\`
- Create: \`server/tests/demo-server.test.ts\`

**Interfaces:**
- \`GET /api/generation-capabilities?operationType=video_generation\` returns enabled, credentialed video models with a capability object.
- \`POST /api/tasks/preflight\` accepts the existing task payload and returns \`{ ok, requestId, normalized }\`; it cannot create an upstream task or change credits.
- \`DemoTask\` gains \`stage, errorCode, upstreamTaskId, updatedAt\`.
- \`POST /api/tasks/:id/recover\` may query/download an existing upstream task only; it never submits or debits.

- [ ] **Step 1: Write failing authenticated API tests**

\`\`\`ts
test("preflight normalizes a video request without charging credits", async () => {
  const before = user.creditBalance;
  const body = await authorizedJson("/api/tasks/preflight", {
    operationType: "video_generation", modelConfigId: happyHorseModelId,
    prompt: "walk", parameters: { seconds: 20, resolution: "720p" }, sourceUrls: [],
  });
  expect(body).toMatchObject({ ok: true, normalized: { seconds: 15, resolution: "720P" } });
  expect(user.creditBalance).toBe(before);
});

test("capabilities exclude a model with no credential", async () => {
  expect((await authorizedJson("/api/generation-capabilities?operationType=video_generation")).models)
    .not.toContainEqual(expect.objectContaining({ modelId: "happyhorse-1.1" }));
});
\`\`\`

- [ ] **Step 2: Run the test to verify it fails**

Run: \`bun test server/tests/demo-server.test.ts\`

Expected: the capability and preflight routes are absent.

- [ ] **Step 3: Implement one validation path for preflight and submit**

Extract selected-model checks, owned-source checks, temporary public-source creation, and \`preflightVideoProviderRequest\` into \`validateVideoTaskInput\`. Both routes call it. The preflight route always revokes temporary URLs in \`finally\` and returns before price lookup.

Use these exact stages:

\`\`\`ts
type DemoTaskStage =
  | "preflight" | "submitted" | "polling"
  | "downloading" | "succeeded" | "failed";
\`\`\`

The recovery endpoint can call only the existing provider-status and result-download portions of \`runVideoTask\`. It must not call the upstream generation submission or mutate \`creditBalance\`.

- [ ] **Step 4: Verify and commit**

Run: \`bun test server/tests/demo-server.test.ts && bun --cwd server test && bun --cwd server run build\`

Expected: no credit change on preflight, unavailable models absent, and recovery does not add a second submit.

\`\`\`powershell
git add server/src/demo-server.ts server/tests/demo-server.test.ts
git commit -m "feat: preflight media tasks and expose lifecycle evidence"
\`\`\`

## Task 3: Make the web queue capability-aware and recovery-safe

**Files:**
- Modify: \`web/src/services/api/generation-tasks.ts\`
- Modify: \`web/src/services/api/video.ts\`
- Modify: \`web/tests/generation-tasks.test.ts\`

**Interfaces:**
- Produce \`GenerationModelCapability\`, \`getGenerationCapabilities("video_generation")\`, \`preflightQueuedMedia(input)\`, \`recoverQueuedTask(taskId)\`.
- Add optional \`stage\` and \`errorCode\` to \`QueuedTask\`.
- \`submitQueuedMediaTask\` preflights the same request ID and uses the returned normalized parameters before its only \`POST /api/tasks\`.

- [ ] **Step 1: Write failing client tests**

\`\`\`ts
test("preflights before the one paid video submission", async () => {
  mockJson("/api/tasks/preflight", { ok: true, requestId: "r1",
    normalized: { seconds: 5, resolution: "720P", size: "16:9", referenceCount: 1 } });
  mockJson("/api/tasks", { task: { id: "task-1", requestId: "r1",
    status: "processing", stage: "submitted", resultUrls: [], failureReason: null } });
  await submitQueuedMediaTask(videoInput({ requestId: "r1" }));
  expect(fetchCalls()).toEqual(["/api/tasks/preflight", "/api/tasks"]);
});

test("recovery never posts another task", async () => {
  await recoverQueuedTask("task-1");
  expect(fetchCalls()).toEqual(["/api/tasks/task-1/recover"]);
});
\`\`\`

- [ ] **Step 2: Run the test to verify it fails**

Run: \`bun test web/tests/generation-tasks.test.ts\`

Expected: preflight/recovery client functions do not exist.

- [ ] **Step 3: Implement typed transport and safe error classification**

Create \`GenerationTaskError\` with \`code, requestId, taskId\` so UI code never infers retry safety by parsing text. Return this error for preflight, balance, and authorization failures. Preserve the completed URL contract of \`requestVideoGeneration\` for existing callers.

- [ ] **Step 4: Verify and commit**

Run: \`bun test web/tests/generation-tasks.test.ts && bun --cwd web run build\`

\`\`\`powershell
git add web/src/services/api/generation-tasks.ts web/src/services/api/video.ts web/tests/generation-tasks.test.ts
git commit -m "feat: preflight queued media requests"
\`\`\`

## Task 4: Require Agent image selection before video submit

**Files:**
- Modify: \`web/src/lib/agent-direct-generation.ts\`
- Modify: \`web/src/components/canvas/canvas-agent-chat-ui.tsx\`
- Modify: \`web/src/components/canvas/canvas-assistant-panel.tsx\`
- Modify: \`web/tests/agent-direct-generation.test.ts\`

**Interfaces:**
- \`createAgentVideoConfirmation(image, settings, originalPrompt)\` returns selected image, editable prompt, and current model settings.
- \`normalizeAgentVideoSettings(settings, capability)\` clears values unsupported by a newly selected model.
- Message detail uses \`{ kind: "video_confirmation", status: "pending" | "submitted" | "failed", selectedAttachmentId, settings }\`.
- Existing \`onUseImageForVideo\` opens this card; only its confirm action runs \`requestVideoGeneration\`.

- [ ] **Step 1: Write failing pure-function tests**

\`\`\`ts
test("uses the image the user clicked, not the first result", () => {
  const card = createAgentVideoConfirmation(
    { id: "option-3", name: "生成图片 3", url: "data:image/png;base64,abc", mediaType: "image" },
    defaults, "模特向前走",
  );
  expect(card.selectedImage.id).toBe("option-3");
  expect(card.prompt).toContain("模特向前走");
});

test("resets an unsupported model preset", () => {
  expect(normalizeAgentVideoSettings({ ...defaults, videoSeconds: "20", videoQuality: "2K" }, happyHorseCapability))
    .toMatchObject({ videoSeconds: "15", videoQuality: "1080P" });
});
\`\`\`

- [ ] **Step 2: Run the test to verify it fails**

Run: \`bun test web/tests/agent-direct-generation.test.ts\`

Expected: confirmation helpers do not exist.

- [ ] **Step 3: Implement the result-first confirmation card**

Keep image creation and automatic canvas insertion. Change “选此图生成视频” to append a normal Agent message with \`detail.kind === "video_confirmation"\`. Render selected image, editable prompt, available model select, capability-derived duration/quality/ratio controls, “返回选图”, and “确认生成视频”.

Remove \`AGENT_VIDEO_MODELS\` and \`AGENT_VIDEO_PRESETS\` as the source of truth. Fetch the enabled capability list when the panel opens. During video submit, display \`QueuedTask.stage\`; after success, insert the video node with the existing \`buildAgentGeneratedMediaOps\`. A recoverable poll/download failure gets “查询结果”; preflight, balance, and authorization failures show a Chinese cause without an unsafe retry.

- [ ] **Step 4: Verify and commit**

Run: \`bun test web/tests/agent-direct-generation.test.ts && bun --cwd web run build\`

Manual local test:
1. Generate three images.
2. Choose image three.
3. Confirm the card uses image three, switches model presets correctly, then submits once.
4. Confirm the finished video appears in Agent and beside the image nodes.
5. Simulate a recoverable failure and verify “查询结果” causes no second \`POST /api/tasks\`.

\`\`\`powershell
git add web/src/lib/agent-direct-generation.ts web/src/components/canvas/canvas-agent-chat-ui.tsx web/src/components/canvas/canvas-assistant-panel.tsx web/tests/agent-direct-generation.test.ts
git commit -m "feat: require image selection before agent video generation"
\`\`\`

## Task 5: Whole-flow regression gate

**Files:**
- Modify only files above when verification identifies a scoped defect.

- [ ] **Step 1: Run full suites and builds**

Run: \`bun --cwd server test && bun --cwd server run build && bun --cwd web test && bun --cwd web run build\`

Expected: all suites and both TypeScript builds pass.

- [ ] **Step 2: Exercise required error boundaries**

Verify, via authenticated local API requests, these results:

\`\`\`text
missing credential -> capability absent and no submit
invalid duration/reference count -> preflight 400 and no debit
valid request -> submitted -> polling -> downloading -> succeeded
provider balance failure -> failed stable code and no automatic retry
recover -> status/download query only and no new task request
\`\`\`

- [ ] **Step 3: Inspect final scoped diff**

Run: \`git diff --check\` and \`git status --short\`.

Only stage a verification fix when an observed test failure requires it. Never stage unrelated existing changes.
