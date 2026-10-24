import { expect, test } from "bun:test";
import { pendingOnlineAgentTask, recoverOnlineAgentTask, type PendingOnlineAgentTask } from "@/lib/canvas/canvas-online-task-recovery";
import { executeOnlineAgentOperations } from "@/lib/canvas/online-agent-execution";
import { QueuedTaskFailedError, QueuedTaskPausedError, type QueuedTask } from "@/services/api/generation-tasks";

const pending: PendingOnlineAgentTask = { ownerId: "owner", projectId: "project", requestId: "request:0", mode: "image", prompt: "red vase", model: "image" };
const task: QueuedTask = { id: "original", requestId: "request:0", status: "success", resultUrls: ["/api/assets/result/content"], failureReason: null };
type IO = NonNullable<Parameters<typeof recoverOnlineAgentTask>[3]>;
function harness(current: QueuedTask | null = task) {
    const calls: string[] = [];
    const image = { url: "/api/assets/result/content", storageKey: "cached", width: 100, height: 50, bytes: 1, mimeType: "image/png" };
    const io = {
        getQueuedTask: async () => { calls.push("task"); return current; },
        getQueuedTaskByRequestId: async () => { calls.push("request"); return current; },
        recoverQueuedTask: async () => { calls.push("recover"); return { ...task, status: "waiting" }; },
        waitForTasks: async () => { calls.push("wait"); return [task]; },
        uploadImage: async () => { calls.push("store-image"); return image; },
        storeGeneratedVideo: async () => { calls.push("store-video"); return { ...image, mimeType: "video/mp4" }; },
        storeGeneratedAudio: async () => { calls.push("store-audio"); return { ...image, mimeType: "audio/mpeg" }; },
        fetch: async () => { calls.push("audio"); return new Response("audio"); },
    } as IO;
    return { calls, io, image };
}

test.each(["image", "video", "audio"] as const)("%s recovery queries the saved request and returns stable output identities without generating", async mode => {
    const run = harness();
    const result = await recoverOnlineAgentTask({ ...pending, mode, nodeId: "source" }, { x: 40, y: 80 }, new AbortController().signal, run.io);
    expect(run.calls[0]).toBe("request");
    expect(run.calls).not.toContain("recover");
    expect(result.ops).toContainEqual(expect.objectContaining({ type: "add_node", id: "agent-original-0" }));
    expect(result.ops).toContainEqual({ type: "connect_nodes", fromNodeId: "source", toNodeId: "agent-original-0" });
});

test("known task IDs are read directly and recover only a paused task with an upstream identity", async () => {
    const run = harness({ ...task, status: "paused", upstreamTaskId: "upstream" });
    await recoverOnlineAgentTask({ ...pending, taskIds: [task.id] }, { x: 0, y: 0 }, new AbortController().signal, run.io);
    expect(run.calls).toEqual(["task", "recover", "wait", "store-image"]);
});

test("missing, uncertain and failed tasks remain explicit without replacement submission", async () => {
    const signal = new AbortController().signal;
    const absent = harness(null);
    await expect(recoverOnlineAgentTask(pending, { x: 0, y: 0 }, signal, absent.io)).rejects.toThrow("原任务尚未查到");
    expect(absent.calls).toEqual(["request"]);
    const paused = harness({ ...task, status: "paused", upstreamTaskId: null });
    await expect(recoverOnlineAgentTask(pending, { x: 0, y: 0 }, signal, paused.io)).rejects.toBeInstanceOf(QueuedTaskPausedError);
    expect(paused.calls).toEqual(["request"]);
    const failed = harness({ ...task, status: "failed" });
    await expect(recoverOnlineAgentTask(pending, { x: 0, y: 0 }, signal, failed.io)).rejects.toBeInstanceOf(QueuedTaskFailedError);
    expect(failed.calls).toEqual(["request"]);
});

test("stopping during media storage rejects late results before any canvas operations can be returned", async () => {
    const controller = new AbortController(), run = harness();
    run.io.uploadImage = async () => { controller.abort(); return run.image; };
    await expect(recoverOnlineAgentTask(pending, { x: 0, y: 0 }, controller.signal, run.io)).rejects.toMatchObject({ name: "AbortError" });
    const inactive = new AbortController();
    inactive.abort();
    const untouched = harness();
    await expect(recoverOnlineAgentTask(pending, { x: 0, y: 0 }, inactive.signal, untouched.io)).rejects.toMatchObject({ name: "AbortError" });
    expect(untouched.calls).toEqual([]);
});

test("a stopped generation prevents the next mutation or generation in the same operation batch", async () => {
    const controller = new AbortController(), applied: unknown[] = [], generated: string[] = [];
    await expect(executeOnlineAgentOperations([
        { type: "update_node", id: "before", patch: { title: "allowed" } },
        { type: "run_generation", nodeId: "first" },
        { type: "update_node", id: "after", patch: { title: "blocked" } },
        { type: "run_generation", nodeId: "second" },
    ], ops => applied.push(ops), async op => { generated.push(op.nodeId); controller.abort(); }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(generated).toEqual(["first"]);
    expect(applied).toEqual([[{ type: "update_node", id: "before", patch: { title: "allowed" } }]]);
});

test("recovery controls are shown only for a persisted request identity", () => {
    expect(pendingOnlineAgentTask(pending)).toBe(pending);
    for (const value of [null, {}, { requestId: "" }, { ...pending, mode: "other" }]) expect(pendingOnlineAgentTask(value)).toBeNull();
});
