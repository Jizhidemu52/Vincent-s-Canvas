import { describe, expect, test } from "bun:test";
import { CanvasNodeType, type CanvasNodeData } from "../src/types/canvas";
import { arrangeCanvasNodes, canvasArrangeOptions } from "../src/lib/canvas/canvas-node-arrange";
import { canvasDesignTemplates, createCanvasDesignTemplate, isEmptyCanvasDesignTemplateReference } from "../src/lib/canvas/canvas-design-templates";
import { replaceCanvasNodeImage } from "../src/pages/canvas/canvas-project-utils";
import { canvasCompareImages, chooseCanvasComparePair, compareContainRect, drawCanvasCompare } from "../src/lib/canvas/canvas-image-compare";
import { createCanvasRestoredGenerationNode } from "../src/lib/canvas/canvas-generation-draft";
import { buildNodeGenerationContext, buildNodeGenerationInputs, createConfigGenerationInputIndex } from "../src/components/canvas/canvas-node-generation";
import { resolveCanvasImageReferences } from "../src/lib/canvas/canvas-image-references";
import { cloneCanvasNodeGraph } from "../src/lib/canvas/canvas-node-copy";

const node = (id: string, x = 0, y = 0, width = 100): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x, y }, width, height: 80, metadata: { content: `data:image/png;base64,${id}`, storageKey: `image:${id}`, imageName: "coat", imageVersion: 1 } });

