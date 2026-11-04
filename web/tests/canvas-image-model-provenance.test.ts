import { expect, test } from "bun:test";
import { canvasGenerationEditorState } from "@/lib/canvas/canvas-generation-editor";
import { canvasGenerationDraftResetPatch, canvasGenerationModel, canvasGenerationRecordConfig, createCanvasGenerationRecord } from "@/lib/canvas/canvas-generation-record";
import { canvasNodePromptPanelInput } from "@/components/canvas/canvas-node-prompt-panel-state";
import { applyNodeConfigPatch, buildGenerationConfig } from "@/pages/canvas/canvas-project-utils";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const upload: CanvasNodeData = { id: "upload", type: CanvasNodeType.Image, title: "image.png", position: { x: 0, y: 0 }, width: 120, height: 120, metadata: { content: "blob:upload" } };
const legacy: CanvasNodeData = { ...upload, id: "legacy", metadata: { ...upload.metadata, prompt: "旧图自己的提示词", model: "legacy-model", generationType: "generation", references: [] } };
const record = createCanvasGenerationRecord({ id: "run", sourceNodeId: "", prompt: "现代图自己的提示词", config: { ...defaultConfig, model: "recorded-model" }, references: [], nodes: [], generationType: "generation" });
const modern: CanvasNodeData = { ...upload, id: "modern", metadata: { ...upload.metadata, model: "recorded-model", generationRecord: record } };

test.each([upload, legacy, modern])("image $id stores the next model separately, preserves evidence, and reopens its own draft", node => {
    const before = structuredClone(node);
    const expectedModel = canvasGenerationModel(node);
    const changed = applyNodeConfigPatch(node, { model: "next-model" });
    expect(changed.metadata.draftModel).toBe("next-model");
    expect(changed.metadata.model).toBe(node.metadata?.model);
    expect(canvasGenerationModel(changed)).toBe(expectedModel);
    expect(node).toEqual(before);
    const reopened: CanvasNodeData = JSON.parse(JSON.stringify(changed));
    expect(canvasGenerationEditorState(reopened, [reopened], [], defaultConfig).model).toBe("next-model");
    expect(buildGenerationConfig(defaultConfig, reopened, "image").model).toBe("next-model");
    const panel = canvasNodePromptPanelInput(reopened, [reopened], [], buildGenerationConfig(defaultConfig, reopened, "image"));
    expect(panel.config.model).toBe("next-model");
    expect(canvasGenerationModel(reopened)).toBe(expectedModel);
    const reset = { ...reopened, metadata: { ...reopened.metadata, ...canvasGenerationDraftResetPatch(reopened) } };
    expect(reset.metadata.draftModel).toBeUndefined();
    expect(canvasGenerationModel(reset)).toBe(expectedModel);
    expect(canvasGenerationEditorState(reset, [reset], [], defaultConfig).model).toBe(expectedModel || defaultConfig.imageModel || defaultConfig.model);
});

test("original replay keeps the archived model while a new draft uses a different one", () => {
    const changed = applyNodeConfigPatch(modern, { model: "next-model" });
    expect(buildGenerationConfig(defaultConfig, changed, "image").model).toBe("next-model");
    expect(canvasGenerationRecordConfig(changed.metadata.generationRecord!, defaultConfig).model).toBe("recorded-model");
    expect(changed.metadata.generationRecord).toBe(record);
});

test("changing an image draft model invalidates free optimization but never invalidates the immutable archive", () => {
    const optimized: CanvasNodeData = { ...modern, metadata: { ...modern.metadata, promptInput: { scene: "free-optimize", userText: "优化草稿", fields: {}, mode: "generate", referenceRoles: [] }, compiledPrompt: "旧模型编译" } };
    const changed = applyNodeConfigPatch(optimized, { model: "next-model" });
    expect(changed.metadata.promptInput).toBeUndefined();
    expect(changed.metadata.compiledPrompt).toBeUndefined();
    expect(changed.metadata.generationRecord).toBe(record);
    const unchanged = applyNodeConfigPatch(optimized, { model: "recorded-model" });
    expect(unchanged.metadata.promptInput).toBe(optimized.metadata!.promptInput);
});

test("configuration nodes still update their live model rather than creating image provenance", () => {
    const config = applyNodeConfigPatch({ ...modern, type: CanvasNodeType.Config }, { model: "next-model" });
    expect(config.metadata.model).toBe("next-model");
    expect(config.metadata.draftModel).toBeUndefined();
});
