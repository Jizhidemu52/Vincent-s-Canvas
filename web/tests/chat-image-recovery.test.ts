import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { recoverChatImageTask, type PendingChatImageTask } from "../src/services/api/chat-image-recovery";
import type { QueuedTask } from "../src/services/api/generation-tasks";

const originalFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string }> = [];
beforeEach(() => {
    calls = [];
    respond(() => { throw new Error("Unexpected task query"); });
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    expect(calls.every((call) => call.method === "GET")).toBe(true);
});

const pending: PendingChatImageTask = {
    requestId: "chat-request",
    prompt: "保留中文字，调整花瓣",
    modelId: "gpt-image-2.5",
    action: "edit",
    taskId: "original-task",
};
const originalTask: QueuedTask = {
    id: "original-task",
    requestId: "chat-request:0",
    operationType: "inpaint",
    status: "success",
    resultUrls: ["/api/assets/original-result/content"],
    failureReason: null,
};

function respond(read: (url: string, init?: RequestInit) => unknown | Promise<unknown>) {
    globalThis.fetch = (async (input, init) => {
        const url = String(input);
        calls.push({ url, method: init?.method || "GET" });
        const result = await read(url, init);
        return result instanceof Response ? result : Response.json(result);
    }) as typeof fetch;
}

describe("read-only chat image recovery", () => {
    test("returns the original completed image with one direct GET, including older tasks", async () => {
        const saved: QueuedTask[] = [];
        respond((url) => {
            expect(url).toBe("/api/tasks/original-task");
            return { task: originalTask };
        });

        expect(await recoverChatImageTask(pending, { onTask: (task) => { saved.push(task); } })).toEqual({
            kind: "success",
            task: originalTask,
            resultUrls: ["/api/assets/original-result/content"],
        });
        expect(calls).toEqual([{ url: "/api/tasks/original-task", method: "GET" }]);
        expect(saved).toEqual([originalTask]);
    });

    test.each(["failed", "cancelled"])("reports a %s original task without trying to recover or resubmit it", async (status) => {
        const task = { ...originalTask, status, resultUrls: [], failureReason: "原任务未完成" };
        respond(() => ({ task }));

        expect(await recoverChatImageTask(pending)).toEqual({ kind: "failed", task, content: "原任务未完成" });
        expect(calls).toHaveLength(1);
    });

    test.each(["paused", "unexpected-state", ""])("stops on %s with the task ID and a warning against duplicate generation", async (status) => {
        respond(() => ({ task: { ...originalTask, status, resultUrls: [] } }));

        const result = await recoverChatImageTask(pending);
        expect(result.kind).toBe("needs_attention");
        if (result.kind !== "needs_attention") throw new Error("Expected needs_attention");
        expect(result.task?.id).toBe("original-task");
        expect(result.content).toContain("original-task");
        expect(result.content).toContain("待核查");
        expect(result.content).toContain("请勿重复生成");
        expect(calls).toHaveLength(1);
    });

    test.each([{ resultUrls: [] }, { resultUrls: ["", " "] }, { resultUrls: undefined }, { resultUrls: null }])("a success status without usable output (%j) remains pending investigation", async ({ resultUrls }) => {
        respond(() => ({ task: { ...originalTask, resultUrls } }));
        expect(await recoverChatImageTask(pending)).toMatchObject({ kind: "needs_attention", task: { id: "original-task" } });
        expect(calls).toHaveLength(1);
    });

    test("a missing original ID does not fall back to the list or recreate the task", async () => {
        respond(() => new Response(null, { status: 404 }));
        const result = await recoverChatImageTask(pending);
        expect(result.kind).toBe("needs_attention");
        if (result.kind !== "needs_attention") throw new Error("Expected needs_attention");
        expect(result.content).toContain("original-task");
        expect(result.content).toContain("请勿重复生成");
        expect(calls).toEqual([{ url: "/api/tasks/original-task", method: "GET" }]);
    });

    test.each([
        { id: "wrong-task", requestId: "chat-request:0" },
        { id: "original-task", requestId: "another-request:0" },
        { id: "original-task", requestId: "chat-request:1" },
    ])("rejects a mismatched task identity %j before notifying the UI", async (identity) => {
        const saved: QueuedTask[] = [];
        respond(() => ({ task: { ...originalTask, ...identity } }));
        expect(await recoverChatImageTask(pending, { onTask: (task) => { saved.push(task); } })).toMatchObject({ kind: "needs_attention" });
        expect(saved).toEqual([]);
        expect(calls).toHaveLength(1);
    });

    test("a missing task ID selects only the exact root requestId plus :0 from the list", async () => {
        respond((url) => {
            expect(url).toBe("/api/tasks");
            return { tasks: [
                { ...originalTask, id: "wrong-suffix", requestId: "chat-request:1" },
                { ...originalTask, id: "wrong-prefix", requestId: "prefix-chat-request:0" },
                originalTask,
            ] };
        });
        expect(await recoverChatImageTask({ ...pending, taskId: undefined })).toMatchObject({ kind: "success", task: { id: "original-task" } });
        expect(calls).toEqual([{ url: "/api/tasks", method: "GET" }]);
    });

    test("a list without an exact requestId match stops without submitting anything", async () => {
        respond(() => ({ tasks: [{ ...originalTask, requestId: "chat-request:1" }] }));
        const result = await recoverChatImageTask({ ...pending, taskId: undefined });
        expect(result.kind).toBe("needs_attention");
        if (result.kind !== "needs_attention") throw new Error("Expected needs_attention");
        expect(result.content).toContain("chat-request");
        expect(result.content).toContain("请勿重复生成");
        expect(calls).toHaveLength(1);
    });

    test("after list lookup, waiting and processing poll only the original ID and notify once per status", async () => {
        const saved: string[] = [];
        const statuses = ["waiting", "processing", "processing", "success"];
        respond((url) => {
            const status = statuses.shift();
            if (!status) throw new Error("Unexpected extra poll");
            const task = { ...originalTask, status };
            return url === "/api/tasks" ? { tasks: [task] } : { task };
        });
        const result = await recoverChatImageTask({ ...pending, taskId: undefined }, {
            onTask: async (task) => { saved.push(`${task.id}:${task.status}`); },
        });
        expect(result.kind).toBe("success");
        expect(saved).toEqual(["original-task:waiting", "original-task:processing", "original-task:success"]);
        expect(calls).toEqual([
            { url: "/api/tasks", method: "GET" },
            { url: "/api/tasks/original-task", method: "GET" },
            { url: "/api/tasks/original-task", method: "GET" },
            { url: "/api/tasks/original-task", method: "GET" },
        ]);
    });

    test("a task disappearing while processing stops polling instead of locating a replacement", async () => {
        let reads = 0;
        respond(() => ++reads === 1 ? { task: { ...originalTask, status: "processing" } } : new Response(null, { status: 404 }));
        expect(await recoverChatImageTask(pending)).toMatchObject({ kind: "needs_attention" });
        expect(calls).toEqual([
            { url: "/api/tasks/original-task", method: "GET" },
            { url: "/api/tasks/original-task", method: "GET" },
        ]);
    });

    test("network errors propagate without retries or write requests", async () => {
        respond(() => { throw new Error("任务服务暂不可用"); });
        await expect(recoverChatImageTask(pending)).rejects.toThrow("任务服务暂不可用");
        expect(calls).toHaveLength(1);
    });

    test("an already-aborted recovery makes no network request", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(recoverChatImageTask(pending, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(calls).toEqual([]);
    });

    test.each(["direct", "list"])("aborting an in-flight %s query passes the signal through and does not query again", async (mode) => {
        const controller = new AbortController();
        respond((_url, init) => {
            expect(init?.signal).toBe(controller.signal);
            return new Promise((_resolve, reject) => {
                init!.signal!.addEventListener("abort", () => reject(new DOMException("请求已取消", "AbortError")), { once: true });
                controller.abort();
            });
        });
        await expect(recoverChatImageTask({ ...pending, taskId: mode === "direct" ? pending.taskId : undefined }, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(calls).toHaveLength(1);
    });

    test("aborting during the polling wait stops before another GET or any cancellation POST", async () => {
        const controller = new AbortController();
        respond(() => ({ task: { ...originalTask, status: "processing" } }));
        const result = recoverChatImageTask(pending, {
            signal: controller.signal,
            onTask: () => { setTimeout(() => controller.abort(), 10); },
        });
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        await new Promise((resolve) => setTimeout(resolve, 1_050));
        expect(calls).toEqual([{ url: "/api/tasks/original-task", method: "GET" }]);
    });
});
