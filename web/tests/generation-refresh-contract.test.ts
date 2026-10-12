import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { deploymentFeatures } from "../src/lib/deployment-features";
import { getQueuedTaskByRequestId, QueuedTaskFailedError, requestQueuedImages, type QueuedTask } from "../src/services/api/generation-tasks";
import { requestEdit, requestGeneration } from "../src/services/api/image";
import { defaultConfig } from "../src/stores/use-config-store";
import { useUserStore } from "../src/stores/use-user-store";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUserState = useUserStore.getState();
const originalFeatures = { ...deploymentFeatures };
const model = { id: "model-config-1", name: "GPT Image", modelId: "gpt-image-2.5", capabilities: ["generate", "edit"], creditCost: 10, rmbCost: 1 };
const baseInput = { modelId: model.modelId, prompt: "调整花瓣", count: 1, operationType: "image_generation" as const, requestId: "saved-request" };
const originalTask: QueuedTask = { id: "original-task", requestId: "saved-request:0", operationType: "image_generation", status: "success", resultUrls: ["/api/assets/result/content"], failureReason: null };
let calls: Array<{ path: string; method: string; init?: RequestInit }>;

beforeEach(() => {
    calls = [];
    deploymentFeatures.oaLoginEnabled = true;
    globals.window = { location: { pathname: "/canvas/canvas-1" }, setTimeout, clearTimeout };
    useUserStore.setState({ user: { id: "employee-a", role: "designer", status: "active" } as never, status: "authenticated", hydrateSession: async () => {} });
    respond(() => { throw new Error("Unexpected HTTP request"); });
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
    useUserStore.setState(originalUserState);
    Object.assign(deploymentFeatures, originalFeatures);
});

function respond(read: (path: string, init?: RequestInit) => unknown | Promise<unknown>) {
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        calls.push({ path, method: init?.method || "GET", init });
        const response = await read(path, init);
        return response instanceof Response ? response : Response.json(response);
    }) as typeof fetch;
}

function respondToGeneration(onPoll: (init?: RequestInit) => unknown = () => ({ task: originalTask })) {
    respond((path, init) => {
        if (path === "/api/models") return { models: [model] };
        if (path === "/api/tasks" && init?.method === "POST") return { task: { id: originalTask.id } };
        if (path === `/api/tasks/${originalTask.id}`) return onPoll(init);
        if (path === `/api/tasks/${originalTask.id}/cancel`) return new Response(null, { status: 204 });
        throw new Error(`Unexpected HTTP ${init?.method || "GET"} ${path}`);
    });
}

const writes = () => calls.filter(call => call.method === "POST").map(call => call.path);

describe("image request identity before submission", () => {
    test("waits for durable request identity before POST and preserves its exact per-image suffix", async () => {
        respondToGeneration();
        const saving = Promise.withResolvers<void>();
        const saved = Promise.withResolvers<void>();
        const result = requestQueuedImages({ ...baseInput, onSubmissionStarted: async () => { saving.resolve(); await saved.promise; } });
        await saving.promise;
        await Promise.resolve();
        expect(writes()).toEqual([]);
        saved.resolve();
        expect((await result)[0]!.sourceTaskId).toBe(originalTask.id);
        expect(writes()).toEqual(["/api/tasks"]);
        const submitted = calls.find(call => call.path === "/api/tasks")!;
        expect(JSON.parse(String(submitted.init!.body))).toMatchObject({ requestId: "saved-request:0", projectId: "canvas-1" });
    });

    test("a rejected identity save makes no generation POST or cancellation request", async () => {
        respondToGeneration();
        await expect(requestQueuedImages({ ...baseInput, onSubmissionStarted: async () => { throw new Error("request identity save failed"); } })).rejects.toThrow("request identity save failed");
        expect(writes()).toEqual([]);
        expect(calls.map(call => call.path)).toEqual(["/api/models"]);
    });

    test("abort while saving identity prevents the later task POST", async () => {
        respondToGeneration();
        const controller = new AbortController();
        const saving = Promise.withResolvers<void>();
        const saved = Promise.withResolvers<void>();
        const result = requestQueuedImages({ ...baseInput, signal: controller.signal, onSubmissionStarted: async () => { saving.resolve(); await saved.promise; } });
        await saving.promise;
        controller.abort();
        saved.resolve();
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(writes()).toEqual([]);
    });

    test("an employee switch while saving identity is checked again before POST", async () => {
        respondToGeneration();
        const saving = Promise.withResolvers<void>();
        const saved = Promise.withResolvers<void>();
        const result = requestQueuedImages({ ...baseInput, onSubmissionStarted: async () => { saving.resolve(); await saved.promise; } });
        await saving.promise;
        useUserStore.setState({ user: { id: "employee-b", role: "designer", status: "active" } as never });
        saved.resolve();
        await expect(result).rejects.toThrow("员工会话已变化");
        expect(writes()).toEqual([]);
    });
});

