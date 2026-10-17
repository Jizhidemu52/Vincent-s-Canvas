import { afterEach, beforeEach, expect, test } from "bun:test";
import { runCanvasGeneration, type CanvasGenerationResult, type SharedGenerationExecution } from "@/pages/canvas/canvas-shared-generation-runtime";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import type { PublicModel } from "@/services/api/business-config";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const savedBusiness = useBusinessConfigStore.getState();
const imageModels: PublicModel[] = [
    { id: "gpt", modelId: "gpt-image-2", name: "GPT", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "blend", modelId: "midjourney-blend", name: "Blend", imageParameterProfile: "midjourney-blend", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
];
beforeEach(() => useBusinessConfigStore.setState({ models: imageModels, tools: [], status: "ready" }));
afterEach(() => useBusinessConfigStore.setState(savedBusiness));
const node = (id: string, type = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: type === CanvasNodeType.Config ? { generationMode: "image", prompt: "shared prompt", model: "gpt-image-2" } : {} });
function harness(model = "gpt-image-2") {
    let nodes = [node("config", CanvasNodeType.Config), node("a"), node("b")];
    let connections: CanvasConnection[] = ["a", "b"].map(id => ({ id, fromNodeId: "config", toNodeId: id, kind: "config-target" }));
    const controller = new AbortController();
    const calls: SharedGenerationExecution[] = [];
    const executedIds: string[] = [];
    const errors: string[] = [];
    let result: CanvasGenerationResult | undefined;
    let afterExecute: (() => void) | undefined;
    let recovered = 0;
    const run = (id = "config") => runCanvasGeneration(id, "image", "ignored", value => { result = value; }, {
        snapshot: { nodes, connections }, getSnapshot: () => ({ nodes, connections }),
        buildConfig: () => ({ ...defaultConfig, model }), isAiConfigReady: () => true,
        execute: async (id, mode, _prompt, onResult, shared) => { executedIds.push(id); if (shared) calls.push(shared); onResult?.({ mode, outputs: [{ nodeId: id, status: "success" }] }); afterExecute?.(); },
        recover: async () => { recovered++; return [{ nodeId: "existing", status: "success" }]; },
        start: () => controller, finish: () => {}, setRunning: () => {},
        setNodes: value => { nodes = typeof value === "function" ? value(nodes) : value; },
        message: { info: () => {}, error: text => errors.push(text) },
    });
    return { run, calls, executedIds, errors, controller, get result() { return result; }, get recovered() { return recovered; },
        setNodes: (value: CanvasNodeData[]) => { nodes = value; }, get nodes() { return nodes; },
        setConnections: (value: CanvasConnection[]) => { connections = value; }, get connections() { return connections; },
        disconnectB: () => { connections = connections.filter(edge => edge.toNodeId !== "b"); },
        afterExecute: (callback: () => void) => { afterExecute = callback; },
    };
}

