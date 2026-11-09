import { describe, expect, test } from "bun:test";
import { createConfigGenerationInputIndex } from "@/components/canvas/canvas-node-generation";
import { createCanvasConfigRenderCache, type CanvasConfigRenderGraph } from "@/lib/canvas/canvas-config-render-cache";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeGroup } from "@/types/canvas";

const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 320, height: 180,
    metadata: { content: `blob:${id}`, storageKey: `image:${id}`, mimeType: "image/png", originalFileName: `${id}.png`, bytes: 100, naturalWidth: 1600, naturalHeight: 900 } });
const config = (id: string): CanvasNodeData => ({ ...image(id), type: CanvasNodeType.Config, metadata: { prompt: "保留主体", generationMode: "image" } });
const group = (id = "group", configId = "config"): CanvasNodeGroup => ({ id, title: id, nodeIds: [configId], collapsed: false,
    imageSequence: { sourceNodeId: "source", status: "idle", steps: [{ configNodeId: configId, status: "idle" }] } });
const graph = (): CanvasConfigRenderGraph => ({ nodes: [config("config"), image("source"), image("target"), image("unrelated")],
    connections: [{ id: "reference", fromNodeId: "source", toNodeId: "config" }, { id: "target", fromNodeId: "config", toNodeId: "target", kind: "config-target" }], groups: [] });
function select(cache: ReturnType<typeof createCanvasConfigRenderCache>, current: CanvasConfigRenderGraph, activeGroupId: string | null = null) {
    const inputs = createConfigGenerationInputIndex(current.nodes, current.connections).get("config");
    const summary = { textCount: inputs.filter(input => input.type === "text").length, imageCount: inputs.filter(input => input.type === "image").length,
        videoCount: inputs.filter(input => input.type === "video").length, audioCount: inputs.filter(input => input.type === "audio").length };
    return cache.select(current.nodes.find(node => node.id === "config")!, current, summary, inputs, new Set(activeGroupId ? [activeGroupId] : []));
}

