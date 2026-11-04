import { expect, test } from "bun:test";
import { applyNodeConfigPatch } from "@/pages/canvas/canvas-project-utils";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const prompt = "提取 Image 1 背心的正面平面图，条纹改用 Image 2 的天蓝色与浅黄色。";
const optimized: CanvasNodeData = {
    id: "config", type: CanvasNodeType.Config, title: "生成配置", position: { x: 20, y: 30 }, width: 320, height: 320,
    metadata: {
        model: "gpt-image-2", prompt, composerContent: prompt, compiledPrompt: prompt, size: "1:1", quality: "low",
        promptInput: { scene: "free-optimize", userText: "提取背心并改条纹颜色", fields: {}, mode: "edit", referenceRoles: ["背心", "配色"], compilationId: "11111111-1111-4111-8111-111111111111" },
    },
};

test("changing an optimized canvas model preserves visible text and removes only the stale manual optimization binding", () => {
    const before = structuredClone(optimized);
    const next = applyNodeConfigPatch(optimized, { model: "gemini-3.1-flash-image-preview" });
    expect(next.metadata).toEqual({ ...optimized.metadata, model: "gemini-3.1-flash-image-preview", promptInput: undefined, compiledPrompt: undefined });
    expect(next.metadata?.prompt).toBe(prompt);
    expect(next.metadata?.composerContent).toBe(prompt);
    expect(optimized).toEqual(before);
});

test("the same model, implicit image mode, and output-only parameters preserve the valid compilation", () => {
    for (const patch of [{}, { model: "gpt-image-2" }, { generationMode: "image" as const }, { size: "3:2", quality: "high", imageOptions: '{"output_format":"png"}' }]) {
        const next = applyNodeConfigPatch(optimized, patch);
        expect(next.metadata?.promptInput).toBe(optimized.metadata?.promptInput);
        expect(next.metadata?.compiledPrompt).toBe(prompt);
    }
});

test("changing media mode invalidates manual optimization without erasing text", () => {
    const next = applyNodeConfigPatch(optimized, { generationMode: "video" });
    expect(next.metadata).toMatchObject({ generationMode: "video", prompt, composerContent: prompt });
    expect(next.metadata?.promptInput).toBeUndefined();
    expect(next.metadata?.compiledPrompt).toBeUndefined();
});

test("an explicit new compilation remains authoritative, and structured recipe inputs are not silently bypassed", () => {
    const replacement = { ...optimized.metadata!.promptInput!, compilationId: "22222222-2222-4222-8222-222222222222" };
    const next = applyNodeConfigPatch(optimized, { model: "gemini-3.1-flash-image-preview", promptInput: replacement, compiledPrompt: prompt });
    expect(next.metadata?.promptInput).toBe(replacement);
    const structured: CanvasNodeData = { ...optimized, metadata: { ...optimized.metadata, promptInput: { ...optimized.metadata!.promptInput!, scene: "workflow-step" } } };
    expect(applyNodeConfigPatch(structured, { model: "gemini-3.1-flash-image-preview" }).metadata?.promptInput).toBe(structured.metadata?.promptInput);
});
