# Unified Image References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Add ordered multi-source image references to the image workbench and canvas image-generation nodes, submitting the visible order to the existing image task API.

**Architecture:** Pure reference-policy utilities define model limits, identity-based deduplication and stable ordering. A reusable tray renders the list. The canvas persists manual selections, connected-image exclusions and order in node metadata, then resolves them to the existing ReferenceImage input immediately before generation.

**Tech Stack:** React 19, TypeScript, Ant Design, Zustand, Bun test, existing local image storage and queued image task API.

## Global Constraints

- Never put provider credentials into frontend code or browser storage.
- Limits: GPT-Image-2 0–16; Gemini 3.1 Flash 0–14; Midjourney Blend 2–4; ordinary Midjourney 0.
- Keep submission order identical to the tray order.
- Do not send a real provider request during automated testing.
- Use native HTML draggable events and accessible move buttons; add no drag dependency.

---

## File Structure

| File | Responsibility |
| --- | --- |
| web/src/lib/image-reference-policy.ts | Limits, validation, image identity, de-duplication and ordering. |
| web/src/components/reference-images/reference-image-tray.tsx | Shared thumbnails, source labels, drag reorder, remove and clear. |
| web/src/lib/canvas/canvas-image-references.ts | Canvas merge of manual images, connected nodes, exclusions and saved order. |
| web/src/components/canvas/canvas-image-reference-dialog.tsx | Canvas-only multi-select dialog for image nodes. |
| web/src/types/image.ts | Reference origin and stable-key metadata. |
| web/src/types/canvas.ts | Persisted manual image references, exclusions and order. |
| web/src/components/canvas/asset-picker-modal.tsx | Optional multiple-image selection while retaining single insertion. |
| web/src/pages/image/index.tsx | Image workbench integration. |
| web/src/components/canvas/canvas-node-prompt-panel.tsx | Reference controls next to the canvas prompt. |
| web/src/pages/canvas/project.tsx | Persistence and submission in each canvas image-generation path. |
| web/tests/image-reference-policy.test.ts | Policy, ordering and duplicate unit tests. |
| web/tests/canvas-image-references.test.ts | Canvas merge, exclusion and persistence unit tests. |

## Task 1: Create the ordered-reference policy

**Files:**

- Create: web/src/lib/image-reference-policy.ts
- Modify: web/src/types/image.ts
- Test: web/tests/image-reference-policy.test.ts

**Interfaces:**

- Produce ImageReferenceOrigin and ImageReferenceItem.
- ImageReferenceItem extends ReferenceImage with referenceKey, origin and originLabel.
- Produce dedupeImageReferences, moveImageReference, referencePolicyForModel and validateImageReferences.
- validateImageReferences(modelId, references) returns valid, message, minimum, maximum and supportsReferences.

- [ ] **Step 1: Write failing unit tests**

~~~ts
import { dedupeImageReferences, moveImageReference, validateImageReferences } from "../src/lib/image-reference-policy";

const ref = (id: string, origin = "upload") => ({
  id,
  name: id + ".png",
  type: "image/png",
  dataUrl: "https://images.test/" + id + ".png",
  referenceKey: origin + ":" + id,
  origin,
  originLabel: "上传",
});

test("keeps the first visual occurrence of a duplicate", () => {
  expect(dedupeImageReferences([ref("same", "upload"), ref("same", "canvas"), ref("next")]).map((item) => item.referenceKey)).toEqual(["upload:same", "upload:next"]);
});

test("moves one reference without disturbing the others", () => {
  expect(moveImageReference([ref("a"), ref("b"), ref("c")], 2, 0).map((item) => item.id)).toEqual(["c", "a", "b"]);
});

test("enforces GPT, Gemini and Midjourney limits", () => {
  expect(validateImageReferences("gpt-image-2", Array.from({ length: 17 }, (_, i) => ref(String(i)))).message).toContain("16");
  expect(validateImageReferences("gemini-3.1-flash-image-preview", Array.from({ length: 15 }, (_, i) => ref(String(i)))).message).toContain("14");
  expect(validateImageReferences("midjourney-blend", [ref("one")]).message).toContain("2 至 4");
  expect(validateImageReferences("midjourney", [ref("one")]).valid).toBe(false);
});
~~~

- [ ] **Step 2: Run the tests to confirm the missing module**

Run: bun test web/tests/image-reference-policy.test.ts

Expected: FAIL because image-reference-policy does not exist.

- [ ] **Step 3: Implement the policy**

~~~ts
export type ImageReferenceOrigin = "upload" | "asset" | "canvas" | "connection" | "clipboard" | "generated" | "template";
export type ImageReferenceItem = ReferenceImage & { referenceKey: string; origin: ImageReferenceOrigin; originLabel: string };