describe("服装模板真实生成输入", () => {
    test.each(canvasDesignTemplates)("$title preserves source and resolves all real config references", template => {
        const original = node("original");
        const snapshot = JSON.stringify(original);
        const result = createCanvasDesignTemplate(template.id, original, { x: 600, y: 0 }, "configured-model");
        expect(result.nodes).toHaveLength(3);
        expect(result.connections).toHaveLength(3);
        expect(JSON.stringify(original)).toBe(snapshot);
        for (const config of result.nodes) {
            expect(config.type).toBe(CanvasNodeType.Config);
            expect(config.metadata?.status).toBe("idle");
            expect(config.metadata?.model).toBe("configured-model");
            expect(config.title).not.toBe("生成配置");
            const context = buildNodeGenerationContext(config.id, [original, ...result.nodes], result.connections, config.metadata!.composerContent!);
            expect(context.referenceImages).toHaveLength(1);
            expect(context.referenceImages[0].id).toBe(original.id);
            expect(context.prompt).toContain(config.metadata!.prompt!);
            expect(context.prompt).not.toContain("@[node:");
            expect(resolveCanvasImageReferences(config, [original, ...result.nodes], result.connections)[0].storageKey).toBe("image:original");
        }
        expect(result.group.nodeIds).not.toContain(original.id);
    });
    test("empty canvas creates upload reference and repeated insertion remaps all IDs", () => {
        const a = createCanvasDesignTemplate("development", undefined, { x: 0, y: 0 });
        const b = createCanvasDesignTemplate("development", undefined, { x: 0, y: 0 });
        expect(a.nodes).toHaveLength(4);
        const ids = new Set([...a.nodes, ...b.nodes, ...a.connections, ...b.connections, a.group, b.group].map(item => item.id));
        expect(ids.size).toBe(16);
        expect(a.connections.every(connection => connection.fromNodeId === a.nodes[0].id && a.nodes.some(node => node.id === connection.toNodeId))).toBe(true);
        expect(a.nodes[0].metadata?.content).toBeUndefined();
        expect(a.nodes.every(node => node.metadata?.status === "idle")).toBe(true);
    });
    test.each(canvasDesignTemplates)("$title accepts an explicit original without changing graph identity or attachments", template => {
        const result = createCanvasDesignTemplate(template.id, undefined, { x: 0, y: 0 });
        const source = result.nodes[0];
        source.metadata!.manualImageReferences = [{ id: "attached", referenceKey: "upload:attached", name: "reference.png", type: "image/png", origin: "upload", content: "blob:old-preview", storageKey: "image:existing-original" }];
        const before = structuredClone(result);
        expect(isEmptyCanvasDesignTemplateReference(source, result.nodes, result.connections)).toBe(true);
        expect(() => buildNodeGenerationContext(result.nodes[1].id, result.nodes, result.connections, result.nodes[1].metadata!.composerContent!)).toThrow("先设置参考款原图");
        const replacement = replaceCanvasNodeImage(source, { url: "blob:resolved-original", storageKey: "image:existing-original", width: 256, height: 512, bytes: 1024, mimeType: "image/png", originalFileName: "reference.png" }, "reference.png");
        const nodes = result.nodes.map(node => node.id === source.id ? replacement : node);
        expect(replacement.id).toBe(source.id);
        expect(replacement.position).toBe(source.position);
        expect(replacement.height / replacement.width).toBe(2);
        expect(replacement.metadata?.manualImageReferences).toEqual(before.nodes[0].metadata!.manualImageReferences);
        expect(replacement.metadata?.storageKey).toBe("image:existing-original");
        expect(result).toEqual(before);
        expect(isEmptyCanvasDesignTemplateReference(replacement, nodes, result.connections)).toBe(false);
        for (const branch of nodes.slice(1)) {
            const context = buildNodeGenerationContext(branch.id, nodes, result.connections, branch.metadata!.composerContent!);
            expect(context.referenceImages).toHaveLength(1);
            expect(context.referenceImages[0].id).toBe(source.id);
            expect(context.referenceImages[0].storageKey).toBe("image:existing-original");
        }
    });
    test("ordinary empty image attachments do not silently become template originals", () => {
        const result = createCanvasDesignTemplate("development", undefined, { x: 0, y: 0 });
        const source = result.nodes[0];
        expect(isEmptyCanvasDesignTemplateReference(source, [source], [])).toBe(false);
        expect(isEmptyCanvasDesignTemplateReference({ ...source, type: CanvasNodeType.Text }, result.nodes, result.connections)).toBe(false);
        expect(isEmptyCanvasDesignTemplateReference({ ...source, metadata: { storageKey: "image:original" } }, result.nodes, result.connections)).toBe(false);
        const generic = result.nodes.map(node => ({ ...node, metadata: { ...node.metadata, promptInput: undefined } }));
        expect(isEmptyCanvasDesignTemplateReference(source, generic, result.connections)).toBe(false);
    });
    test("empty template source remains a display-only pending input; uploading refreshes a cached index", () => {
        const graph = createCanvasDesignTemplate("development", undefined, { x: 0, y: 0 });
        const source = graph.nodes[0]!, config = graph.nodes[1]!;
        const map = new Map(graph.nodes.map(node => [node.id, node]));
        const index = createConfigGenerationInputIndex(graph.nodes, graph.connections, map);
        const pending = index.get(config.id);
        expect(pending).toEqual([{ nodeId: source.id, type: "image", title: source.title, pendingUpload: true }]);
        expect(buildNodeGenerationInputs(config.id, graph.nodes, graph.connections)).toEqual(pending);
        expect(index.get(config.id)).toBe(pending);
        expect(resolveCanvasImageReferences(config, graph.nodes, graph.connections)).toEqual([]);
        const uploaded = { ...source, metadata: { content: "blob:original", storageKey: "image:original" } };
        map.set(source.id, uploaded);
        expect(index.get(config.id)[0]).toMatchObject({ nodeId: source.id, image: { dataUrl: "blob:original", storageKey: "image:original" } });
        expect(index.get(config.id)[0]?.pendingUpload).toBeUndefined();
    });
    test("deleted, disconnected and ordinary blank sources remain invalid rather than pending", () => {
        const graph = createCanvasDesignTemplate("development", undefined, { x: 0, y: 0 });
        const source = graph.nodes[0]!, config = graph.nodes[1]!, prompt = config.metadata!.composerContent!;
        for (const [nodes, edges] of [[graph.nodes.slice(1), graph.connections], [graph.nodes, []], [graph.nodes.map(item => item.id === config.id ? { ...item, metadata: { ...item.metadata, promptInput: undefined } } : item), graph.connections]] as const) {
            expect(buildNodeGenerationInputs(config.id, nodes, edges)).toEqual([]);
            expect(() => buildNodeGenerationContext(config.id, nodes, edges, prompt)).toThrow("已失效引用");
        }
        const copied = cloneCanvasNodeGraph(graph, { x: 40, y: 40 });
        const copiedSource = copied.nodes[0]!, copiedConfig = copied.nodes[1]!;
        expect(copiedSource.id).not.toBe(source.id);
        expect(copiedConfig.metadata!.composerContent).toContain(`@[node:${copiedSource.id}]`);
        expect(copiedConfig.metadata!.composerContent).not.toContain(`@[node:${source.id}]`);
        expect(buildNodeGenerationInputs(copiedConfig.id, copied.nodes, copied.connections)[0]).toMatchObject({ nodeId: copiedSource.id, pendingUpload: true });
        expect(() => buildNodeGenerationContext(copiedConfig.id, copied.nodes, copied.connections, copiedConfig.metadata!.composerContent!)).toThrow("先设置参考款原图");
    });
});

