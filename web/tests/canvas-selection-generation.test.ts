import { describe, expect, test } from "bun:test";

import { createCanvasSelectionGenerationSync } from "@/lib/canvas/canvas-selection-prompt";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

function image(id: string, metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `blob:${id}`, ...metadata } };
}

describe("canvas selected image generation settings", () => {
    test("switches every saved parameter between generated images without normalizing model-specific values", () => {
        const sync = createCanvasSelectionGenerationSync();
        const first = image("first", { prompt: "第一张图\n保留换行  ", model: "gpt-image-2.5-flare", size: "2048x1152", quality: "xhigh", count: 4, imageOptions: '{"background":"transparent","output_format":"png"}' });
        const second = image("second", { prompt: "第二张图", model: "gemini-3.1-flash-image-preview", size: "16:9", quality: "4k", count: 2, imageOptions: '{"google_search":"true"}' });

        expect(sync(new Set([first.id]), [first])).toEqual({ prompt: "第一张图\n保留换行  ", model: "gpt-image-2.5-flare", size: "2048x1152", quality: "xhigh", count: 4, imageOptions: '{"background":"transparent","output_format":"png"}' });
        expect(sync(new Set([second.id]), [second])).toEqual({ prompt: "第二张图", model: "gemini-3.1-flash-image-preview", size: "16:9", quality: "4k", count: 2, imageOptions: '{"google_search":"true"}' });
        expect(sync(new Set([first.id]), [first])).toMatchObject({ model: "gpt-image-2.5-flare", quality: "xhigh", count: 4 });
    });

    test("does not overwrite a draft for repeated selection, movement, or metadata refresh", () => {
        const sync = createCanvasSelectionGenerationSync();
        const node = image("selected", { prompt: "原始提示词", model: "gpt-image-2", quality: "high", count: 3 });
        expect(sync(new Set([node.id]), [node])).toMatchObject({ prompt: "原始提示词", quality: "high", count: 3 });
        expect(sync(new Set([node.id]), [node])).toBeUndefined();
        expect(sync(new Set([node.id]), [{ ...node, position: { x: 100, y: 200 } }])).toBeUndefined();
        expect(sync(new Set([node.id]), [{ ...node, metadata: { ...node.metadata, prompt: "刷新后的提示词", model: "gpt-image-2.5-sunburst", quality: "max", count: 8 } }])).toBeUndefined();
    });

    test("preserves a draft on deselection and recalls settings when the image is selected again", () => {
        const sync = createCanvasSelectionGenerationSync();
        const node = image("selected", { prompt: "原始提示词", model: "gpt-image-2", count: 5 });
        expect(sync(new Set(), [])).toBeUndefined();
        expect(sync(new Set([node.id]), [node])).toMatchObject({ prompt: "原始提示词", model: "gpt-image-2", count: 5 });
        expect(sync(new Set(), [])).toBeUndefined();
        expect(sync(new Set([node.id]), [node])).toMatchObject({ prompt: "原始提示词", model: "gpt-image-2", count: 5 });
    });

    test("treats the same node id in another project as a different selection", () => {
        const sync = createCanvasSelectionGenerationSync();
        expect(sync(new Set(["shared-id"]), [image("shared-id", { prompt: "第一画布", model: "gpt-image-2", count: 2 })], "first-project")).toMatchObject({ prompt: "第一画布", model: "gpt-image-2", count: 2 });
        expect(sync(new Set(["shared-id"]), [image("shared-id", { prompt: "第二画布", model: "gpt-image-2.5-flare", count: 6 })], "second-project")).toMatchObject({ prompt: "第二画布", model: "gpt-image-2.5-flare", count: 6 });
    });

    test("waits for a missing selected node without using another node or consuming the selection", () => {
        const sync = createCanvasSelectionGenerationSync();
        const unrelated = image("other", { prompt: "别图提示词", model: "wrong-model" });
        const selected = image("selected", { prompt: "正确提示词", model: "gpt-image-2", quality: "high" });
        expect(sync(new Set([selected.id]), [unrelated], "project")).toBeUndefined();
        expect(sync(new Set([selected.id]), [], "project")).toBeUndefined();
        expect(sync(new Set([selected.id]), [unrelated, selected], "project")).toEqual({ prompt: "正确提示词", model: "gpt-image-2", quality: "high" });
    });

    test("uploads clear only the prompt and never invent settings from title or draft text", () => {
        const sync = createCanvasSelectionGenerationSync();
        const generated = image("generated", { prompt: "生成提示词", model: "gpt-image-2", quality: "high", count: 4 });
        const uploaded = { ...image("upload", { draftPrompt: "编辑中的草稿" }), title: "文件名不是提示词" };
        expect(sync(new Set([generated.id]), [generated])).toMatchObject({ model: "gpt-image-2", count: 4 });
        expect(sync(new Set([uploaded.id]), [uploaded])).toEqual({ prompt: "" });
    });

    test("multiple selection clears only the prompt and ignores selection order changes", () => {
        const sync = createCanvasSelectionGenerationSync();
        const first = image("first", { prompt: "第一张", model: "gpt-image-2", count: 4 });
        const second = image("second", { prompt: "第二张", model: "gpt-image-2.5-flare", count: 2 });
        expect(sync(new Set([first.id, second.id]), [first, second])).toEqual({ prompt: "" });
        expect(sync(new Set([second.id, first.id]), [second, first])).toBeUndefined();
        expect(sync(new Set([second.id]), [first, second])).toMatchObject({ prompt: "第二张", model: "gpt-image-2.5-flare", count: 2 });
    });

    test("non-image selection does not refill the image composer", () => {
        const sync = createCanvasSelectionGenerationSync();
        const metadata = { prompt: "非图片提示词", model: "not-an-image-model", count: 9 };
        for (const type of [CanvasNodeType.Text, CanvasNodeType.Config, CanvasNodeType.Video, CanvasNodeType.Audio]) {
            const node = { ...image(type, metadata), type };
            expect(sync(new Set([node.id]), [node])).toBeUndefined();
        }
    });

    test("keeps an explicitly empty advanced settings value so prior options can be cleared", () => {
        const sync = createCanvasSelectionGenerationSync();
        const first = image("with-options", { prompt: "透明背景", model: "gpt-image-2", imageOptions: '{"background":"transparent"}' });
        const second = image("default-options", { prompt: "默认背景", model: "gpt-image-2", imageOptions: "" });
        expect(sync(new Set([first.id]), [first])).toMatchObject({ imageOptions: '{"background":"transparent"}' });
        const restored = sync(new Set([second.id]), [second]);
        expect(restored).toEqual({ prompt: "默认背景", model: "gpt-image-2", imageOptions: "" });
        expect(Object.hasOwn(restored!, "imageOptions")).toBe(true);
    });

    test("returns parameters without replacing the selected result with its historical input references", () => {
        const sync = createCanvasSelectionGenerationSync();
        const node = image("result", {
            prompt: "把原图改成蓝色", model: "gpt-image-2", size: "1024x1024", quality: "high", count: 2, imageOptions: "",
            generationType: "edit", references: ["image:original"], compareSources: [{ type: "image", content: "blob:original", storageKey: "image:original" }],
            manualImageReferences: [{ id: "input", referenceKey: "input", name: "original.png", type: "image/png", content: "blob:original", origin: "upload" }],
        });
        const restored = sync(new Set([node.id]), [node]);
        expect(restored).toEqual({ prompt: "把原图改成蓝色", model: "gpt-image-2", size: "1024x1024", quality: "high", count: 2, imageOptions: "" });
        expect(Object.keys(restored!).sort()).toEqual(["count", "imageOptions", "model", "prompt", "quality", "size"]);
        expect(node.metadata!.references).toEqual(["image:original"]);
        expect(node.metadata!.content).toBe("blob:result");
    });
});
