import { expect, test } from "bun:test";
import { appendCanvasGenerationResultStack, canvasGenerationStackCover, reconcileCanvasGenerationStackNodes } from "@/lib/canvas/canvas-generation-stack";
import { createCanvasGenerationRecord } from "@/lib/canvas/canvas-generation-record";
import { createCanvasTaskFeedbackTracker } from "@/lib/canvas/canvas-task-feedback";
import { serializeCanvasProject, parseCanvasProject } from "@/lib/canvas/canvas-project-codec";
import { defaultConfig } from "@/stores/use-config-store";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const source: CanvasNodeData = { id: "source", type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { storageKey: "image:source" } };
const result = (id: string): CanvasNodeData => ({ ...source, id, position: { x: 300 + Number(id.slice(-1)) * 300, y: 0 }, metadata: {
    generationStackSourceId: "source", storageKey: `image:${id}`, content: `blob:${id}`, sourceTaskId: `task-${id}`, status: "success",
    generationRecord: createCanvasGenerationRecord({ id: `record-${id}`, sourceNodeId: "source", prompt: "同参数图片", references: [{ id: source.id, name: "原图", dataUrl: "blob:source", storageKey: "image:source", type: "image/png" }], nodes: [source], config: defaultConfig, generationType: "edit" }),
} });
const build = () => appendCanvasGenerationResultStack([source, result("r1"), result("r2")], "r2", () => "stack");

test("a second matching result adds a pure cover while retaining both exact originals and input", () => {
    const first = result("r1"), second = result("r2"), snapshot = JSON.stringify([source, first, second]);
    const grouped = appendCanvasGenerationResultStack([source, first, second], second.id, () => "stack");
    expect(JSON.stringify([source, first, second])).toBe(snapshot);
    expect(grouped.nodes[0]).toBe(source); expect(grouped.nodes).toHaveLength(4);
    const root = grouped.nodes.find(node => node.id === "stack")!;
    expect(root.metadata).toMatchObject({ generationResultStack: true, isBatchRoot: true, imageBatchExpanded: false, batchChildIds: ["r1", "r2"], primaryImageId: "r1", count: 1 });
    expect(root.metadata?.imageTask).toBeUndefined(); expect(root.metadata?.generationOrigin).toBeUndefined();
    for (const original of [first, second]) {
        const child = grouped.nodes.find(node => node.id === original.id)!;
        expect(child.metadata?.generationRecord).toBe(original.metadata?.generationRecord);
        expect(child.metadata?.storageKey).toBe(original.metadata?.storageKey);
        expect(child.metadata?.batchRootId).toBe(root.id);
        expect(child.position).not.toEqual(root.position);
    }
    expect(grouped.addedConnections.map(edge => [edge.fromNodeId, edge.toNodeId])).toEqual([["source", "stack"], ["stack", "r1"], ["stack", "r2"]]);
});

test("different prompts, models, reference bytes/order and source identities never merge", () => {
    const first = result("r1");
    for (const mutate of [
        (node: CanvasNodeData) => { node.metadata!.generationStackSourceId = "different-input"; },
        (node: CanvasNodeData) => { node.metadata!.generationRecord!.prompt = "different prompt"; },
        (node: CanvasNodeData) => { node.metadata!.generationRecord!.parameters.model = "different model"; },
        (node: CanvasNodeData) => { node.metadata!.generationRecord!.parameters.imageOptions = '{"negative_prompt":"watermark"}'; },
        (node: CanvasNodeData) => { node.metadata!.generationRecord!.references[0].storageKey = "image:different"; },
        (node: CanvasNodeData) => { node.metadata!.generationRecord!.references.push({ ...node.metadata!.generationRecord!.references[0], storageKey: "image:extra", order: 1 }); },
    ]) { const second = result("r2"); mutate(second); const nodes = [source, first, second]; expect(appendCanvasGenerationResultStack(nodes, second.id, () => "stack").nodes).toBe(nodes); }
});

