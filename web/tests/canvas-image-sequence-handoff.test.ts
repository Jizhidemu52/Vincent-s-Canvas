import { describe, expect, test } from "bun:test";
import { createCanvasGraphStore } from "@/stores/canvas/canvas-graph-store";
import { addCanvasImageSequence, prepareCanvasImageWorkflow, runCanvasImageSequence, type ImageSequenceOptions, type ImageSequenceSession } from "@/pages/canvas/canvas-image-sequence-runtime";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

const image = (id: string): CanvasNodeData => ({ id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100,
    metadata: { content: `blob:${id}`, storageKey: `image:${id}`, status: "success" } });

function workflow() {
    const store = createCanvasGraphStore();
    store.getState().setField("nodes", [image("source")]);
    const calls: string[] = [];
    const options: ImageSequenceOptions = {
        projectId: "handoff-project", nodes: { current: [] }, connections: { current: [] }, groups: { current: [] }, locks: { current: new Set() },
        setNodes: value => store.getState().setField("nodes", value), setConnections: value => store.getState().setField("connections", value), setGroups() {}, stopGeneration() {},
        async generate(id) {
            calls.push(id);
            const output = image(`output-${calls.length}`);
            append(id, output);
            return { mode: "image", outputs: [{ nodeId: output.id, status: "success", url: output.metadata!.content }] };
        },
    };
    function append(configId: string, node: CanvasNodeData) {
        store.getState().setField("nodes", previous => [...previous, node]);
        store.getState().setField("connections", previous => [...previous, { id: `result:${node.id}`, fromNodeId: configId, toNodeId: node.id, kind: "generation-output" }]);
    }
    const created = addCanvasImageSequence(options, "source", [["First", "Make the background white"], ["Second", "Change only the trim to blue"], ["Third", "Show the back view"]]);
    const ids = created.nodes.map(node => node.id);
    const session = (): ImageSequenceSession => ({ groupId: created.group.id, nodeId: ids[0], controller: new AbortController() });
    const run = (value = session()) => runCanvasImageSequence(() => options, value, "handoff-lock", () => true);
    const current = () => options.groups.current.find(group => group.id === created.group.id)!.imageSequence!;
    return { store, options, ids, calls, append, run, session, current };
}

describe("workflow handoff and interrupted attempts", () => {
    test("cancelling an image placeholder before submission leaves the step retryable", async () => {
        const f = workflow(), session = f.session(), generate = f.options.generate;
        f.options.generate = async id => {
            f.append(id, { ...image("not-submitted"), metadata: { status: "loading" } });
            // Reference upload / optional preview has not reached the persisted pre-POST binding.
            session.controller.abort();
            return { mode: "image", outputs: [{ nodeId: "not-submitted", status: "failed", error: "生成已取消" }] };
        };
        await f.run(session);
        expect(f.current().status).toBe("stopped");
        expect(f.current().steps[0]!.status).toBe("idle");
        f.options.generate = generate;
        await f.run();
        expect(f.calls).toEqual(f.ids);
        expect(f.current().status).toBe("success");
    });

    test("an unsettled failed image attempt remains recoverable, not a new-task failure", async () => {
        const f = workflow();
        f.options.generate = async id => {
            f.calls.push(id);
            f.append(id, { ...image("unsettled"), metadata: { status: "error", imageTask: { ownerId: "owner", projectId: f.options.projectId, requestId: "original:0", resultIndex: 0 }, errorDetails: "Network observation interrupted" } });
            return { mode: "image", outputs: [{ nodeId: "unsettled", status: "failed", error: "Network observation interrupted" }] };
        };
        await expect(f.run()).rejects.toThrow("Network observation interrupted");
        expect(f.current().steps[0]!.status).toBe("running");
        expect(f.calls).toEqual([f.ids[0]!]);
    });

    test("editing a legacy failed step with a pending original request cannot relabel its result", async () => {
        const f = workflow();
        const group = prepareCanvasImageWorkflow(f.options, f.ids[0]!);
        group.imageSequence!.steps[0]!.status = "failed";
        f.append(f.ids[0]!, { ...image("old-pending"), metadata: { status: "error", imageTask: { ownerId: "owner", projectId: f.options.projectId, requestId: "old:0", resultIndex: 0 } } });
        f.store.getState().setField("nodes", previous => previous.map(node => node.id === f.ids[0] ? { ...node, metadata: { ...node.metadata, composerContent: "Completely different edit" } } : node));
        const before = structuredClone(f.options.groups.current);
        expect(() => prepareCanvasImageWorkflow(f.options, f.ids[0]!)).toThrow("待核查任务");
        expect(f.options.groups.current).toEqual(before);
        expect(f.calls).toEqual([]);
    });
});
