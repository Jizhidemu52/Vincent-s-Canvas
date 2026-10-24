import { expect, test } from "bun:test";
import { defaultConfig } from "../src/stores/use-config-store";
import { findPendingImageTask, pendingImagesForWorkspace, snapshotImageRequest, type PendingImage } from "../src/pages/image/image-pending";

const pending: PendingImage = { id: "record", requestId: "paid-request", ownerId: "alice", tool: "image-edit", createdAt: 1, snapshot: { text: "original prompt", config: { ...defaultConfig, model: "original-model" }, references: [] } };

test("only the current employee and tool can restore in-flight records", () => {
    const records = [pending, { ...pending, ownerId: "bob" }, { ...pending, tool: "image-generation" }];
    expect(pendingImagesForWorkspace(records, "alice", "image-edit")).toEqual([pending]);
});

test("durable snapshots retain original image parameters but never browser provider credentials", () => {
    const source = { ...pending.snapshot, promptInput: { scene: "free-optimize" as const, userText: "keep buttons", fields: {}, mode: "edit" as const }, config: { ...pending.snapshot.config, apiKey: "must-not-persist", systemPrompt: "private-methodology-must-not-persist", imageOptions: '{"seed":42}' } };
    const copy = snapshotImageRequest(source);
    source.config.imageOptions = "changed";
    expect(copy.config.imageOptions).toBe('{"seed":42}');
    expect(copy.config.systemPrompt).toBe("");
    expect(copy.promptInput).toEqual(source.promptInput);
    expect(JSON.stringify(copy)).not.toContain("private-methodology-must-not-persist");
    expect(copy.config.apiKey).toBe("");
    expect(JSON.stringify(copy)).not.toContain("must-not-persist");
});

test("lost POST acknowledgement is recovered by its original request id, never resubmitted", async () => {
    const calls: string[] = [];
    const result = await findPendingImageTask(pending, { byId: async () => { throw new Error("must not guess task id"); }, byRequest: async id => { calls.push(id); return { id: "accepted-task" }; } });
    expect(calls).toEqual(["paid-request:0"]);
    expect(result).toEqual({ id: "accepted-task" });
    expect(pending.snapshot.text).toBe("original prompt");
    expect(pending.snapshot.config.model).toBe("original-model");
});

test("acknowledged tasks are queried by task id; missing lookup is not a new generation", async () => {
    const record = { ...pending, taskId: "known-task" };
    const calls: string[] = [];
    await expect(findPendingImageTask(record, { byId: async id => { calls.push(id); return null; }, byRequest: async () => { throw new Error("must not fall back to submit"); } })).rejects.toThrow("不会重新提交或扣费");
    expect(calls).toEqual(["known-task"]);
});
