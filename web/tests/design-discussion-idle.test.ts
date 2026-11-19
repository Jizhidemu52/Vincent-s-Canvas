import { expect, test } from "bun:test";
import { createTaskController } from "../src/services/api/design-discussion.mjs";

test.each([false, true])("idle controllers do not authenticate, scan storage or publish unchanged tasks (conversations=%s)", async imageConversationsEnabled => {
    const counts = { auth: 0, iterate: 0, change: 0 };
    const controller = createTaskController({
        ownerId: "owner", projectId: "project", imageConversationsEnabled,
        api: { session: async () => { counts.auth++; return { user: { id: "owner", status: "active" } }; } },
        storage: { getItem: async () => null, iterate: async () => { counts.iterate++; }, setItem: async () => {} },
        onChange: () => { counts.change++; },
    });
    await controller.load();
    counts.auth = counts.iterate = counts.change = 0;
    for (let index = 0; index < 20; index++) await controller.refreshAll();
    expect(counts).toEqual({ auth: 0, iterate: 0, change: 0 });
    controller.dispose?.();
});

test("active legacy polling reads the original task without scans and annotations refresh explicitly", async () => {
    const counts = { auth: 0, iterate: 0, query: 0 };
    const task = { id: "receipt", requestId: "original", taskId: "server", ownerId: "owner", projectId: "project", status: "processing", observing: true, resultUrls: [], startedAt: 1, feedbackHistory: [] };
    const records = new Map<string, Record<string, any>>([[task.id, task]]);
    let current: Record<string, any>[] = [];
    const controller = createTaskController({ ownerId: "owner", projectId: "project", imageConversationsEnabled: false,
        api: {
            session: async () => { counts.auth++; return { user: { id: "owner", status: "active" } }; },
            query: async () => { counts.query++; return { ...task, id: "server", userId: "owner" }; },
        },
        storage: { async iterate(visitor: (value: unknown) => void) { counts.iterate++; for (const value of records.values()) visitor(value); }, async setItem(key: string, value: Record<string, any>) { records.set(key, value); } },
        onChange: (value: Record<string, any>[]) => { current = value; },
    });
    await controller.load(); counts.iterate = 0;
    await controller.refreshAll();
    expect(counts).toEqual({ auth: 1, iterate: 0, query: 1 });
    await controller.action(task.id, "stop");
    await controller.refreshAll();
    expect(counts).toEqual({ auth: 1, iterate: 0, query: 1 });
    records.set("annotation:external", { id: "annotation:external", kind: "task-annotation", ownerId: "owner", taskId: task.id, requestId: task.requestId, type: "feedback", recordedAt: "2026-11-19T00:00:00Z", value: { status: "approved", note: "另一处完成核对" } });
    await controller.refreshAnnotations();
    expect(counts).toEqual({ auth: 2, iterate: 1, query: 1 });
    expect(current[0].feedback.note).toBe("另一处完成核对");
});
