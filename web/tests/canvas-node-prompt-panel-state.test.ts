import { describe, expect, test } from "bun:test";
import { canvasNodePromptPanelInput, createCanvasNodePromptDraft } from "@/components/canvas/canvas-node-prompt-panel-state";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasGenerationRecord, type CanvasNodeData } from "@/types/canvas";

const image = (id: string, content = `https://local/${id}`): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, width: 100, height: 100, position: { x: 0, y: 0 }, metadata: { content } });
const source = image("source");
const record: CanvasGenerationRecord = {
    version: 1, id: "run", sourceNodeId: source.id, createdAt: "2026-10-30T00:00:00Z", prompt: "compiled input", inputPrompt: "original input",
    parameters: { model: "archived-model", size: "3:2", quality: "2k", imageOptions: "options", systemPrompt: "", count: 1, generationType: "edit" },
    references: [
        { id: source.id, sourceNodeId: source.id, referenceKey: "node:source", origin: "canvas", name: "source.png", type: "image/png", content: source.metadata!.content!, order: 0 },
        { id: "upload", referenceKey: "upload:ref", origin: "upload", name: "upload.png", type: "image/png", content: "https://local/upload", order: 1 },
    ],
};
const result: CanvasNodeData = { ...image("result", ""), metadata: { generationRecord: record, prompt: record.prompt } };

describe("empty-result node panel input", () => {
    test("uses the saved input and parameters instead of the compiled prompt and global defaults", () => {
        const state = canvasNodePromptPanelInput(result, [source, result], [], defaultConfig);
        expect(state.prompt).toBe("original input");
        expect(state.config).toMatchObject({ model: "archived-model", size: "3:2", quality: "2k", imageOptions: "options", count: "1" });
        expect(state.references.map(reference => reference.referenceKey)).toEqual(["node:source", "upload:ref"]);
        expect(state.usesSnapshot).toBe(true);
    });

    test("hides deleted sources without removing request inputs or renumbering remaining references", () => {
        const before = structuredClone(record);
        const state = canvasNodePromptPanelInput(result, [result], [], defaultConfig);
        expect(state.references).toHaveLength(2);
        expect(state.visibleReferences.map(({ reference, index }) => [reference.referenceKey, index])).toEqual([["upload:ref", 1]]);
        expect(state.mentions.map(reference => reference.label)).toEqual(["图片2"]);
        expect(record).toEqual(before);
    });

    test("honors an explicit empty draft and reference override", () => {
        const changed = { ...result, metadata: { ...result.metadata, draftPrompt: "", draftImageReferences: [], model: "draft-model" } };
        const state = canvasNodePromptPanelInput(changed, [source, changed], [], defaultConfig);
        expect(state.prompt).toBe("");
        expect(state.references).toEqual([]);
        expect(state.config.model).toBe("draft-model");
        expect(state.incompleteReferences).toBe(false);
        expect(changed.metadata.generationRecord).toBe(record);
    });

    test("keeps unsaved new-node input editable and preserves its configured image count", () => {
        const node = { ...image("new", ""), metadata: { prompt: "new input" } };
        const state = canvasNodePromptPanelInput(node, [source, node], [{ id: "edge", fromNodeId: source.id, toNodeId: node.id }], { ...defaultConfig, count: "4" });
        expect(state.usesSnapshot).toBe(false);
        expect(state.config.count).toBe("4");
        expect(state.references[0]?.id).toBe(source.id);
    });

    test("does not invent references from live connections for incomplete legacy results", () => {
        const legacy = { ...image("legacy", ""), metadata: { prompt: "old input", generationType: "edit" as const, sourceTaskId: "task" } };
        const state = canvasNodePromptPanelInput(legacy, [source, legacy], [{ id: "edge", fromNodeId: source.id, toNodeId: legacy.id }], defaultConfig);
        expect(state.usesSnapshot).toBe(true);
        expect(state.incompleteReferences).toBe(true);
        expect(state.references).toEqual([]);
        const overridden = canvasNodePromptPanelInput({ ...legacy, metadata: { ...legacy.metadata, draftImageReferences: [] } }, [legacy], [], defaultConfig);
        expect(overridden.incompleteReferences).toBe(false);
    });
});

test("pending draft stays scoped to its original node when selection and callback change", () => {
    let nextId = 0;
    const pending = new Map<number, () => void>();
    const commits: Array<[string, string, string]> = [];
    let currentCommit = (id: string, value: string) => { commits.push(["first-handler", id, value]); };
    const scheduler = { set(callback: () => void) { const id = nextId++; pending.set(id, callback); return id; }, clear(id: unknown) { pending.delete(id as number); } };
    const first = createCanvasNodePromptDraft("first", "saved first", (id, value) => currentCommit(id, value), scheduler);
    first.change("pending first");
    currentCommit = (id, value) => { commits.push(["latest-handler", id, value]); };
    const second = createCanvasNodePromptDraft("second", "saved second", (id, value) => currentCommit(id, value), scheduler);
    second.change("pending second");
    first.flush();
    for (const callback of [...pending.values()]) callback();
    expect(commits).toEqual([["latest-handler", "first", "pending first"], ["latest-handler", "second", "pending second"]]);
});