export function validateImageReferences(modelId: string, references: ImageReferenceItem[]) {
  const policy = referencePolicyForModel(modelId);
  if (!policy.supportsReferences && references.length) return { ...policy, valid: false, message: "当前模型不支持参考图，请移除参考图或切换模型。" };
  if (references.length < policy.minimum || references.length > policy.maximum) return { ...policy, valid: false, message: policy.message };
  return { ...policy, valid: true };
}
~~~

Use identity in this order for deduplication: storageKey, non-data URL/dataUrl, sourceAssetId, then referenceKey. Preserve the first occurrence.

- [ ] **Step 4: Run the tests**

Run: bun test web/tests/image-reference-policy.test.ts

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add web/src/types/image.ts web/src/lib/image-reference-policy.ts web/tests/image-reference-policy.test.ts
git commit -m "feat: add image reference policy"
~~~

## Task 2: Build the shared tray and workbench controls

**Files:**

- Create: web/src/components/reference-images/reference-image-tray.tsx
- Modify: web/src/components/canvas/asset-picker-modal.tsx
- Modify: web/src/pages/image/index.tsx
- Test: web/tests/image-reference-policy.test.ts

**Interfaces:**

- ReferenceImageTray accepts references, validation, onChange, onRequestUpload, optional onRequestAssets and optional onRequestCanvas.
- AssetPickerModal gains selectionMode: "single" | "multiple-images" and optional onInsertMany(payloads).
- Existing onInsert callers keep their current behavior.

- [ ] **Step 1: Extend the policy test for mixed source order**

~~~ts
test("keeps reordered upload and asset references in the submitted order", () => {
  const ordered = dedupeImageReferences([ref("upload", "upload"), ref("asset", "asset"), ref("upload", "upload")]);
  expect(moveImageReference(ordered, 1, 0).map((item) => item.referenceKey)).toEqual(["asset:asset", "upload:upload"]);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: bun test web/tests/image-reference-policy.test.ts

Expected: PASS after Task 1, proving the UI state contract before rendering it.

- [ ] **Step 3: Implement tray, multi-select assets and workbench wiring**

~~~tsx
<ReferenceImageTray
  references={references}
  validation={validateImageReferences(adminModelId, references)}
  onChange={(next) => setReferences(dedupeImageReferences(next))}
  onRequestUpload={() => fileInputRef.current?.click()}
  onRequestAssets={() => setAssetPickerOpen(true)}
/>
~~~

Each card is draggable, has a visible 图片 N label, origin Tag, remove control, and keyboard-accessible previous/next buttons. Include a clear-all control. In multiple-images mode AssetPickerModal keeps selected asset IDs in a Set, only permits image assets, and returns them in rendered order on a confirm button. Map uploads, clipboard images, templates, generated results and assets to ImageReferenceItem with a source label. Replace the workbench's local arrow strip with ReferenceImageTray and use validation both for the visible message and canGenerate.

- [ ] **Step 4: Verify UI code and types**

Run: bun test web/tests/image-reference-policy.test.ts && bun --cwd web run build

Expected: PASS; existing single-insert asset callers compile unchanged.

- [ ] **Step 5: Commit**

~~~bash
git add web/src/components/reference-images/reference-image-tray.tsx web/src/components/canvas/asset-picker-modal.tsx web/src/pages/image/index.tsx web/tests/image-reference-policy.test.ts
git commit -m "feat: unify image workbench references"
~~~

## Task 3: Persist and resolve canvas references

**Files:**

- Create: web/src/lib/canvas/canvas-image-references.ts
- Modify: web/src/types/canvas.ts
- Modify: web/src/components/canvas/canvas-node-generation.ts
- Test: web/tests/canvas-image-references.test.ts

**Interfaces:**

- CanvasStoredImageReference contains referenceKey, id, name, type, content, storageKey, sourceNodeId and origin.
- CanvasNodeMetadata gains manualImageReferences, excludedConnectedImageReferenceKeys and imageReferenceOrder.
- resolveCanvasImageReferences(node, nodes, connections) returns ImageReferenceItem[].
- applyCanvasReferenceOrder(references, order) appends newly connected references after saved keys.

- [ ] **Step 1: Write failing merge and persistence tests**

~~~ts
test("merges manual and connected images in the saved tray order", () => {
  const result = resolveCanvasImageReferences(configNode, [connectedImageNode], [connection]);
  expect(result.map((item) => item.referenceKey)).toEqual(["manual:logo", "node:product"]);
});

test("keeps the connection but excludes a manually removed connected image", () => {
  const result = resolveCanvasImageReferences(excludedConfigNode, [connectedImageNode], [connection]);
  expect(result).toHaveLength(0);
});

test("restores saved order after serialization", () => {
  expect(applyCanvasReferenceOrder([manualLogo, connectedProduct], ["node:product", "manual:logo"]).map((item) => item.referenceKey)).toEqual(["node:product", "manual:logo"]);
});
~~~

- [ ] **Step 2: Run the failing tests**

Run: bun test web/tests/canvas-image-references.test.ts

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement resolver and context integration**

~~~ts
export function resolveCanvasImageReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]): ImageReferenceItem[] {
  const manual = (node.metadata?.manualImageReferences || []).map(toReferenceItem);
  const connected = connectedImageReferences(node.id, nodes, connections)
    .filter((item) => !node.metadata?.excludedConnectedImageReferenceKeys?.includes(item.referenceKey));
  return applyCanvasReferenceOrder(dedupeImageReferences([...manual, ...connected]), node.metadata?.imageReferenceOrder || []);
}
~~~

