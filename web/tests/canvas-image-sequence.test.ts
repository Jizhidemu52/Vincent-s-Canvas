import { describe, expect, test } from "bun:test";
import { createImageSequence, prepareImageSequenceStep, runImageSequence } from "@/lib/canvas/canvas-image-sequence";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { cloneCanvasNodeGraph, copyCanvasNodeGraph } from "@/lib/canvas/canvas-node-copy";
import { addCanvasImageSequence, runCanvasImageSequence, type ImageSequenceOptions } from "@/pages/canvas/canvas-image-sequence-runtime";
import { imageWorkflowConnectionError, resolveImageWorkflow } from "@/lib/canvas/canvas-image-workflow";
import { createCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";

const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: `https://example.test/${id}.png`, status: "success" } });
function fixture() {
    let id = 0;
    const source = image("source");
    const created = createImageSequence(source, [["白底", "白底"], ["紫色", "紫色"], ["模特", "模特"]], { x: 200, y: 0 }, "model", () => String(++id));
    let graph = { nodes: [source, ...created.nodes], connections: created.connections };
    let group = created.group;
    const calls: string[] = [];
    const controller = new AbortController();
    const runtime = {
        signal: controller.signal,
        getGraph: () => graph,
        getGroup: () => group,
        update: (next: typeof group) => { group = next; },
        prepare: (configId: string, inputId: string) => { graph = prepareImageSequenceStep(graph, configId, inputId); },
        generate: async (configId: string) => {
            calls.push(configId);
            const output = image(`out-${calls.length}`);
            graph = { nodes: [...graph.nodes, output], connections: [...graph.connections, { id: output.id, fromNodeId: configId, toNodeId: output.id, kind: "generation-output" as const }] };
            return { mode: "image" as const, outputs: [{ nodeId: output.id, status: "success" as const, url: output.metadata!.content }] };
        },
    };
    return { runtime, calls, controller, graph: () => graph, group: () => group };
}