describe("current React graph config render cache", () => {
    test("keeps a complete initial input/reference/target snapshot without requiring a prior render", () => {
        const snapshot = select(createCanvasConfigRenderCache(), graph());
        expect(snapshot.inputSummary).toEqual({ imageCount: 1, textCount: 0, videoCount: 0, audioCount: 0 });
        expect(snapshot.inputs[0]).toMatchObject({ nodeId: "source", title: "source", image: { storageKey: "image:source", bytes: 100, width: 1600, height: 900 } });
        expect(snapshot.imageReferences[0]).toMatchObject({ id: "source", referenceKey: "node:source", dataUrl: "blob:source", name: "source.png" });
        expect(snapshot.inputImageTaskCount).toBe(1);
        expect(snapshot.linkedTaskCount).toBe(1);
        expect(snapshot.linkedTaskHasImages).toBe(true);
        expect(snapshot.workflow).toBeUndefined();
    });

    test("unrelated node edits, connections, groups and fresh input index objects preserve snapshot identity", () => {
        const cache = createCanvasConfigRenderCache(), original = graph();
        const before = select(cache, original);
        const changed = { ...original, nodes: original.nodes.map(node => node.id === "unrelated" ? { ...node, metadata: { content: `data:image/png;base64,${"x".repeat(100_000)}` } } : node),
            connections: [...original.connections, { id: "elsewhere", fromNodeId: "unrelated", toNodeId: "target" }], groups: [group("other", "elsewhere")] };
        expect(select(cache, changed)).toBe(before);
        expect(select(cache, { ...changed, nodes: [...changed.nodes], connections: [...changed.connections], groups: [...changed.groups] })).toBe(before);
    });

    test("input title, original filename, bytes, dimensions and content update on the very next React snapshot", () => {
        const cache = createCanvasConfigRenderCache(), original = graph();
        const before = select(cache, original);
        const next = { ...original, nodes: original.nodes.map(node => node.id === "source" ? { ...node, title: "已改名原图", metadata: { ...node.metadata, originalFileName: "最新原图.png", bytes: 999, naturalWidth: 3000, content: "asset:new" } } : node) };
        const after = select(cache, next);
        expect(after).not.toBe(before);
        expect(after.inputs[0]).toMatchObject({ title: "已改名原图", image: { name: "最新原图.png", bytes: 999, width: 3000, dataUrl: "asset:new" } });
        expect(after.imageReferences[0]).toMatchObject({ name: "最新原图.png", dataUrl: "asset:new" });
        expect(before.inputs[0]!.title).toBe("source");
    });

    test("config and reference movement alone do not rebuild the parameter panel", () => {
        const cache = createCanvasConfigRenderCache(), original = graph();
        const before = select(cache, original);
        const moved = { ...original, nodes: original.nodes.map(node => node.id === "source" || node.id === "config" ? { ...node, position: { x: 200, y: 300 } } : node) };
        expect(select(cache, moved)).toBe(before);
    });

    test("reference reordering/exclusion and target connection removal update immediately", () => {
        const cache = createCanvasConfigRenderCache(), original = graph();
        const second = image("second");
        const two = { ...original, nodes: [...original.nodes, second], connections: [...original.connections, { id: "second-ref", fromNodeId: "second", toNodeId: "config" }] };
        const before = select(cache, two);
        expect(before.imageReferences.map(reference => reference.id)).toEqual(["source", "second"]);
        const reordered = { ...two, nodes: two.nodes.map(node => node.id === "config" ? { ...node, metadata: { ...node.metadata, imageReferenceOrder: ["node:second", "node:source"] } } : node) };
        expect(select(cache, reordered).imageReferences.map(reference => reference.id)).toEqual(["second", "source"]);
        const removed = { ...reordered, nodes: reordered.nodes.map(node => node.id === "config" ? { ...node, metadata: { ...node.metadata, excludedConnectedImageReferenceKeys: ["node:source"] } } : node),
            connections: reordered.connections.filter(edge => edge.kind !== "config-target") };
        const after = select(cache, removed);
        expect(after.imageReferences.map(reference => reference.id)).toEqual(["second"]);
        expect(after.inputImageTaskCount).toBe(1);
        expect(after.linkedTaskCount).toBe(0);
        expect(after.linkedTaskHasImages).toBe(false);
    });

    test("deleted references cannot persist from an earlier graph and changed edge kinds are honored", () => {
        const cache = createCanvasConfigRenderCache(), original = graph();
        const before = select(cache, original);
        const deleted = { ...original, nodes: original.nodes.filter(node => node.id !== "source") };
        const after = select(cache, deleted);
        expect(after).not.toBe(before);
        expect(after.inputs).toEqual([]);
        expect(after.imageReferences).toEqual([]);
        expect(after.inputImageTaskCount).toBe(0);
        const changedKind = { ...original, connections: original.connections.map(edge => edge.id === "reference" ? { ...edge, kind: "generation-output" as const } : edge) };
        expect(select(cache, changedKind).inputImageTaskCount).toBe(0);
    });

    test("workflow association, active group and step status are current while other running groups are ignored", () => {
        const cache = createCanvasConfigRenderCache(), original = graph();
        const workflow = { ...original, nodes: [...original.nodes, config("next")], connections: [...original.connections, { id: "sequence", fromNodeId: "config", toNodeId: "next", kind: "config-sequence" as const }], groups: [group()] };
        const idle = select(cache, workflow);
        expect(idle.workflow).toEqual({ groupId: "group", status: "idle", stepStatus: "idle" });
        expect(idle.workflowRunning).toBe(false);
        expect(select(cache, workflow, "unrelated-group")).toBe(idle);
        const running = select(cache, workflow, "group");
        expect(running.workflowRunning).toBe(true);
        const completed = { ...workflow, groups: [{ ...group(), imageSequence: { ...group().imageSequence!, status: "success" as const, steps: [{ configNodeId: "config", status: "success" as const }] } }] };
        expect(select(cache, completed).workflow).toMatchObject({ status: "success", stepStatus: "success" });
        expect(select(cache, { ...completed, groups: [] }).workflow?.groupId).toBeUndefined();
        expect(select(cache, { ...completed, connections: completed.connections.filter(edge => edge.kind !== "config-sequence") }).workflow).toBeUndefined();
    });

    test("clear releases prior-canvas derived objects", () => {
        const cache = createCanvasConfigRenderCache(), original = graph();
        const before = select(cache, original);
        cache.clear();
        expect(select(cache, original)).not.toBe(before);
    });

    test("parallel active groups render independently and finishing B preserves A's cached panel", () => {
        const cache = createCanvasConfigRenderCache(), original = graph();
        const workflow = { ...original, nodes: [...original.nodes, config("second")], groups: [group("a"), group("b", "second")] };
        const summary = { textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 };
        const a = workflow.nodes.find(node => node.id === "config")!, b = workflow.nodes.find(node => node.id === "second")!;
        const active = new Set(["a", "b"]);
        const panelA = cache.select(a, workflow, summary, [], active), panelB = cache.select(b, workflow, summary, [], active);
        expect(panelA.workflowRunning).toBe(true); expect(panelB.workflowRunning).toBe(true);
        expect(cache.select(a, workflow, summary, [], new Set(["a"]))).toBe(panelA);
        expect(cache.select(b, workflow, summary, [], new Set(["a"])).workflowRunning).toBe(false);
    });
});
