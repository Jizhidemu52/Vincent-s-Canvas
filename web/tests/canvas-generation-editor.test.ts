import { describe, expect, test } from "bun:test";
import { canvasContinueFromImagePatch, canvasGenerationDerivatives, canvasGenerationEditorState, storeCanvasEditorReferences, visibleCanvasEditorReferences } from "@/lib/canvas/canvas-generation-editor";
import { CanvasNodeType, type CanvasGenerationRecord, type CanvasNodeData } from "@/types/canvas";
import { defaultConfig } from "@/stores/use-config-store";

const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, width: 100, height: 100, position: { x: 0, y: 0 }, metadata: { content: `https://local/${id}`, storageKey: `${id}.png` } });
const original = image("purple");
const archive: CanvasGenerationRecord = {
    version: 1, id: "run-1", sourceNodeId: original.id, createdAt: "2026-10-30T00:00:00Z", prompt: "expanded blue", inputPrompt: "blue",
    parameters: { model: "m", size: "1:1", quality: "1k", imageOptions: "", systemPrompt: "", count: 1, generationType: "edit" },
    references: [{ id: original.id, referenceKey: `node:${original.id}`, name: "purple.png", type: "image/png", content: original.metadata!.content!, storageKey: original.metadata!.storageKey, sourceNodeId: original.id, origin: "canvas", order: 0 }],
};
const result = { ...image("blue"), metadata: { ...image("blue").metadata, prompt: archive.prompt, generationRecord: archive } };

describe("node-owned generation editor", () => {
    test("selecting a result recalls original inputs, not the output itself", () => {
        const state = canvasGenerationEditorState(result, [original, result], [], defaultConfig);
        expect(state.prompt).toBe("blue");
        expect(state.references).toHaveLength(1);
        expect(state.references[0].canvasNodeId).toBe(original.id);
        expect(state.references[0].storageKey).toBe("purple.png");
        expect(state.model).toBe("m");
    });
    test("hidden removed reference remains in request snapshot and survives an editor roundtrip", () => {
        const state = canvasGenerationEditorState(result, [result], [], defaultConfig);
        expect(visibleCanvasEditorReferences(state.references, [result])).toEqual([]);
        expect(state.references[0].storageKey).toBe("purple.png");
        expect(storeCanvasEditorReferences(state.references)[0].sourceNodeId).toBe("purple");
        expect(archive.references).toHaveLength(1);
    });
    test("an intentionally empty draft and no-reference choice do not fall back to the archive", () => {
        const changed = { ...result, metadata: { ...result.metadata, draftPrompt: "", draftImageReferences: [] } };
        const state = canvasGenerationEditorState(changed, [original, result], [], defaultConfig);
        expect(state.prompt).toBe("");
        expect(state.references).toEqual([]);
        expect(result.metadata.generationRecord).toBe(archive);
    });
    test("continue uses exactly the result image without rewriting original evidence", () => {
        const patch = canvasContinueFromImagePatch(result);
        const changed = { ...result, metadata: { ...result.metadata, ...patch } };
        const state = canvasGenerationEditorState(changed, [original, result], [], defaultConfig);
        expect(state.prompt).toBe("");
        expect(state.references[0].canvasNodeId).toBe("blue");
        expect(state.references[0].storageKey).toBe("blue.png");
        expect(changed.metadata.generationRecord).toBe(archive);
        expect(archive.references[0].storageKey).toBe("purple.png");
    });
    test("derivatives use recorded parentage without reporting a self edge", () => {
        expect(canvasGenerationDerivatives(original.id, [original, result]).map(node => node.id)).toEqual([result.id]);
        expect(canvasGenerationDerivatives(result.id, [original, result])).toEqual([]);
    });
});
