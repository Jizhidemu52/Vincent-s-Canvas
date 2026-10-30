import { expect, test } from "bun:test";
import { canvasGenerationDraft, canvasGenerationDraftResetPatch, canvasGenerationRecordConfig, canvasGenerationRecordReferences, canvasNodeGenerationReferences, compiledCanvasGenerationRecord, createCanvasGenerationRecord, hasIncompleteCanvasGenerationReferences, visibleCanvasGenerationReferences } from "@/lib/canvas/canvas-generation-record";
import { portableCanvasMedia } from "@/lib/canvas/canvas-portable-media";
import { collectImageStorageKeys } from "@/services/image-storage";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { prepareImageSequenceStep } from "@/lib/canvas/canvas-image-sequence";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 200, height: 200,
    metadata: { content: "blob:source", storageKey: "image:source", originalFileName: "原图.png" } };
function record() { return createCanvasGenerationRecord({ id: "run", sourceNodeId: "source", prompt: "最终提示词", inputPrompt: "我的原稿", generationType: "edit", config: { ...defaultConfig, model: "gpt-image-2", size: "3:2", systemPrompt: "system" }, nodes: [source], references: [
    { id: "source", name: "原图.png", type: "image/png", dataUrl: "data:image/png;base64,hydrated", storageKey: "image:source" },
    { id: "upload", name: "上传参考.png", type: "image/png", dataUrl: "blob:uploaded", storageKey: "image:upload" },
] }); }

test("generation snapshots preserve reference identity/order/storage independently from live input edits", () => {
    const saved = record();
    const original = structuredClone(saved);
    expect(saved.references.map(item => [item.name, item.sourceNodeId, item.order, item.content])).toEqual([["原图.png", "source", 0, "blob:source"], ["上传参考.png", undefined, 1, "blob:uploaded"]]);
    const changed = { ...source, metadata: { ...source.metadata, content: "blob:changed", storageKey: "image:changed" } };
    const result: CanvasNodeData = { ...source, id: "result", metadata: { content: "blob:result", generationRecord: saved, draftPrompt: "改后的原稿", model: "another-model" } };
    expect(canvasNodeGenerationReferences(result, [result, changed], []).map(item => item.storageKey)).toEqual(["image:source", "image:upload"]);
    expect(canvasNodeGenerationReferences(result, [result], [], { visibleOnly: true }).map(item => item.id)).toEqual(["upload"]);
    expect(visibleCanvasGenerationReferences(saved, [result]).map(item => item.order)).toEqual([1]);
    expect(canvasGenerationRecordReferences(saved)).toHaveLength(2);
    expect(saved).toEqual(original);
    expect(collectImageStorageKeys(result)).toEqual(new Set(["image:source", "image:upload"]));
});

test("selection references bind explicit canvasNodeId without mistaking a same-id upload for a canvas node", () => {
    const references = [{ id: "canvas:source", canvasNodeId: "source", name: "选中原图", type: "image/png", dataUrl: "blob:source", origin: "canvas" as const },
        { id: "source", name: "独立上传", type: "image/png", dataUrl: "blob:other", origin: "upload" as const }];
    const saved = createCanvasGenerationRecord({ id: "run", sourceNodeId: "source", prompt: "p", generationType: "edit", config: defaultConfig, nodes: [source], references });
    expect(saved.references.map(item => item.sourceNodeId)).toEqual(["source", undefined]);
});

test("draft reference overrides including empty arrays do not mutate the archive and reset restores original inputs", () => {
    const saved = record();
    const result: CanvasNodeData = { ...source, id: "result", metadata: { generationRecord: saved, draftPrompt: "", draftImageReferences: [], model: "changed" } };
    expect(canvasGenerationDraft(result)).toBe("");
    expect(canvasNodeGenerationReferences(result, [source, result], [])).toEqual([]);
    result.metadata = { ...result.metadata, ...canvasGenerationDraftResetPatch(result) };
    expect(canvasGenerationDraft(result)).toBe("我的原稿");
    expect(result.metadata.model).toBe("gpt-image-2");
    expect(canvasNodeGenerationReferences(result, [source, result], [])).toHaveLength(2);
    expect(canvasGenerationRecordConfig(saved, { ...defaultConfig, model: "changed", size: "1:1" })).toMatchObject({ model: "gpt-image-2", size: "3:2", systemPrompt: "system", count: "1" });
});

