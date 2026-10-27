import { expect, test } from "bun:test";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";
import { createCanvasTaskFeedbackTracker, canvasTaskProgressTitle } from "@/lib/canvas/canvas-task-feedback";

const node = (id: string, status: "loading" | "success" | "error" | "idle", extra: Partial<CanvasNodeData["metadata"]> = {}): CanvasNodeData => ({
    id, type: CanvasNodeType.Image, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { status, ...extra },
});

test("only observed tasks count; a mixed batch settles without calling failed items successful", () => {
    const tracker = createCanvasTaskFeedbackTracker();
    expect(tracker.update([node("old", "success")], []).completedIds).toEqual([]);
    const start = tracker.update([node("old", "success"), node("a", "loading"), node("b", "loading")], []);
    expect(canvasTaskProgressTitle("无线画布", start.progress)).toBe("(0/2) 无线画布");
    const partial = tracker.update([node("old", "success"), node("a", "success"), node("b", "loading")], []);
    expect(partial.completedIds).toEqual(["a"]);
    expect(canvasTaskProgressTitle("无线画布", partial.progress)).toBe("(1/2) 无线画布");
    expect(tracker.update([node("a", "success"), node("b", "loading")], []).completedIds).toEqual([]);
    const end = tracker.update([node("a", "success"), node("b", "error")], []);
    expect(end.progress).toEqual({ total: 2, completed: 2, active: 0, successful: 1, failed: 1, stopped: 0 });
    expect(end.batchFinished).toBe(true);
    expect(canvasTaskProgressTitle("无线画布", end.progress)).toBe("无线画布");
});

test("config containers and batch covers are not extra tasks, stopping/removal is not success", () => {
    const tracker = createCanvasTaskFeedbackTracker();
    const config = { ...node("config", "loading"), type: CanvasNodeType.Config };
    tracker.update([config, node("cover", "loading", { isBatchRoot: true }), node("a", "loading"), node("b", "loading")], []);
    const end = tracker.update([config, node("cover", "success", { isBatchRoot: true }), node("a", "idle")], []);
    expect(end.progress.total).toBe(2);
    expect(end.progress.stopped).toBe(2);
    expect(end.completedIds).toEqual([]);
});

test("an input text node is not counted alongside its newly created output", () => {
    const tracker = createCanvasTaskFeedbackTracker();
    const input = { ...node("input", "loading"), type: CanvasNodeType.Text };
    tracker.update([input], []);
    const edges: CanvasConnection[] = [{ id: "edge", fromNodeId: "input", toNodeId: "out", kind: "generation-output" }];
    const next = tracker.update([{ ...input, metadata: { status: "success" } }, node("out", "loading")], edges);
    expect(next.progress.total).toBe(1);
    expect(next.completedIds).toEqual([]);
});

test("a new batch and retries get a new denominator, initial recovered jobs do not fabricate timing", () => {
    const tracker = createCanvasTaskFeedbackTracker();
    tracker.update([node("a", "loading", { imageTask: { requestId: "r", ownerId: "o", projectId: "p", resultIndex: 0 } })], [], 10);
    expect(tracker.update([node("a", "success")], [], 100).timings).toEqual([]);
    tracker.update([node("a", "loading")], [], 200);
    tracker.update([node("a", "loading", { imageTask: { requestId: "r2", ownerId: "o", projectId: "p", resultIndex: 0 } })], [], 220);
    const done = tracker.update([node("a", "success")], [], 520);
    expect(done.timings).toEqual([300]);
    expect(done.progress.total).toBe(1);
});