describe("image observation and cancellation", () => {
    test.each(["navigation", "stop"])("%s during accepted-task persistence respects cancellation intent before polling starts", async mode => {
        const controller = new AbortController();
        const saving = Promise.withResolvers<void>();
        const saved = Promise.withResolvers<void>();
        respondToGeneration();
        let explicitlyStopped = false;
        const result = requestQueuedImages({ ...baseInput, signal: controller.signal,
            cancelOnAbort: () => explicitlyStopped,
            onSubmitted: async () => { saving.resolve(); await saved.promise; controller.signal.throwIfAborted(); },
        });
        await saving.promise;
        explicitlyStopped = mode === "stop";
        controller.abort();
        saved.resolve();
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(writes()).toEqual(mode === "stop" ? ["/api/tasks", `/api/tasks/${originalTask.id}/cancel`] : ["/api/tasks"]);
        expect(calls.some(call => call.method === "GET" && call.path === `/api/tasks/${originalTask.id}`)).toBe(false);
    });

    test.each(["navigation", "stop", "default"])("%s abort uses the current cancellation intent after a task was accepted", async mode => {
        const controller = new AbortController();
        let explicitlyStopped = false;
        respondToGeneration(init => {
            expect(init?.signal).toBe(controller.signal);
            explicitlyStopped = mode === "stop";
            controller.abort();
            throw new DOMException("请求已取消", "AbortError");
        });
        const result = requestQueuedImages({ ...baseInput, signal: controller.signal, ...(mode === "default" ? {} : { cancelOnAbort: () => explicitlyStopped }) });
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(writes()).toEqual(mode === "navigation" ? ["/api/tasks"] : ["/api/tasks", `/api/tasks/${originalTask.id}/cancel`]);
    });

    test.each(["generate", "edit"])("the %s API forwards persistence and navigation cancellation options", async mode => {
        const controller = new AbortController();
        const saving = Promise.withResolvers<void>();
        const saved = Promise.withResolvers<void>();
        respondToGeneration(() => {
            controller.abort();
            throw new DOMException("页面已离开", "AbortError");
        });
        const options = { signal: controller.signal, cancelOnAbort: () => false, onSubmissionStarted: async () => { saving.resolve(); await saved.promise; } };
        const config = { ...defaultConfig, model: model.modelId, imageModel: model.modelId, count: "1" };
        const result = mode === "generate" ? requestGeneration(config, "花瓣", options) : requestEdit(config, "花瓣", [], undefined, options);
        await saving.promise;
        await Promise.resolve();
        expect(writes()).toEqual([]);
        saved.resolve();
        await expect(result).rejects.toMatchObject({ name: "AbortError" });
        expect(writes()).toEqual(["/api/tasks"]);
    });

    test.each(["failed", "cancelled"])("the %s terminal task is available on QueuedTaskFailedError", async status => {
        const task = { ...originalTask, status, resultUrls: [], failureReason: "原任务终止" };
        respondToGeneration(() => ({ task }));
        const error = await requestQueuedImages(baseInput).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(QueuedTaskFailedError);
        expect((error as QueuedTaskFailedError).task).toEqual(task);
        expect((error as Error).message).toBe("原任务终止");
        expect(writes()).toEqual(["/api/tasks"]);
    });
});

describe("exact image task lookup by request identity", () => {
    test("encodes the complete request identity and carries employee credentials plus signal", async () => {
        const controller = new AbortController();
        const requestId = "canvas /请求?part=1#x:0";
        const task = { ...originalTask, requestId };
        respond(() => ({ task }));
        expect(await getQueuedTaskByRequestId(requestId, controller.signal)).toEqual(task);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.path).toBe(`/api/tasks/by-request/${encodeURIComponent(requestId)}`);
        expect(calls[0]!.method).toBe("GET");
        expect(calls[0]!.init?.signal).toBe(controller.signal);
        expect(calls[0]!.init?.credentials).toBe("include");
        expect(new Headers(calls[0]!.init?.headers).get("X-Canvas-Owner-Id")).toBe("employee-a");
    });

    test("404 returns null without falling back to the recent-task list", async () => {
        respond(() => new Response(null, { status: 404 }));
        expect(await getQueuedTaskByRequestId("saved-request:0")).toBeNull();
        expect(calls.map(call => call.path)).toEqual(["/api/tasks/by-request/saved-request%3A0"]);
        expect(writes()).toEqual([]);
    });

    test("a server error stays an error instead of being mistaken for an absent task", async () => {
        respond(() => Response.json({ message: "任务服务暂不可用" }, { status: 503 }));
        await expect(getQueuedTaskByRequestId("saved-request:0")).rejects.toThrow("任务服务暂不可用");
        expect(calls).toHaveLength(1);
    });
});