test("resubmitting archived references keeps source identity after deletion; final compilation replaces only final prompt", () => {
    const saved = record();
    const again = createCanvasGenerationRecord({ id: "again", sourceNodeId: "result", prompt: "next", generationType: "edit", config: defaultConfig, nodes: [], references: canvasGenerationRecordReferences(saved) });
    expect(again.references[0]!.sourceNodeId).toBe("source");
    const compiled = compiledCanvasGenerationRecord(saved, "服务端最终提示词")!;
    expect(saved.prompt).toBe("最终提示词");
    expect(compiled.prompt).toBe("服务端最终提示词");
    expect(compiled.inputPrompt).toBe("我的原稿");
    expect(compiled.references).toBe(saved.references);
});

test("cloud traversal uploads archived and draft references without retaining stale blob URLs or local keys", async () => {
    const saved = record();
    const result = { metadata: { generationRecord: saved, draftImageReferences: saved.references } };
    const uploads: string[] = [];
    const portable = await portableCanvasMedia(result, async input => { uploads.push(input.storageKey!); return `/api/assets/${input.storageKey!.slice(6)}/content`; });
    expect(uploads).toEqual(["image:source", "image:upload"]);
    expect(portable.metadata.generationRecord.references.map(item => item.content)).toEqual(["/api/assets/source/content", "/api/assets/upload/content"]);
    expect(JSON.stringify(portable)).not.toContain('"storageKey"');
    expect(saved.references[0]!.storageKey).toBe("image:source");
});

test("legacy generated images read ordered archived inputs without inventing source node ids or referring to themselves", () => {
    const legacy: CanvasNodeData = { ...source, id: "legacy-result", metadata: { content: "blob:result", storageKey: "image:result", generationType: "edit",
        references: ["image:second", "/api/assets/first/content"], compareSources: [
            { type: "image", storageKey: "image:second", content: "blob:second", label: "第二原图.png" },
            { type: "image", content: "/api/assets/first/content", label: "第一原图.png" },
        ] } };
    const before = structuredClone(legacy);
    const refs = canvasNodeGenerationReferences(legacy, [source, legacy], [{ id: "new-edge", fromNodeId: source.id, toNodeId: legacy.id }]);
    expect(refs.map(ref => [ref.name, ref.storageKey, ref.dataUrl])).toEqual([["第二原图.png", "image:second", "blob:second"], ["第一原图.png", undefined, "/api/assets/first/content"]]);
    expect(refs.every(ref => !("sourceNodeId" in ref) && ref.id !== legacy.id)).toBe(true);
    expect(hasIncompleteCanvasGenerationReferences(legacy)).toBe(false);
    expect(canvasNodeGenerationReferences(legacy, [legacy], [], { visibleOnly: true })).toEqual(refs);
    expect(legacy).toEqual(before);
    expect(legacy.metadata?.generationRecord).toBeUndefined();
});

