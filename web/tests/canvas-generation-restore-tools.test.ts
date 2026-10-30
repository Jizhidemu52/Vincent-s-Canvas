import { expect, test } from "bun:test";
import { createCanvasRestoredGenerationNode } from "@/lib/canvas/canvas-generation-draft";

const draft: Parameters<typeof createCanvasRestoredGenerationNode>[0] = {
    prompt: "已校验原稿", finalPrompt: "已校验最终提示词", userInput: undefined, optimized: false,
    config: { model: "original-model-config-id", imageModel: "original-model-config-id", size: "1536x1024", quality: "high", count: "1", systemPrompt: "", imageOptions: '{"background":"opaque"}' },
    references: [{ id: "history:task:0", name: "已校验原图.png", originalFileName: "已校验原图.png", type: "image/png", dataUrl: "data:image/png;base64,b3JpZ2luYWw=" }],
    operationType: "inpaint", tool: "canvas-edit", parameters: {}, maskReferenceIndex: undefined,
};

test.each(["image-generation", "image-edit", "canvas-image", "canvas-edit"])("verified ordinary %s archive creates a separate config without modifying its inputs", tool => {
    const input = { ...draft, tool };
    const before = structuredClone(input);
    const node = createCanvasRestoredGenerationNode(input, { x: 30, y: 40 });
    expect(node.type).toBe("config");
    expect(node.metadata).toMatchObject({ model: draft.config.model, size: "1536x1024", quality: "high", prompt: draft.prompt, composerContent: draft.prompt, status: "idle" });
    expect(node.metadata?.manualImageReferences?.map(reference => [reference.name, reference.content])).toEqual([[draft.references[0]!.name, draft.references[0]!.dataUrl]]);
    expect(input).toEqual(before);
    expect(node.metadata?.generationRecord).toBeUndefined();
});

test.each(["canvas-angle", "canvas-mask-edit", "canvas-batch", "image-upscale", "unknown-tool"])("specialized %s archives remain rejected by ordinary restore", tool => {
    expect(() => createCanvasRestoredGenerationNode({ ...draft, tool }, { x: 0, y: 0 })).toThrow("专用工具");
});

test.each([{ maskReferenceIndex: 0 }, { parameters: { mask: true } }, { parameters: { maskUrl: "/mask" } }, { parameters: { maskDataUrl: "data:mask" } }])("canvas-edit archives with any mask channel remain rejected: %j", mask => {
    expect(() => createCanvasRestoredGenerationNode({ ...draft, ...mask }, { x: 0, y: 0 })).toThrow("蒙版");
});

test("an allowed tool name cannot bypass a non-image operation", () => {
    expect(() => createCanvasRestoredGenerationNode({ ...draft, tool: "canvas-image", operationType: "video_generation" }, { x: 0, y: 0 })).toThrow("专用工具");
});
