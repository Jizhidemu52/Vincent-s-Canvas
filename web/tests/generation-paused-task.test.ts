import { afterEach, expect, test } from "bun:test";

import { QueuedTaskFailedError, QueuedTaskPausedError, requestQueuedImages } from "../src/services/api/generation-tasks";
import { generationErrorMessage, imageResultProcessingFailureMessage, isImageResultProcessingFailure } from "../src/lib/generation-feedback";
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

const pauseCases = [
    { label: "unknown upstream", postprocess: false, canRecover: false, task: {} },
    { label: "known upstream", postprocess: false, canRecover: true, task: { upstreamTaskId: "paid-original" } },
    { label: "postprocess code", postprocess: true, canRecover: false, task: { upstreamTaskId: "paid-original", errorCode: "IMAGE_RESULT_PROCESSING_FAILED" } },
    { label: "postprocess phase", postprocess: true, canRecover: false, task: { upstreamTaskId: "paid-original", lastFailure: { phase: "postprocess" } } },
    { label: "legacy postprocess reason", postprocess: true, canRecover: false, task: { upstreamTaskId: "paid-original", failureReason: "渠道原件已保存到素材库，但图片后处理未完成：decoder failed" } },
];

test.each([
    { failureReason: "渠道原件已保存到素材库，但图片后处理未完成：old decoder failure" },
    { failureReason: imageResultProcessingFailureMessage, errorCode: "IMAGE_RESULT_PROCESSING_FAILED", lastFailure: { phase: "postprocess", code: "IMAGE_RESULT_PROCESSING_FAILED" } },
    { failureReason: "提交状态待核查，请勿重复生成" },
])("cancelled task takes precedence over stale failure details through final presentation: %j", details => {
    const task = { id: "cancelled-task", requestId: "original-request", status: "cancelled", resultUrls: [], ...details };
    const failure = new QueuedTaskFailedError(task);
    expect(failure.task).toBe(task);
    expect(failure.message).toBe("任务已取消。");
    expect(failure.code).toBeUndefined();
    expect(isImageResultProcessingFailure(task)).toBe(false);
    expect(isImageResultProcessingFailure(failure)).toBe(false);
    expect(generationErrorMessage(failure)).toBe("任务已取消。");
    expect(generationErrorMessage(failure.message)).toBe("任务已取消。");
});
test.each(pauseCases.flatMap(pause => [false, true].map(initiallyProcessing => ({ ...pause, initiallyProcessing }))))("a paused image stops waiting without resubmission: %j", async ({ initiallyProcessing, postprocess, canRecover, task: pauseTask }) => {
    useUserStore.setState({ user: { id: "employee-a", role: "designer", status: "active" } as never, status: "authenticated" });
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
        if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [{ id: "image-config", modelId: "gpt-image-2.5-flare", name: "GPT Image", capabilities: ["generate", "edit"], creditCost: 10, rmbCost: 1 }] });
        if (path === "/api/tasks" && init?.method === "POST") return Response.json({ task: { id: "interrupted-image-task" } });
        if (path === "/api/tasks" || path === "/api/tasks/interrupted-image-task") {
            polls += 1;
            const task = {
                id: "interrupted-image-task", requestId: "original-request", operationType: "image_generation",
                status: initiallyProcessing && polls === 1 ? "processing" : "paused", resultUrls: [],
                failureReason: "执行中断，原上游提交状态待核实；已暂停，不能自动重新生成",
                ...pauseTask,
            };
            return Response.json(path === "/api/tasks" ? { tasks: [task] } : { task });
        }
        // Balance refresh must preserve the session: a 401 intentionally stops
        // the new owner-bound observer before a second task query can occur.
        if (path === "/api/auth/session") return Response.json({ user: { id: "employee-a", role: "designer", status: "active" } });
        throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
    const failure = await requestQueuedImages({ modelId: "gpt-image-2.5-flare", prompt: "生成一朵花", count: 1, operationType: "image_generation" }).catch((error: unknown) => error);
    if (postprocess) {
        expect(failure).toBeInstanceOf(QueuedTaskFailedError);
        expect(failure).not.toBeInstanceOf(QueuedTaskPausedError);
        const failed = failure as QueuedTaskFailedError;
        expect(failed.taskId).toBe("interrupted-image-task");
        expect(failed.code).toBe("IMAGE_RESULT_PROCESSING_FAILED");
        expect(failed.message).toContain("原件已保存到素材库");
        expect(failed.message).not.toMatch(/恢复查询|提交结果待核查|decoder/);
    } else {
        expect(failure).toBeInstanceOf(QueuedTaskPausedError);
        const paused = failure as QueuedTaskPausedError;
        expect(paused.taskId).toBe("interrupted-image-task");
        expect(paused.canRecover).toBe(canRecover);
        expect(paused.message).toContain("interrupted-image-task");
        expect(paused.message).toContain(canRecover ? "可恢复查询原任务" : "请勿重复提交");
    }
    expect(polls).toBe(initiallyProcessing ? 2 : 1);
    expect(requests.filter((request) => request.method === "POST")).toEqual([{ path: "/api/tasks", method: "POST" }]);
});
