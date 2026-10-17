import { afterEach, beforeEach, expect, test } from "bun:test";
import { runCanvasGeneration, type CanvasGenerationResult, type SharedGenerationExecution } from "@/pages/canvas/canvas-shared-generation-runtime";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

const savedBusiness = useBusinessConfigStore.getState();
beforeEach(() => useBusinessConfigStore.setState({ models: [], tools: [], status: "ready" }));
afterEach(() => useBusinessConfigStore.setState(savedBusiness));
const node = (id: string, type = CanvasNodeType.Image): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: type === CanvasNodeType.Config ? { generationMode: "image", prompt: "shared prompt", model: "gpt-image-2" } : {} });
function harness() {
    let nodes = [node("config", CanvasNodeType.Config), node("a"), node("b")];
    let connections: CanvasConnection[] = ["a", "b"].map(id => ({ id, fromNodeId: "config", toNodeId: id, kind: "config-target" }));
    const controller = new AbortController();
    const calls: SharedGenerationExecution[] = [];
    const errors: string[] = [];
    let result: CanvasGenerationResult | undefined;
    let afterExecute: (() => void) | undefined;
    let recovered = 0;
    const run = (id = "config") => runCanvasGeneration(id, "image", "ignored", value => { result = value; }, {
        snapshot: { nodes, connections }, getSnapshot: () => ({ nodes, connections }),
        buildConfig: () => ({ ...defaultConfig, model: "gpt-image-2" }), isAiConfigReady: () => true,
        execute: async (id, mode, _prompt, onResult, shared) => { if (shared) calls.push(shared); onResult?.({ mode, outputs: [{ nodeId: id, status: "success" }] }); afterExecute?.(); },
        recover: async () => { recovered++; return [{ nodeId: "existing", status: "success" }]; },
        start: () => controller, finish: () => {}, setRunning: () => {},
        setNodes: value => { nodes = typeof value === "function" ? value(nodes) : value; },
        message: { info: () => {}, error: text => errors.push(text) },
    });
    return { run, calls, errors, controller, get result() { return result; }, get recovered() { return recovered; },
        setNodes: (value: CanvasNodeData[]) => { nodes = value; }, get nodes() { return nodes; },
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
test("changing the bound image profile cannot silently switch execution tools", async () => {
    const h = harness(); h.setNodes(h.nodes.map(item => item.type === CanvasNodeType.Image ? { ...item, metadata: { content: `blob:${item.id}` } } : item));
    useBusinessConfigStore.setState({ models: [{ id: "blend", modelId: "midjourney-blend", name: "Blend", imageParameterProfile: "midjourney-blend", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 }], tools: [{ toolKey: "canvas-edit", modelConfigId: "blend", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }] });
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