Update buildNodeGenerationContext so its referenceImages come from this resolver for the active image-generation node. Keep text, video, audio and @ mention behavior unchanged.

- [ ] **Step 4: Run canvas tests and build**

Run: bun test web/tests/canvas-image-references.test.ts && bun --cwd web run build

Expected: PASS.

- [ ] **Step 5: Commit**

~~~bash
git add web/src/types/canvas.ts web/src/lib/canvas/canvas-image-references.ts web/src/components/canvas/canvas-node-generation.ts web/tests/canvas-image-references.test.ts
git commit -m "feat: persist canvas image references"
~~~

## Task 4: Add canvas selection controls and adopt the resolver everywhere

**Files:**

- Create: web/src/components/canvas/canvas-image-reference-dialog.tsx
- Modify: web/src/components/canvas/canvas-node-prompt-panel.tsx
- Modify: web/src/pages/canvas/project.tsx
- Test: web/tests/canvas-image-references.test.ts

**Interfaces:**

- CanvasImageReferenceDialog accepts open, nodes, selectedReferenceKeys, onConfirm(nodeIds) and onClose; only nodes with image content can be selected.
- CanvasNodePromptPanel receives references, referenceValidation and onReferenceAction.
- project.tsx converts UI changes into the Task 3 metadata fields.

- [ ] **Step 1: Add failing manual-selection and limit tests**

~~~ts
test("adds selected image nodes without requiring a connection", () => {
  expect(addCanvasNodesAsManualReferences([], [imageNodeA, imageNodeB]).map((item) => item.referenceKey)).toEqual(["node:image-a", "node:image-b"]);
});

test("blocks an over-limit GPT canvas list before submission", () => {
  expect(validateImageReferences("gpt-image-2", Array.from({ length: 17 }, (_, i) => canvasRef(String(i)))).valid).toBe(false);
});
~~~

- [ ] **Step 2: Run the focused test**

Run: bun test web/tests/canvas-image-references.test.ts

Expected: FAIL until the selection helper is added.

- [ ] **Step 3: Implement dialog, metadata updates and submission guards**

~~~ts
const references = resolveCanvasImageReferences(sourceNode, nodesRef.current, connectionsRef.current);
const validation = validateImageReferences(modelOptionName(generationConfig.model), references);
if (!validation.valid) {
  message.error(validation.message);
  finishGenerationRequest(nodeId, runController);
  return;
}
const generated = references.length
  ? await requestEdit(generationConfig, effectivePrompt, references, undefined, { signal: controller.signal })
  : await requestGeneration(generationConfig, effectivePrompt, { signal: controller.signal });
~~~

The project page must use this same resolved list for quick generate, normal node generate, batch generate and retry metadata reconstruction. Removing a connected card adds its key to excludedConnectedImageReferenceKeys; removing a manual card deletes it from manualImageReferences; dragging saves imageReferenceOrder. Upload and asset actions call uploadImage first and persist the returned URL and storage key.

- [ ] **Step 4: Run all frontend tests and build**

Run: bun --cwd web test && bun --cwd web run build

Expected: PASS; no test invokes a real provider.

- [ ] **Step 5: Verify the local demo UI without submitting a task**

1. Open /image, add two uploads and two image assets, reorder, and confirm the labels become 图片 1–4.
2. With GPT-Image-2 selected, make 17 references and confirm the 16-image validation message appears without a task request.
3. In a canvas project, select two image nodes via the dialog, reorder, refresh, and confirm order persists.
4. Connect another image node, remove it from the tray, and confirm its connection remains while its reference count drops.

- [ ] **Step 6: Commit**

~~~bash
git add web/src/components/canvas/canvas-image-reference-dialog.tsx web/src/components/canvas/canvas-node-prompt-panel.tsx web/src/pages/canvas/project.tsx web/tests/canvas-image-references.test.ts
git commit -m "feat: add canvas multi-image references"
~~~

## Final Verification

- [ ] Run bun --cwd web test and record zero failures.
- [ ] Run bun --cwd web run build and confirm the production bundle completes.
- [ ] Run git status --short and confirm no API key, .env file, generated asset or unrelated change is staged.