test("shared targets dispatch serially with a frozen single-task config and tool route", async () => {
    const h = harness(); await h.run();
    expect(h.calls.map(call => call.plan.targetNode.id)).toEqual(["a", "b"]);
    expect(h.calls.every(call => call.config.count === "1" && call.toolKey === "canvas-image")).toBe(true);
    expect(h.result?.outputs).toHaveLength(2);
});
test("mixed generation and editing targets reject before any task submission", async () => {
    const h = harness(); h.setNodes(h.nodes.map(item => item.id === "a" ? { ...item, metadata: { content: "blob:a" } } : item));
    await h.run(); expect(h.calls).toHaveLength(0); expect(h.errors[0]).toContain("拆成两套配置");
});
test("an invalid later target prevents submitting earlier valid targets", async () => {
    const h = harness(); h.setNodes(h.nodes.map(item => item.id === "b" ? { ...item, type: CanvasNodeType.Audio, metadata: { content: "blob:audio" } } : item));
    await h.run(); expect(h.calls).toHaveLength(0); expect(h.errors).toHaveLength(1);
});
test("alternating image board bindings reject before task submission", async () => {
    const h = harness(); h.setNodes(h.nodes.map(item => item.type === CanvasNodeType.Image ? { ...item, metadata: { content: `blob:${item.id}` } } : item));
    useBusinessConfigStore.setState({ tools: [
        { toolKey: "canvas-edit", modelConfigId: "blend", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
        { toolKey: "canvas-image", modelConfigId: "gpt", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
    ] });
    await h.run(); expect(h.calls).toHaveLength(0); expect(h.errors[0]).toContain("不一致");
});
test("disconnecting a pending target skips it without executing the stale snapshot", async () => {
    const h = harness(); h.afterExecute(h.disconnectB); await h.run();
    expect(h.calls).toHaveLength(1); expect(h.result?.outputs[1]).toMatchObject({ nodeId: "b", status: "failed", error: "目标或连线已删除" });
});
test("stop aborts later serial tasks and single-target entry does not run siblings", async () => {
    const h = harness(); h.afterExecute(() => h.controller.abort()); await h.run(); expect(h.calls).toHaveLength(1);
    const single = harness(); await single.run("b"); expect(single.calls.map(call => call.plan.targetNode.id)).toEqual(["b"]);
});
test("pending image outputs recover rather than resubmitting the shared group", async () => {
    const h = harness(); h.setNodes([...h.nodes, { ...node("existing"), metadata: { generationOrigin: { configNodeId: "config", sourceNodeId: "a", runId: "old", mode: "image" }, imageTask: {} as NonNullable<CanvasNodeData["metadata"]>["imageTask"] } }]);
    await h.run(); expect(h.recovered).toBe(1); expect(h.calls).toHaveLength(0); expect(h.result?.outputs[0]?.nodeId).toBe("existing");
});

function incomingImages(model?: string) {
    const h = harness(model);
    h.setNodes(h.nodes.map(item => item.type === CanvasNodeType.Image ? { ...item, metadata: { content: `blob:${item.id}`, mimeType: "image/png" } } : item));
    h.setConnections(["a", "b"].map(id => ({ id, fromNodeId: id, toNodeId: "config" })));
    return h;
}

test("two incoming images default to two independent one-image tasks", async () => {
    const h = incomingImages();
    await h.run();
    expect(h.executedIds).toEqual(["a", "b"]);
    expect(h.calls.map(call => call.plan.context.referenceImages.map(image => image.id))).toEqual([["a"], ["b"]]);
    expect(h.calls.map(call => call.toolKey)).toEqual(["canvas-edit", "canvas-edit"]);
    expect(h.calls.every(call => call.config.count === "1")).toBe(true);
    expect(h.result?.outputs).toHaveLength(2);
    expect(h.connections.every(edge => edge.toNodeId === "config")).toBe(true);
});

test.each([false, true])("saved Blend with GPT bindings uses the same effective per-image route when old model removed=%s", async removed => {
    const h = incomingImages("midjourney-blend");
    useBusinessConfigStore.setState({ models: removed ? imageModels.filter(model => model.id !== "blend") : imageModels, tools: [
        { toolKey: "canvas-edit", modelConfigId: "gpt", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
        { toolKey: "canvas-image", modelConfigId: "gpt", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 },
    ] });
    await h.run();
    expect(h.executedIds).toEqual(["a", "b"]);
    expect(h.calls.map(call => call.toolKey)).toEqual(["canvas-edit", "canvas-edit"]);
    expect(h.calls.map(call => call.config.model)).toEqual(["gpt-image-2", "gpt-image-2"]);
    expect(h.errors).toHaveLength(0);
});

test("per-image inputs retain common text and manual reference but never include siblings", async () => {
    const h = incomingImages();
    h.setNodes([...h.nodes.map(item => item.id === "config" ? { ...item, metadata: { ...item.metadata, manualImageReferences: [{ id: "common", referenceKey: "manual:common", name: "common", type: "image/png", content: "blob:common", origin: "upload" as const }] } } : item), { ...node("text", CanvasNodeType.Text), metadata: { content: "Keep the buttons unchanged" } }]);
    h.setConnections([...h.connections, { id: "text", fromNodeId: "text", toNodeId: "config" }]);
    await h.run();
    expect(h.calls.map(call => call.plan.context.referenceImages.map(image => image.id))).toEqual([["a", "common"], ["b", "common"]]);
    expect(h.calls.every(call => call.plan.prompt.includes("Keep the buttons unchanged"))).toBe(true);
});

test("explicit combined mode and Blend both preserve one multi-reference generation", async () => {
    const combined = incomingImages();
    combined.setNodes(combined.nodes.map(item => item.id === "config" ? { ...item, metadata: { ...item.metadata, configImageInputMode: "combined" } } : item));
    await combined.run();
    expect(combined.executedIds).toEqual(["config"]);
    expect(combined.calls).toHaveLength(0);
    const blend = incomingImages("midjourney-blend");
    await blend.run();
    expect(blend.executedIds).toEqual(["config"]);
});

test("explicit output tasks take priority over splitting shared input images", async () => {
    const h = incomingImages();
    h.setNodes([...h.nodes, node("target")]);
    h.setConnections([...h.connections, { id: "target", fromNodeId: "config", toNodeId: "target", kind: "config-target" }]);
    await h.run();
    expect(h.executedIds).toEqual(["target"]);
    expect(h.calls[0].plan.context.referenceImages.map(image => image.id)).toEqual(["a", "b"]);
});

test("removed incoming image is skipped, and pending per-image tasks recover without new submissions", async () => {
    const h = incomingImages();
    h.afterExecute(() => h.setConnections(h.connections.filter(edge => edge.fromNodeId !== "b")));
    await h.run();
    expect(h.executedIds).toEqual(["a"]);
    expect(h.result?.outputs[1]?.error).toBe("目标或连线已删除");
    const recovery = incomingImages();
    recovery.setNodes([...recovery.nodes, { ...node("existing"), metadata: { generationOrigin: { configNodeId: "config", sourceNodeId: "a", runId: "old", mode: "image" }, imageTask: {} as NonNullable<CanvasNodeData["metadata"]>["imageTask"] } }]);
    await recovery.run();
    expect(recovery.recovered).toBe(1);
    expect(recovery.executedIds).toHaveLength(0);
});

test.each(["combined", "excluded", "text-mode", "right-target"] as const)("an unresolved per-image result is recovered before a changed %s dispatch", async change => {
    const h = incomingImages();
    h.setNodes([...h.nodes.map(item => item.id !== "config" ? item : { ...item, metadata: {
        ...item.metadata,
        ...(change === "combined" ? { configImageInputMode: "combined" as const } : {}),
        ...(change === "excluded" ? { excludedConnectedImageReferenceKeys: ["node:a"] } : {}),
        ...(change === "text-mode" ? { generationMode: "text" as const } : {}),
    } }), { ...node("existing"), metadata: {
        generationOrigin: { configNodeId: "config", sourceNodeId: "a", runId: "old", mode: "image" },
        imageTask: {} as NonNullable<CanvasNodeData["metadata"]>["imageTask"],
    } }]);
    if (change === "right-target") {
        h.setNodes([...h.nodes, node("target")]);
        h.setConnections([...h.connections, { id: "target", fromNodeId: "config", toNodeId: "target", kind: "config-target" }]);
    }
    await h.run();
    expect(h.executedIds).toHaveLength(0);
    expect(h.recovered).toBe(1);
});

test("switching to combined inputs cannot bypass an uncertain previous text or media submission", async () => {
    const h = incomingImages();
    h.setNodes([...h.nodes.map(item => item.id === "config" ? { ...item, metadata: { ...item.metadata, configImageInputMode: "combined" as const } } : item), {
        ...node("uncertain", CanvasNodeType.Text), metadata: {
            generationOrigin: { configNodeId: "config", sourceNodeId: "a", runId: "old", mode: "text" },
            generationSubmissionUncertain: true,
            status: "error",
        },
    }]);
    await h.run();
    expect(h.executedIds).toHaveLength(0);
    expect(h.errors[0]).toContain("未完成");
});

test("completed previous outputs do not block a new combined generation", async () => {
    const h = incomingImages();
    h.setNodes([...h.nodes.map(item => item.id === "config" ? { ...item, metadata: { ...item.metadata, configImageInputMode: "combined" as const } } : item), {
        ...node("finished", CanvasNodeType.Text), metadata: {
            generationOrigin: { configNodeId: "config", sourceNodeId: "a", runId: "old", mode: "text" },
            status: "success",
            content: "Completed output",
        },
    }]);
    await h.run();
    expect(h.executedIds).toEqual(["config"]);
    expect(h.recovered).toBe(0);
    expect(h.errors).toHaveLength(0);
});

test.each(["per-image", "combined"] as const)("an unresolved legacy combined output recovers before a new %s dispatch", async inputMode => {
    const h = incomingImages();
    h.setNodes([...h.nodes.map(item => item.id === "config" ? { ...item, metadata: { ...item.metadata, configImageInputMode: inputMode } } : item), {
        ...node("legacy-result"), metadata: { imageTask: {} as NonNullable<CanvasNodeData["metadata"]>["imageTask"] },
    }]);
    h.setConnections([...h.connections, { id: "legacy-output", fromNodeId: "config", toNodeId: "legacy-result", kind: "generation-output" }]);
    await h.run();
    expect(h.executedIds).toHaveLength(0);
    expect(h.recovered).toBe(1);
});

test("an explicit config target is not mistaken for an earlier combined output", async () => {
    const h = incomingImages();
    h.setNodes([...h.nodes, { ...node("target"), metadata: { content: "blob:target", imageTask: {} as NonNullable<CanvasNodeData["metadata"]>["imageTask"] } }]);
    h.setConnections([...h.connections, { id: "target", fromNodeId: "config", toNodeId: "target", kind: "config-target" }]);
    await h.run();
    expect(h.executedIds).toEqual(["target"]);
    expect(h.recovered).toBe(0);
});

test("a legacy combined output does not intercept an independent single-target entry", async () => {
    const h = harness();
    h.setNodes([...h.nodes, { ...node("legacy-result"), metadata: { imageTask: {} as NonNullable<CanvasNodeData["metadata"]>["imageTask"] } }]);
    h.setConnections([...h.connections, { id: "legacy-output", fromNodeId: "config", toNodeId: "legacy-result", kind: "generation-output" }]);
    await h.run("b");
    expect(h.executedIds).toEqual(["b"]);
    expect(h.recovered).toBe(0);
});

test("pending outputs from another configuration do not block this group", async () => {
    const h = incomingImages();
    h.setNodes([...h.nodes, { ...node("unrelated"), metadata: {
        generationOrigin: { configNodeId: "other-config", sourceNodeId: "a", runId: "old", mode: "image" },
        imageTask: {} as NonNullable<CanvasNodeData["metadata"]>["imageTask"],
    } }]);
    await h.run();
    expect(h.executedIds).toEqual(["a", "b"]);
    expect(h.recovered).toBe(0);
    expect(h.errors).toHaveLength(0);
});

test("single-target entry recovers only its own previous output and leaves siblings independent", async () => {
    const h = harness();
    h.setNodes([...h.nodes, { ...node("existing"), metadata: {
        generationOrigin: { configNodeId: "config", sourceNodeId: "a", runId: "old", mode: "image" },
        imageTask: {} as NonNullable<CanvasNodeData["metadata"]>["imageTask"],
    } }]);
    await h.run("b");
    expect(h.executedIds).toEqual(["b"]);
    expect(h.recovered).toBe(0);
    await h.run("a");
    expect(h.executedIds).toEqual(["b"]);
    expect(h.recovered).toBe(1);
});

test("excluded inputs and duplicate edges do not create or leak extra image tasks", async () => {
    const h = incomingImages();
    h.setNodes([...h.nodes.map(item => item.id === "config" ? { ...item, metadata: { ...item.metadata, excludedConnectedImageReferenceKeys: ["node:b"] } } : item), {
        ...node("c"), metadata: { content: "blob:c", mimeType: "image/png" },
    }]);
    h.setConnections([...h.connections, { id: "duplicate-a", fromNodeId: "a", toNodeId: "config" }, { id: "c", fromNodeId: "c", toNodeId: "config" }]);
    await h.run();
    expect(h.executedIds).toEqual(["a", "c"]);
    expect(h.calls.map(call => call.plan.context.referenceImages.map(image => image.id))).toEqual([["a"], ["c"]]);
});

test("mode and prompt edits during dispatch apply only to the next run", async () => {
    const h = incomingImages();
    h.afterExecute(() => h.setNodes(h.nodes.map(item => item.id === "config" ? { ...item, metadata: {
        ...item.metadata, generationMode: "text" as const, configImageInputMode: "combined" as const, prompt: "Changed after dispatch",
    } } : item)));
    await h.run();
    expect(h.executedIds).toEqual(["a", "b"]);
    expect(h.calls.map(call => call.plan.mode)).toEqual(["image", "image"]);
    expect(h.calls.every(call => call.plan.prompt.includes("shared prompt") && !call.plan.prompt.includes("Changed after dispatch"))).toBe(true);
    expect(h.calls.map(call => call.plan.context.referenceImages.map(image => image.id))).toEqual([["a"], ["b"]]);
});
