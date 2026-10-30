import { expect, test } from "bun:test";
import { canCancelQueuedTask, cancelOriginalTask } from "../src/lib/generation-task-cancel";
import type { QueuedTask } from "../src/services/api/generation-tasks";

const waiting = (): QueuedTask => ({ id: "original", requestId: "original-request", operationType: "image_generation", status: "waiting", attempts: 0, upstreamTaskId: null, submissionStartedAt: null, resultUrls: [], failureReason: null });

test("cancel eligibility matches only the server's unsubmitted waiting or paused boundary", () => {
    expect(canCancelQueuedTask(waiting())).toBe(true);
    expect(canCancelQueuedTask({ ...waiting(), status: "paused" })).toBe(true);
    for (const status of ["processing", "success", "failed", "cancelled", "queued"]) expect(canCancelQueuedTask({ ...waiting(), status })).toBe(false);
    expect(canCancelQueuedTask({ ...waiting(), attempts: 1 })).toBe(false);
    expect(canCancelQueuedTask({ ...waiting(), operationType: "video_generation", attempts: 1 })).toBe(true);
    expect(canCancelQueuedTask({ ...waiting(), upstreamTaskId: "accepted" })).toBe(false);
    expect(canCancelQueuedTask({ ...waiting(), submissionStartedAt: "2026-10-30" })).toBe(false);
    expect(canCancelQueuedTask({ ...waiting(), upstreamTaskId: undefined })).toBe(false);
    expect(canCancelQueuedTask({ ...waiting(), submissionStartedAt: undefined })).toBe(false);
    expect(canCancelQueuedTask({ ...waiting(), attempts: undefined })).toBe(false);
});

test("a task that started since the button appeared is read again and never cancelled", async () => {
    const posts: string[] = [];
    const task = await cancelOriginalTask("original", { read: async () => ({ ...waiting(), status: "processing" }), cancel: async id => { posts.push(id); }, assertCurrent() {} });
    expect(task.status).toBe("processing"); expect(posts).toEqual([]);
});

test.each(["204", "409", "network"])("%s cancellation receipt is followed by one GET and never a repeated POST", async mode => {
    let reads = 0;
    const posts: string[] = [];
    const task = await cancelOriginalTask("original", {
        read: async () => ++reads === 1 ? waiting() : { ...waiting(), status: mode === "409" ? "processing" : "cancelled" },
        cancel: async id => { posts.push(id); if (mode !== "204") throw new Error(mode); }, assertCurrent() {},
    });
    expect(task.status).toBe(mode === "409" ? "processing" : "cancelled");
    expect(reads).toBe(2); expect(posts).toEqual(["original"]);
});

test("an unqueryable cancellation stays unknown without resending", async () => {
    let reads = 0, posts = 0;
    await expect(cancelOriginalTask("original", {
        read: async () => { if (++reads === 1) return waiting(); throw new Error("offline"); },
        cancel: async () => { posts++; throw new Error("response lost"); }, assertCurrent() {},
    })).rejects.toThrow("取消结果尚未确认");
    expect(posts).toBe(1); expect(reads).toBe(2);
});

test("identity changes between state lookup and mutation prevent cancellation", async () => {
    let checks = 0, posts = 0;
    await expect(cancelOriginalTask("original", { read: async () => waiting(), cancel: async () => { posts++; }, assertCurrent() { if (++checks === 2) throw new Error("owner changed"); } })).rejects.toThrow("owner changed");
    expect(posts).toBe(0);
});