test("legacy explicitly empty text-to-image references are complete; missing or invalid edit references are not", () => {
    const generated = (metadata: CanvasNodeData["metadata"]): CanvasNodeData => ({ ...source, metadata: { ...source.metadata, ...metadata } });
    for (const node of [generated({ generationType: "generation", references: [] }), generated({ sourceTaskId: "task", references: [] }), generated({ generationType: "edit", references: ["image:original"] })]) {
        expect(hasIncompleteCanvasGenerationReferences(node)).toBe(false);
    }
    for (const node of [generated({ generationType: "generation" }), generated({ sourceTaskId: "task" }), generated({ generationType: "edit", references: [] }), generated({ generationType: "edit", references: [""] })]) {
        expect(hasIncompleteCanvasGenerationReferences(node)).toBe(true);
        expect(canvasNodeGenerationReferences(node, [node], [])).toEqual([]);
    }
    expect(hasIncompleteCanvasGenerationReferences(source)).toBe(false);
    expect(canvasNodeGenerationReferences(generated({ generationType: "generation", references: [] }), [source], [])).toEqual([]);
});

test("legacy comparison snapshots may recover omitted raw-data references but cannot override an explicit source URL", () => {
    const restored: CanvasNodeData = { ...source, metadata: { generationType: "edit", references: [], compareSources: [{ type: "image", content: "data:image/png;base64,b3JpZ2luYWw=", label: "原始内嵌图" }] } };
    expect(hasIncompleteCanvasGenerationReferences(restored)).toBe(false);
    expect(canvasNodeGenerationReferences(restored, [], [])[0]?.dataUrl).toBe("data:image/png;base64,b3JpZ2luYWw=");
    const staleCompare: CanvasNodeData = { ...source, metadata: { generationType: "edit", references: ["https://original.test/a.png"], compareSources: [{ type: "image", storageKey: "image:unrelated", content: "blob:unrelated" }] } };
    const reference = canvasNodeGenerationReferences(staleCompare, [], [])[0]!;
    expect(reference.dataUrl).toBe("https://original.test/a.png");
    expect(reference.storageKey).toBeUndefined();
});

test("a live workflow config marked edit is not a historical image and retains its actual input", () => {
    const config: CanvasNodeData = { ...source, id: "config", type: CanvasNodeType.Config, metadata: { generationMode: "image", composerContent: "白底图" } };
    const graph = prepareImageSequenceStep({ nodes: [source, config], connections: [{ id: "input", fromNodeId: source.id, toNodeId: config.id }] }, config.id, source.id);
    const prepared = graph.nodes[1]!;
    expect(prepared.metadata!.generationType).toBe("edit");
    expect(hasIncompleteCanvasGenerationReferences(prepared)).toBe(false);
    expect(canvasNodeGenerationReferences(prepared, graph.nodes, graph.connections).map(reference => reference.id)).toEqual([source.id]);
    const legacyImage: CanvasNodeData = { ...prepared, type: CanvasNodeType.Image, metadata: { content: "blob:old-output", generationType: "edit" } };
    expect(hasIncompleteCanvasGenerationReferences(legacyImage)).toBe(true);
    expect(canvasNodeGenerationReferences(legacyImage, [source, legacyImage], graph.connections)).toEqual([]);
});

test("live config edit markers preserve manual and connected reference ordering, exclusions and explicit drafts", () => {
    const second = { ...source, id: "second", metadata: { content: "blob:second", storageKey: "image:second" } };
    const config: CanvasNodeData = { ...source, id: "config", type: CanvasNodeType.Config, metadata: { generationType: "edit", sourceTaskId: "restored-task",
        manualImageReferences: [{ id: "manual", referenceKey: "manual", name: "手动参考", type: "image/png", content: "blob:manual", origin: "upload" }],
        imageReferenceOrder: ["node:second", "manual", "node:source"], excludedConnectedImageReferenceKeys: ["node:source"] } };
    const nodes = [source, second, config], connections = [source, second].map(node => ({ id: node.id, fromNodeId: node.id, toNodeId: config.id }));
    expect(hasIncompleteCanvasGenerationReferences(config)).toBe(false);
    expect(canvasNodeGenerationReferences(config, nodes, connections).map(reference => reference.id)).toEqual(["second", "manual"]);
    expect(canvasNodeGenerationReferences({ ...config, metadata: { ...config.metadata, draftImageReferences: [] } }, nodes, connections)).toEqual([]);
});
