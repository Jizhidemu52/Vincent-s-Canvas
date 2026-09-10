import { afterEach, expect, test } from "bun:test";

import { QueuedTaskPausedError, requestQueuedImages } from "../src/services/api/generation-tasks";
import { useUserStore } from "../src/stores/use-user-store";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUserState = useUserStore.getState();
afterEach(() => {
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
    useUserStore.setState(originalUserState);
});

test.each([false, true])("an image task paused after interruption stops waiting without resubmission (initially processing: %s)", async (initiallyProcessing) => {
    const requests: Array<{ path: string; method: string }> = [];
    let polls = 0;
    let delays = 0;
    globals.window = {
        location: { pathname: "/chat" },
        setTimeout(callback: () => void) {
            if (++delays > (initiallyProcessing ? 1 : 0)) throw new Error("Paused image incorrectly requested another polling delay");
            queueMicrotask(callback);
            return 1;
        },
        clearTimeout() {},
    };
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        requests.push({ path, method: init?.method || "GET" });
        if (path === "/api/models") return Response.json({ models: [{ id: "image-config", modelId: "gpt-image-2.5-flare", name: "GPT Image", capabilities: ["generate", "edit"], creditCost: 10, rmbCost: 1 }] });
        if (path === "/api/tasks" && init?.method === "POST") return Response.json({ task: { id: "interrupted-image-task" } });
        if (path === "/api/tasks" || path === "/api/tasks/interrupted-image-task") {
            polls += 1;
            const task = {
                id: "interrupted-image-task", requestId: "original-request", operationType: "image_generation",
                status: initiallyProcessing && polls === 1 ? "processing" : "paused", resultUrls: [],
                failureReason: "执行中断，原上游提交状态待核实；已暂停，不能自动重新生成",
            };
            return Response.json(path === "/api/tasks" ? { tasks: [task] } : { task });
        }
        if (path === "/api/auth/session") return Response.json({ message: "test session" }, { status: 401 });
        throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const failure = await requestQueuedImages({ modelId: "gpt-image-2.5-flare", prompt: "生成一朵花", count: 1, operationType: "image_generation" }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QueuedTaskPausedError);
    const paused = failure as QueuedTaskPausedError;
    expect(paused.taskId).toBe("interrupted-image-task");
    expect(paused.canRecover).toBe(false);
    expect(paused.message).toContain("interrupted-image-task");
    expect(paused.message).toContain("请勿重复生成");
    expect(polls).toBe(initiallyProcessing ? 2 : 1);
    expect(requests.filter((request) => request.method === "POST")).toEqual([{ path: "/api/tasks", method: "POST" }]);
});
