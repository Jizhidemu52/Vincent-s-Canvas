import { describe, expect, test } from "bun:test";

import { createCanvasSelectionPromptSync } from "@/lib/canvas/canvas-selection-prompt";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

function image(id: string, prompt?: string): CanvasNodeData {
    return { id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `blob:${id}`, prompt } };
}

describe("canvas selected image prompt", () => {
    test("recalls the selected image's exact prompt and switches between images", () => {
        const sync = createCanvasSelectionPromptSync();
        const first = image("first", "第一张图\n保留换行  ");
        const second = image("second", "第二张图");
        expect(sync(new Set([first.id]), [first])).toBe(first.metadata!.prompt);
        expect(sync(new Set([second.id]), [second])).toBe(second.metadata!.prompt);
        expect(sync(new Set([first.id]), [first])).toBe(first.metadata!.prompt);
    });

    test("does not replace typed text on repeated selection, movement, or metadata refresh", () => {
        const sync = createCanvasSelectionPromptSync();
        const node = image("selected", "原始提示词");
        expect(sync(new Set([node.id]), [node])).toBe("原始提示词");
        expect(sync(new Set([node.id]), [node])).toBeUndefined();
        expect(sync(new Set([node.id]), [{ ...node, position: { x: 100, y: 200 } }])).toBeUndefined();
        expect(sync(new Set([node.id]), [{ ...node, metadata: { ...node.metadata, prompt: "刷新后的元数据" } }])).toBeUndefined();
    });

    test("clears previous prompts for uploads and ambiguous multiple selection", () => {
        const sync = createCanvasSelectionPromptSync();
        const first = image("first", "第一张图");
        const second = image("second", "第二张图");
        const upload = image("upload");
        expect(sync(new Set([first.id]), [first])).toBe("第一张图");
        expect(sync(new Set([upload.id]), [upload])).toBe("");
        expect(sync(new Set([first.id, second.id]), [first, second])).toBe("");
        expect(sync(new Set([second.id, first.id]), [second, first])).toBeUndefined();
        expect(sync(new Set([second.id]), [second])).toBe("第二张图");
    });

    test("leaves a creation draft intact when deselecting, and restores the prompt on reselection", () => {
        const sync = createCanvasSelectionPromptSync();
        const node = image("selected", "原始提示词");
        expect(sync(new Set(), [])).toBeUndefined();
        expect(sync(new Set([node.id]), [node])).toBe("原始提示词");
        expect(sync(new Set(), [])).toBeUndefined();
        expect(sync(new Set([node.id]), [node])).toBe("原始提示词");
    });

    test("waits for missing selected nodes and respects project identity", () => {
        const sync = createCanvasSelectionPromptSync();
        const node = image("selected", "原始提示词");
        expect(sync(new Set([node.id]), [], "first-project")).toBeUndefined();
        expect(sync(new Set([node.id]), [node], "first-project")).toBe("原始提示词");
        expect(sync(new Set([node.id]), [image(node.id, "另一画布提示词")], "second-project")).toBe("另一画布提示词");
    });

    test("does not use titles, drafts, or another node's prompt as image provenance", () => {
        const sync = createCanvasSelectionPromptSync();
        const upload = { ...image("upload"), title: "不是提示词", metadata: { content: "blob:upload", draftPrompt: "不是原始提示词" } };
        expect(sync(new Set([upload.id]), [image("other", "别图提示词"), upload])).toBe("");
        expect(sync(new Set(["text"]), [{ ...image("text", "文本生成提示词"), type: CanvasNodeType.Text }])).toBeUndefined();
    });
});