describe("serial image sequence", () => {
    test("the starter creates visible config-to-config dependencies before running", () => {
        const f = fixture();
        expect(f.graph().connections.map(edge => [edge.fromNodeId, edge.toNodeId])).toEqual([["source", "1"], ["1", "2"], ["2", "3"]]);
        expect(f.graph().nodes[2]!.position.x).toBeGreaterThan(f.graph().nodes[1]!.position.x);
    });
    test("awaits each result and passes only that image to the next step", async () => {
        const f = fixture();
        const first = f.runtime.generate;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        f.runtime.generate = async id => { if (!f.calls.length) await gate; return first(id); };
        const run = runImageSequence(f.runtime);
        await Promise.resolve();
        expect(f.calls).toEqual([]);
        release(); await run;
        expect(f.calls.length).toBe(3);
        const sequence = f.group().imageSequence!;
        expect(sequence.status).toBe("success");
        expect(sequence.steps.map(step => step.outputNodeId)).toEqual(["out-1", "out-2", "out-3"]);
        expect(sequence.steps.map(step => f.graph().connections.find(edge => edge.toNodeId === step.configNodeId && edge.kind !== "config-sequence")?.fromNodeId)).toEqual(["source", "out-1", "out-2"]);
        expect(f.graph().connections.filter(edge => edge.kind === "config-sequence").map(edge => [edge.fromNodeId, edge.toNodeId])).toEqual([["1", "2"], ["2", "3"]]);
        expect(f.graph().nodes.find(node => node.id === sequence.steps[1]!.configNodeId)?.metadata?.composerContent).toBe("@[node:out-1]\n紫色");
    });
    test("failure never starts later steps and continuing skips completed work", async () => {
        const f = fixture(); const generate = f.runtime.generate;
        let failed = false;
        f.runtime.generate = async id => {
            if (f.calls.length === 1 && !failed) { failed = true; throw new Error("provider failure"); }
            return generate(id);
        };
        await runImageSequence(f.runtime);
        expect(f.group().imageSequence!.status).toBe("failed");
        expect(f.calls.length).toBe(1);
        await runImageSequence(f.runtime);
        expect(f.calls.length).toBe(3);
        expect(f.group().imageSequence!.status).toBe("success");
    });
    test("stop even after a late success never submits the next step", async () => {
        const f = fixture(); const generate = f.runtime.generate;
        f.runtime.generate = async id => { const result = await generate(id); f.controller.abort(); return result; };
        await runImageSequence(f.runtime);
        expect(f.calls.length).toBe(1);
        expect(f.group().imageSequence!.status).toBe("stopped");
        expect(f.group().imageSequence!.steps[0]!.outputNodeId).toBe("out-1");
    });
    test("stop before dispatch can continue without an unknown-paid-request blocker", async () => {
        const f = fixture();
        f.runtime.generate = async () => { f.controller.abort(); return { mode: "image", outputs: [] }; };
        await runImageSequence(f.runtime);
        expect(f.group().imageSequence!.status).toBe("stopped");
        expect(f.group().imageSequence!.steps[0]!.status).toBe("idle");
    });
    test("missing source or a deleted completed result blocks submission", async () => {
        const f = fixture();
        f.runtime.getGraph = () => ({ nodes: [], connections: [] });
        await runImageSequence(f.runtime);
        expect(f.calls).toEqual([]);
        expect(f.group().imageSequence!.status).toBe("failed");
    });
    test("stale running state without a recoverable output never silently resubmits", async () => {
        const f = fixture(); const group = f.group();
        group.imageSequence!.steps[0]!.status = "running";
        await runImageSequence(f.runtime);
        expect(f.calls).toEqual([]);
        expect(f.group().imageSequence!.status).toBe("failed");
    });
    test("binding an upstream output preserves user-authored wires and replaces only the previous runtime input", () => {
        const f = fixture(); const configId = f.group().imageSequence!.steps[0]!.configNodeId;
        const next = prepareImageSequenceStep({ ...f.graph(), connections: [
            { id: "other", fromNodeId: "other", toNodeId: configId },
            { id: "target", fromNodeId: configId, toNodeId: "other", kind: "config-sequence" },
            { id: "old", fromNodeId: configId, toNodeId: "old", kind: "generation-output" },
            { id: "runtime", fromNodeId: "previous-output", toNodeId: configId, kind: "sequence-input" },
        ] }, configId, "source");
        expect(next.connections.map(edge => [edge.fromNodeId, edge.toNodeId])).toEqual([["other", configId], [configId, "other"], [configId, "old"], ["source", configId]]);
    });
    test("refresh recovery adopts a finished attempt without generating that step again", async () => {
        const f = fixture(); const first = f.group().imageSequence!.steps[0]!;
        await f.runtime.generate(first.configNodeId);
        first.status = "running"; first.previousOutputIds = [];
        await runImageSequence(f.runtime);
        expect(f.calls.length).toBe(3);
        expect(f.group().imageSequence!.steps.map(step => step.outputNodeId)).toEqual(["out-1", "out-2", "out-3"]);
    });
    test("an empty or multi-image result stops instead of picking an arbitrary next reference", async () => {
        for (const outputs of [[], [{ nodeId: "x", status: "success" as const }, { nodeId: "y", status: "success" as const }]]) {
            const f = fixture(); let count = 0;
            f.runtime.generate = async () => { count++; return { mode: "image", outputs }; };
            await runImageSequence(f.runtime);
            expect(count).toBe(1);
            expect(f.group().imageSequence!.status).toBe("failed");
        }
    });
    test("copy remaps config/source IDs and starts a new draft, not the original paid run", async () => {
        const f = fixture(); await runImageSequence(f.runtime);
        const selected = new Set(f.graph().nodes.map(node => node.id));
        const clip = copyCanvasNodeGraph(f.graph().nodes, f.graph().connections, [f.group()], selected);
        f.group().imageSequence!.steps[0]!.status = "failed";
        expect(clip.groups![0]!.imageSequence!.steps[0]!.status).toBe("success");
        const cloned = cloneCanvasNodeGraph(clip, { x: 100, y: 100 });
        const sequence = cloned.groups![0]!.imageSequence!;
        expect(sequence.status).toBe("idle");
        expect(sequence.sourceNodeId).toBe(cloned.nodes[0]!.id);
        expect(sequence.steps.every(step => step.status === "idle" && !step.outputNodeId && cloned.nodes.some(node => node.id === step.configNodeId))).toBe(true);
    });
    test("canvas adapter reads async results from the real graph store before React refs catch up", async () => {
        const store = createCanvasGraphStore();
        store.getState().setField("nodes", [image("source")]);
        const calls: string[] = [];
        const options: ImageSequenceOptions = {
            projectId: "project", nodes: { current: [] }, connections: { current: [] }, groups: { current: [] }, locks: { current: new Set() },
            setNodes: value => store.getState().setField("nodes", value),
            setConnections: value => store.getState().setField("connections", value),
            setGroups: () => {}, stopGeneration: () => {},
            generate: async id => {
                calls.push(id); const output = image(`adapter-${calls.length}`);
                // Only the live Zustand store changes; refs remain stale until the production adapter reads.
                store.getState().setField("nodes", nodes => [...nodes, output]);
                store.getState().setField("connections", edges => [...edges, { id: output.id, fromNodeId: id, toNodeId: output.id, kind: "generation-output" }]);
                return { mode: "image", outputs: [{ nodeId: output.id, status: "success", url: output.metadata!.content }] };
            },
        };
        const { group } = addCanvasImageSequence(options, "source", [["一", "白底"], ["二", "紫色"]], "model");
        const started: string[] = [];
        await runCanvasImageSequence(() => options, { groupId: "", nodeId: group.imageSequence!.steps.at(-1)!.configNodeId, controller: new AbortController() }, "lock", () => true, id => started.push(id));
        expect(started).toEqual([group.id]);
        expect(calls.length).toBe(2);
        expect(options.groups.current[0]!.imageSequence!.status).toBe("success");
        expect(store.getState().connections.find(edge => edge.toNodeId === calls[1] && edge.kind === "sequence-input")?.fromNodeId).toBe("adapter-1");
    });
    test("manual connections define the plan regardless of node array order and selected step", () => {
        const f = fixture();
        const graph = f.graph();
        const plan = resolveImageWorkflow({ ...graph, nodes: [...graph.nodes].reverse() }, "3");
        expect(plan).toEqual({ sourceNodeId: "source", steps: [{ configNodeId: "1" }, { configNodeId: "2", inputConfigId: "1" }, { configNodeId: "3", inputConfigId: "2" }] });
        const reversed = { ...graph, connections: [graph.connections[0]!, { id: "a", fromNodeId: "1", toNodeId: "3", kind: "config-sequence" as const }, { id: "b", fromNodeId: "3", toNodeId: "2", kind: "config-sequence" as const }] };
        expect(resolveImageWorkflow(reversed, "2").steps.map(step => step.configNodeId)).toEqual(["1", "3", "2"]);
    });
    test("branches receive their actual parent's output, not the last completed sibling", async () => {
        const f = fixture();
        f.graph().connections[2]!.fromNodeId = "1";
        f.group().imageSequence!.steps[2]!.inputConfigId = "1";
        await runImageSequence(f.runtime);
        expect(f.group().imageSequence!.status).toBe("success");
        expect(f.graph().nodes.find(node => node.id === "3")?.metadata?.composerContent).toBe("@[node:out-1]\n模特");
    });
    test("disconnecting a dependency after step one stops before another request", async () => {
        const f = fixture(); const generate = f.runtime.generate;
        f.runtime.generate = async id => { const result = await generate(id); f.graph().connections.splice(f.graph().connections.findIndex(edge => edge.fromNodeId === "1" && edge.toNodeId === "2"), 1); return result; };
        await runImageSequence(f.runtime);
        expect(f.calls).toEqual(["1"]);
        expect(f.group().imageSequence!.status).toBe("failed");
    });
    test("cycles, duplicate parents and unavailable first input cannot submit any request", () => {
        const f = fixture();
        expect(imageWorkflowConnectionError({ fromNodeId: "3", toNodeId: "1", kind: "config-sequence" }, f.graph().connections)).toBeTruthy();
        expect(imageWorkflowConnectionError({ fromNodeId: "source", toNodeId: "2", kind: "config-sequence" }, f.graph().connections)).toBeTruthy();
        expect(imageWorkflowConnectionError({ fromNodeId: "1", toNodeId: "4", kind: "config-sequence" }, f.graph().connections)).toBeUndefined();
        expect(() => resolveImageWorkflow({ ...f.graph(), connections: f.graph().connections.filter(edge => edge.fromNodeId !== "source") }, "1")).toThrow("原图");
        expect(() => resolveImageWorkflow({ ...f.graph(), connections: [...f.graph().connections, { id: "cycle", fromNodeId: "3", toNodeId: "1", kind: "config-sequence" }] }, "1")).toThrow("循环");
    });
});