test("shared/workflow, failed/running, locked and manually grouped results remain independent", () => {
    for (const mutate of [
        (node: CanvasNodeData) => { node.metadata!.generationRecord!.configNodeId = "shared-config"; },
        (node: CanvasNodeData) => { node.metadata!.generationRecord!.promptInput = { scene: "workflow-step", fields: {}, userText: "", mode: "edit" }; },
        (node: CanvasNodeData) => { node.metadata!.status = "loading"; },
        (node: CanvasNodeData) => { node.metadata!.status = "error"; },
        (node: CanvasNodeData) => { node.metadata!.locked = true; },
    ]) { const second = result("r2"); mutate(second); const nodes = [source, result("r1"), second]; expect(appendCanvasGenerationResultStack(nodes, second.id, () => "stack").nodes).toBe(nodes); }
    const nodes = [source, result("r1"), result("r2")];
    expect(appendCanvasGenerationResultStack(nodes, "r2", () => "stack", new Set(["r1"])).nodes).toBe(nodes);
});

test("later results append to one stack without changing the selected cover or original records", () => {
    const first = build(), third = result("r3");
    const next = appendCanvasGenerationResultStack([...first.nodes, third], third.id, () => "must-not-create");
    expect(next.rootId).toBe("stack");
    expect(next.nodes.find(node => node.id === "stack")?.metadata).toMatchObject({ batchChildIds: ["r1", "r2", "r3"], primaryImageId: "r1", storageKey: "image:r1" });
    expect(next.nodes.filter(node => node.metadata?.generationResultStack)).toHaveLength(1);
    expect(appendCanvasGenerationResultStack(next.nodes, third.id, () => "duplicate").nodes).toBe(next.nodes);
    expect(appendCanvasGenerationResultStack([...next.nodes, result("r4")], "r4", () => "other", new Set(["stack"])).rootId).toBeUndefined();
});

test("switching the cover mirrors the selected record but cannot write any real child or task binding", () => {
    const graph = build(), root = graph.nodes.find(node => node.id === "stack")!, child = graph.nodes.find(node => node.id === "r2")!;
    const before = JSON.stringify(graph.nodes), switched = canvasGenerationStackCover(root, child);
    expect(switched.metadata).toMatchObject({ primaryImageId: child.id, storageKey: child.metadata?.storageKey, sourceTaskId: child.metadata?.sourceTaskId, generationRecord: child.metadata?.generationRecord });
    expect(switched.metadata?.generationRecord?.id).toBe("record-r2"); expect(switched.metadata?.imageTask).toBeUndefined();
    expect(JSON.stringify(graph.nodes)).toBe(before);
});

test("deleting the primary chooses an existing real result and the final one dissolves safely", () => {
    const three = appendCanvasGenerationResultStack([...build().nodes, result("r3")], "r3", () => "unused").nodes;
    const next = reconcileCanvasGenerationStackNodes(three.filter(node => node.id !== "r1"));
    expect(next.find(node => node.id === "stack")?.metadata).toMatchObject({ primaryImageId: "r2", batchChildIds: ["r2", "r3"], storageKey: "image:r2", generationRecord: { id: "record-r2" } });
    const one = reconcileCanvasGenerationStackNodes(next.filter(node => node.id !== "r2"));
    expect(one.map(node => node.id)).toEqual(["source", "r3"]);
    expect(one[1].metadata?.batchRootId).toBeUndefined(); expect(one[1].metadata?.generationRecord?.id).toBe("record-r3");
    expect(one[1].metadata?.storageKey).toBe("image:r3");
});

test("project serialization keeps every record and cover choice without an additional generated task", () => {
    const graph = build();
    const document = { id: "project", title: "test", nodes: graph.nodes, connections: graph.addedConnections, groups: [], chatSessions: [], activeChatId: null, backgroundMode: "dots", showImageInfo: false } as unknown as CanvasProject;
    expect(parseCanvasProject(serializeCanvasProject(document)).nodes).toEqual(graph.nodes);
    const tracker = createCanvasTaskFeedbackTracker();
    tracker.update([], []);
    tracker.update([source, ...graph.nodes.filter(node => node.metadata?.batchRootId).map(node => ({ ...node, metadata: { ...node.metadata, status: "loading" as const } }))], []);
    expect(tracker.update(graph.nodes, graph.addedConnections).progress).toMatchObject({ total: 2, completed: 2, successful: 2 });
});