describe("排版仅移动位置，组与批次不可拆分", () => {
    test.each(canvasArrangeOptions)("$key preserves every group-relative offset and source metadata", ({ key }) => {
        const nodes = [node("a", 100, 80), node("b", 240, 100), node("c", 0, 0), node("outside", 900, 900)];
        const snapshot = JSON.stringify(nodes);
        const result = arrangeCanvasNodes(nodes, [{ id: "g", title: "款式", nodeIds: ["a", "b"], collapsed: true }], new Set(["a", "c"]), key);
        expect(result[1].position.x - result[0].position.x).toBe(140);
        expect(result[1].position.y - result[0].position.y).toBe(20);
        expect(result[3]).toBe(nodes[3]);
        result.forEach((item, index) => { expect(item.metadata).toBe(nodes[index].metadata); expect(item.width).toBe(nodes[index].width); });
        expect(JSON.stringify(nodes)).toBe(snapshot);
    });
    test("grid packs different widths without overlap; selection of batch child moves entire batch", () => {
        const nodes = [node("root", 0, 0, 400), node("child", 440, 0), node("other", 10, 10, 200)];
        nodes[0].metadata = { ...nodes[0].metadata, isBatchRoot: true, batchChildIds: ["child"] };
        nodes[1].metadata = { ...nodes[1].metadata, batchRootId: "root" };
        const result = arrangeCanvasNodes(nodes, [], new Set(["child", "other"]), "grid");
        expect(result[1].position.x - result[0].position.x).toBe(440);
        expect(result[2].position.x).toBeGreaterThanOrEqual(result[1].position.x + 100 + 80);
        expect(arrangeCanvasNodes(nodes, [], new Set(["child"]), "grid")).toBe(nodes);
    });
    test("equal spacing expands crowded selections rather than overlap", () => {
        const result = arrangeCanvasNodes([node("a", 10), node("b", 20, 50, 200), node("c", 30, 90)], [], new Set(), "distribute-x");
        expect(result[1].position.x - result[0].position.x - result[0].width).toBe(80);
        expect(result[2].position.x - result[1].position.x - result[1].width).toBe(80);
        expect(result[1].position.y).toBe(50);
    });
});

describe("本地改款对比", () => {
    test("two explicit selected images take priority; same names and nearby versions cannot imply lineage", () => {
        const a = node("a"), b = node("b"), c = { ...node("c"), metadata: { ...node("c").metadata, imageVersion: 2 } };
        expect(chooseCanvasComparePair([a, b, c], ["b", "a"])).toEqual(["b", "a"]);
        expect(chooseCanvasComparePair([a, b, c], ["a"])).toEqual(["", "a"]);
        expect(chooseCanvasComparePair([a, b], ["a"])).toEqual(["", "a"]);
        expect(canvasCompareImages([{ ...a, metadata: undefined }])).toEqual([]);
    });
    test("contain rect never stretches aspect ratio", () => {
        expect(compareContainRect(400, 200, 1000, 1000)).toEqual({ x: 0, y: 250, width: 1000, height: 500 });
        expect(compareContainRect(200, 400, 800, 1000)).toEqual({ x: 150, y: 0, width: 500, height: 1000 });
    });
    test("all three modes draw original images locally to documented export sizes", () => {
        for (const mode of ["slider", "overlay", "side"] as const) {
            let draws = 0;
            const ctx = { fillRect() {}, drawImage() { draws++; }, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {} };
            const canvas = { width: 0, height: 0, getContext: () => ctx };
            drawCanvasCompare(canvas as unknown as HTMLCanvasElement, { naturalWidth: 400, naturalHeight: 800 } as HTMLImageElement, { naturalWidth: 800, naturalHeight: 400 } as HTMLImageElement, mode, 50, "#fff", "#111");
            expect(draws).toBe(2); expect(canvas.width).toBe(mode === "side" ? 1600 : 1000); expect(canvas.height).toBe(1048);
        }
    });
});

test("restored generation is an idle new config preserving original reference order and system prompt", () => {
    const draft = { prompt: "保留款式", config: { model: "original-model", imageModel: "original-model", size: "1024x1024", quality: "high", count: "2", systemPrompt: "original-system" }, references: [{ id: "r1", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,original-bytes" }], operationType: "inpaint", parameters: {}, tool: undefined };
    const restored = createCanvasRestoredGenerationNode(draft, { x: 100, y: 200 });
    expect(restored.metadata?.status).toBe("idle");
    expect(restored.metadata?.manualImageReferences?.[0].content).toBe(draft.references[0].dataUrl);
    expect(restored.metadata?.systemPrompt).toBe("original-system");
    expect(restored.metadata?.count).toBe(2);
    expect(restored.metadata?.composerContent).toBe(draft.prompt);
    expect(() => createCanvasRestoredGenerationNode({ ...draft, maskReferenceIndex: 0 }, { x: 0, y: 0 })).toThrow("蒙版");
    expect(() => createCanvasRestoredGenerationNode({ ...draft, tool: "image-upscale" }, { x: 0, y: 0 })).toThrow("专用工具");
});
