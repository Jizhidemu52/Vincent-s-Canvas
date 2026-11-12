import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { confirmCanvasTextRetry, createCanvasMediaSubmission, recoverCanvasMediaTask, runCanvasMediaGeneration } from "@/pages/canvas/canvas-media-generation-runtime";
import { runCanvasGeneration, type CanvasGenerationResult } from "@/pages/canvas/canvas-shared-generation-runtime";
import {
    QueuedTaskFailedError,
    QueuedTaskPausedError,
    QueuedTaskSubmissionUncertainError,
    submitQueuedMediaTask,
    type QueuedTask,
} from "@/services/api/generation-tasks";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUserState = useUserStore.getState();
const modes = ["video", "audio"] as const;
type Mode = typeof modes[number];
type CapturedRequest = { path: string; method: string; body?: Record<string, unknown> };
const model = { id: "media-model", name: "Media model", modelId: "media-model", capabilities: ["video", "audio"], creditCost: 1, rmbCost: 1 };
const binding = { requestId: "request / original", ownerId: "employee-a", projectId: "project" };
let requests: CapturedRequest[];

beforeEach(() => {
    requests = [];
    globals.window = { location: { pathname: "/canvas/project" }, setTimeout, clearTimeout };
    useUserStore.setState({
        user: { id: "employee-a", role: "designer", status: "active" } as never,
        status: "authenticated",
        hydrateSession: async () => undefined,
    });
    network(() => { throw new Error("Unexpected HTTP request in an offline runtime test"); });
});

afterEach(() => {
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
    useUserStore.setState(originalUserState);
});

function network(handler: (request: CapturedRequest) => Response | Promise<Response>) {
    globalThis.fetch = (async (url, init) => {
        const request = { path: String(url), method: init?.method || "GET", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) };
        requests.push(request);
        return handler(request);
    }) as typeof fetch;
}

function node(id: string, type: CanvasNodeType, metadata: CanvasNodeMetadata = {}): CanvasNodeData {
    return { id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata };
}

function harness(mode: Mode = "video", metadata: CanvasNodeMetadata = {}) {
    const nodes = { current: [node("result", mode === "video" ? CanvasNodeType.Video : CanvasNodeType.Audio, { status: "loading", ...metadata })] };
    const saved: CanvasNodeData[][] = [];
    let flushes = 0;
    let current = true;
    let onPersist: (() => Promise<void>) | undefined;
    const context = {
        projectId: "project", nodes,
        isCurrent: () => current,
        setNodes: (value: CanvasNodeData[] | ((previous: CanvasNodeData[]) => CanvasNodeData[])) => { nodes.current = typeof value === "function" ? value(nodes.current) : value; },
        flushSave: () => { flushes++; },
        persist: async (value: CanvasNodeData[]) => { saved.push(structuredClone(value)); await onPersist?.(); },
    };
    return { context, saved, get metadata() { return nodes.current[0]!.metadata!; }, get flushes() { return flushes; },
        onPersist: (callback?: () => Promise<void>) => { onPersist = callback; },
        leaveProject: () => { current = false; },
        submission: () => createCanvasMediaSubmission("result", context),
    };
}

function task(patch: Partial<QueuedTask> = {}): QueuedTask {
    return { id: "task / original", requestId: binding.requestId, status: "queued", resultUrls: [], failureReason: null, ...patch };
}

async function rejected(pending: Promise<unknown>): Promise<unknown> {
    try { await pending; } catch (error) { return error; }
    throw new Error("Expected the operation to reject");
}

describe("canvas model-specific unsaved video duration", () => {
    test.each([
        ["gemini-omni-1.2-flash", undefined, false, 10],
        ["gemini-omni-1.2-flash", "8", false, 8],
        ["gemini-omni-1.2-flash", undefined, true, 10],
        ["gemini-omni-1.2-flash", "8", true, 8],
        ["doubao-seedance-2.5", undefined, false, 5],
        ["doubao-seedance-2.5", "8", true, 8],
    ] as const)("%s saved=%s shared=%s retains its own duration %s", async (modelId, seconds, shared, expected) => {
        const h = harness("video", shared ? {} : { seconds });
        if (shared) h.context.nodes.current.push(node("settings", CanvasNodeType.Config, { seconds, generationMode: "video" }));
        const controller = new AbortController();
        network(request => {
            if (request.path === "/api/models") return Response.json({ models: [{ ...model, id: modelId, modelId, capabilities: ["video"] }], tools: [], prices: [] });
            expect(request.path).toBe("/api/tasks/preflight");
            expect(request.body?.parameters).toMatchObject({ seconds: expected });
            return Response.json({ message: "Offline validation stop" }, { status: 400 });
        });
        const result = await runCanvasMediaGeneration({ ...h.context, nodeId: "result", mode: "video", source: h.context.nodes.current[0], shared,
            config: { ...defaultConfig, model: modelId, videoModel: modelId, videoSeconds: seconds || "5" },
            context: { prompt: "offline video", referenceImages: [], referenceVideos: [], referenceAudios: [], imageCount: 0, videoCount: 0, audioCount: 0, textCount: 0 },
            origin: { sourceNodeId: "result", configNodeId: shared ? "settings" : undefined, runId: "new", mode: "video" },
            controller, runningId: "result", setConnections: () => undefined, start: () => controller, finish: () => undefined,
        });
        expect(result.status).toBe("failed");
        expect(requests.filter(request => request.path === "/api/tasks/preflight")).toHaveLength(1);
        expect(requests.filter(request => request.path === "/api/tasks")).toHaveLength(0);
        expect(h.metadata.seconds).toBe(String(expected));
    });
});

describe("canvas media edit-lease fence", () => {
    test.each(modes)("%s completion waits for renewal without losing its accepted task or result", async mode => {
        const h = harness(mode, { mediaTask: { ...binding, taskId: "accepted" } });
        const renewal = Promise.withResolvers<boolean>();
        const submission = createCanvasMediaSubmission("result", { ...h.context, waitForWriteAccess: () => renewal.promise });
        const completion = submission.complete({ status: "success", content: "original-result" });
        expect(h.saved).toEqual([]);
        expect(h.metadata.mediaTask?.taskId).toBe("accepted");
        renewal.resolve(true);
        await completion;
        expect(h.saved).toHaveLength(1);
        expect(h.metadata).toMatchObject({ status: "success", content: "original-result" });
        expect(h.metadata.mediaTask).toBeUndefined();
        expect(requests).toEqual([]);
    });

    test.each(modes)("%s old editor cannot complete or fail over a new holder's state", async mode => {
        const h = harness(mode, { mediaTask: { ...binding, taskId: "accepted" } });
        const submission = createCanvasMediaSubmission("result", { ...h.context, waitForWriteAccess: async () => false });
        await expect(submission.complete({ status: "success", content: "stale-result" })).rejects.toMatchObject({ name: "AbortError" });
        await submission.fail(new Error("late observation failure"), true);
        expect(h.saved).toEqual([]);
        expect(h.metadata.mediaTask?.taskId).toBe("accepted");
        expect(h.metadata.content).toBeUndefined();
        expect(requests).toEqual([]);
    });
});

describe("canvas media identity is persisted before submission continues", () => {
    test.each(modes)("%s requestId is durably awaited before the task POST", async mode => {
        const h = harness(mode);
        const submission = h.submission();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        h.onPersist(async () => { entered.resolve(); await release.promise; });
        network(request => {
            if (request.path === "/api/tasks/preflight") return Response.json({ ok: true, normalized: {} });
            expect(request).toMatchObject({ path: "/api/tasks", method: "POST" });
            expect(h.metadata.mediaTask).toEqual({ ...binding, requestId: request.body!.requestId });
            expect(h.saved[0]![0]!.metadata!.mediaTask).toEqual(h.metadata.mediaTask);
            return Response.json({ task: task() });
        });
        const pending = submitQueuedMediaTask({ modelId: model.id, resolvedModel: model, prompt: "offline", operationType: `${mode}_generation`, onSubmissionStarted: submission.onSubmissionStarted });
        await entered.promise;
        expect(requests.filter(request => request.path === "/api/tasks")).toHaveLength(0);
        expect(h.metadata.generationSubmissionUncertain).toBe(true);
        expect(h.metadata.mediaTask?.taskId).toBeUndefined();
        expect(h.flushes).toBe(1);
        release.resolve();
        const accepted = await pending;
        expect(accepted.requestId).toBe(h.metadata.mediaTask?.requestId);
        expect(requests.filter(request => request.path === "/api/tasks")).toHaveLength(1);
    });

    test.each(modes)("%s persistence rejection prevents the task POST and clears pre-submit binding", async mode => {
        const h = harness(mode);
        const failure = new Error("pending save failed");
        h.onPersist(async () => { throw failure; });
        network(request => {
            expect(request.path).toBe("/api/tasks/preflight");
            return Response.json({ ok: true, normalized: {} });
        });
        const error = await rejected(submitQueuedMediaTask({ modelId: model.id, resolvedModel: model, prompt: "offline", operationType: `${mode}_generation`, onSubmissionStarted: h.submission().onSubmissionStarted }));
        expect(error).toBe(failure);
        expect(requests.filter(request => request.path === "/api/tasks")).toHaveLength(0);
        expect(h.metadata.mediaTask).toBeUndefined();
        expect(h.metadata.generationSubmissionUncertain).toBeUndefined();
    });

    test.each(modes)("%s taskId save is awaited before acknowledgement resolves", async mode => {
        const h = harness(mode);
        const submission = h.submission();
        await submission.onSubmissionStarted(binding.requestId);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let settled = false;
        h.onPersist(async () => { entered.resolve(); await release.promise; });
        const pending = submission.onSubmitted(task()).then(() => { settled = true; });
        await entered.promise;
        expect(settled).toBe(false);
        expect(h.metadata.mediaTask).toEqual({ ...binding, taskId: task().id });
        expect(h.saved.at(-1)![0]!.metadata!.mediaTask).toEqual(h.metadata.mediaTask);
        if (mode === "video") expect(h.metadata).toMatchObject({ videoTaskId: task().id, videoTaskCanRecover: true });
        release.resolve();
        await pending;
        expect(settled).toBe(true);
    });

    test("an existing original-task binding refuses a replacement requestId", async () => {
        const h = harness("video", { mediaTask: binding });
        const initial = structuredClone(h.context.nodes.current);
        const error = await rejected(h.submission().onSubmissionStarted("new-paid-task"));
        expect((error as Error).message).toContain("勿重复生成");
        expect(h.context.nodes.current).toEqual(initial);
        expect(h.saved).toHaveLength(0);
    });
});

describe("canvas media completion and failure keep only unsettled task bindings", () => {
    test.each(modes)("%s observation-only abort preserves a request whose POST acknowledgement may be late", async mode => {
        const h = harness(mode);
        const submission = h.submission();
        await submission.onSubmissionStarted(binding.requestId);
        await submission.fail(new DOMException("stopped local observation", "AbortError"), true);
        expect(h.metadata.mediaTask).toEqual(binding);
        expect(h.metadata.generationSubmissionUncertain).toBe(true);
        expect(h.metadata.errorDetails).toContain("重试只查询");
    });
    test.each(modes)("%s completed result clears recovery identity in persisted state", async mode => {
        const h = harness(mode, { errorDetails: "old failure", videoTaskCanRecover: true });
        const submission = h.submission();
        await submission.onSubmissionStarted(binding.requestId);
        await submission.onSubmitted(task());
        await submission.complete({ status: "success", content: "blob:stored-result", storageKey: "stored-result", mimeType: `${mode}/test` });
        expect(h.metadata).toMatchObject({ status: "success", content: "blob:stored-result", storageKey: "stored-result" });
        expect(h.metadata.mediaTask).toBeUndefined();
        expect(h.metadata.generationSubmissionUncertain).toBeUndefined();
        expect(h.metadata.videoTaskCanRecover).toBeUndefined();
        expect(h.metadata.errorDetails).toBeUndefined();
        expect(h.saved.at(-1)![0]!.metadata).toEqual(h.metadata);
    });

    for (const mode of modes) {
        test.each(["error", "abort"])(`${mode}: a pre-POST %s clears its provisional identity`, async kind => {
            const h = harness(mode);
            const submission = h.submission();
            await submission.onSubmissionStarted(binding.requestId);
            await submission.fail(kind === "abort" ? new DOMException("cancel before POST", "AbortError") : new Error("preparation rejected"));
            expect(h.metadata.status).toBe(kind === "abort" ? "idle" : "error");
            expect(h.metadata.mediaTask).toBeUndefined();
            expect(h.metadata.generationSubmissionUncertain).toBeUndefined();
            expect(h.metadata.videoTaskCanRecover).toBeUndefined();
        });

        test.each([false, true])(`${mode}: uncertain submission preserves its requestId (taskId known=%s)`, async known => {
            const h = harness(mode);
            const submission = h.submission();
            await submission.onSubmissionStarted(binding.requestId);
            const detail = await submission.fail(new QueuedTaskSubmissionUncertainError(binding.requestId, known ? task().id : undefined));
            expect(h.metadata.mediaTask).toEqual({ ...binding, taskId: known ? task().id : undefined });
            expect(h.metadata.generationSubmissionUncertain).toBe(true);
            expect(h.metadata.status).toBe("error");
            expect(detail).toContain("重试只查询");
        });

        test.each([false, true])(`${mode}: paused task keeps the original identity (upstream known=%s)`, async known => {
            const h = harness(mode);
            const submission = h.submission();
            await submission.onSubmissionStarted(binding.requestId);
            await submission.fail(new QueuedTaskPausedError(task({ status: "paused", upstreamTaskId: known ? "upstream" : null })));
            expect(h.metadata.mediaTask).toEqual({ ...binding, taskId: task().id });
            expect(h.metadata.generationSubmissionUncertain).toBe(true);
            expect(h.metadata.status).toBe("error");
        });

        test.each(["acknowledgement", "completion"])(`${mode}: %s storage failure retains the accepted original task`, async phase => {
            const h = harness(mode);
            const submission = h.submission();
            await submission.onSubmissionStarted(binding.requestId);
            if (phase === "completion") await submission.onSubmitted(task());
            const failure = new Error("local result storage failed");
            h.onPersist(async () => { throw failure; });
            const error = await rejected(phase === "acknowledgement" ? submission.onSubmitted(task()) : submission.complete({ status: "success", content: "blob:unpersisted" }));
            expect(error).toBe(failure);
            h.onPersist();
            await submission.fail(error);
            expect(h.metadata.mediaTask).toEqual({ ...binding, taskId: task().id });
            expect(h.metadata.generationSubmissionUncertain).toBe(true);
            expect(h.metadata.status).toBe("error");
            expect(h.saved.at(-1)![0]!.metadata!.mediaTask).toEqual(h.metadata.mediaTask);
        });
    }

    test("a confirmed terminal failure clears an acknowledged task binding", async () => {
        const h = harness();
        const submission = h.submission();
        await submission.onSubmissionStarted(binding.requestId);
        await submission.onSubmitted(task());
        await submission.fail(new QueuedTaskFailedError(task({ status: "failed", failureReason: "confirmed failure" })));
        expect(h.metadata).toMatchObject({ status: "error", errorDetails: "confirmed failure" });
        expect(h.metadata.mediaTask).toBeUndefined();
        expect(h.metadata.generationSubmissionUncertain).toBeUndefined();
        expect(h.metadata.videoTaskId).toBeUndefined();
    });
});

describe("canvas recovery queries only the original task", () => {
    for (const mode of modes) {
        test.each([false, true])(`${mode}: GET 404 preserves the binding without POST (taskId known=%s)`, async known => {
            const original = { ...binding, ...(known ? { taskId: task().id } : {}) };
            const h = harness(mode, { status: "error", mediaTask: original });
            network(() => Response.json({ message: "not currently visible" }, { status: 404 }));
            const output = await recoverCanvasMediaTask("result", h.context);
            expect(output).toMatchObject({ nodeId: "result", status: "failed" });
            expect(h.metadata.mediaTask).toMatchObject(original);
            expect(h.metadata.generationSubmissionUncertain).toBe(true);
            expect(requests).toEqual([{ path: known ? `/api/tasks/${encodeURIComponent(task().id)}` : `/api/tasks/by-request/${encodeURIComponent(binding.requestId)}`, method: "GET" }]);
        });

        for (const status of ["failed", "cancelled"]) {
            test(`${mode}: confirmed ${status} lookup clears identity without replacement or recovery POST`, async () => {
                const h = harness(mode, { status: "error", mediaTask: binding, generationSubmissionUncertain: true });
                network(() => Response.json({ task: task({ status, failureReason: `confirmed-${status}` }) }));
                const output = await recoverCanvasMediaTask("result", h.context);
                expect(output).toMatchObject({ nodeId: "result", status: "failed", error: status === "cancelled" ? "任务已取消。" : `confirmed-${status}` });
                expect(h.metadata.mediaTask).toBeUndefined();
                expect(h.metadata.generationSubmissionUncertain).toBeUndefined();
                expect(requests).toEqual([{ path: `/api/tasks/by-request/${encodeURIComponent(binding.requestId)}`, method: "GET" }]);
            });
        }
    }

    for (const known of [false, true]) {
        test.each(["network", "HTTP 500", "malformed JSON"])(`query %s failure keeps the original binding (taskId known=${known})`, async failure => {
            const original = { ...binding, ...(known ? { taskId: task().id } : {}) };
            const h = harness("audio", { status: "error", mediaTask: original });
            network(() => {
                if (failure === "network") throw new TypeError("query disconnected");
                return failure === "HTTP 500" ? Response.json({ message: "query unavailable" }, { status: 500 }) : new Response("{", { status: 200 });
            });
            const output = await recoverCanvasMediaTask("result", h.context);
            expect(output?.status).toBe("failed");
            expect(h.metadata.mediaTask).toMatchObject(original);
            expect(h.metadata.generationSubmissionUncertain).toBe(true);
            expect(requests).toHaveLength(1);
            expect(requests[0]!.method).toBe("GET");
        });
    }

    test("aborting a recovery observation preserves the original request-only binding", async () => {
        const h = harness("audio", { mediaTask: binding });
        const controller = new AbortController();
        controller.abort();
        const output = await recoverCanvasMediaTask("result", h.context, controller.signal);
        expect(output?.status).toBe("failed");
        expect(h.metadata.mediaTask).toMatchObject(binding);
        expect(h.metadata.generationSubmissionUncertain).toBe(true);
        expect(requests).toEqual([]);
    });

    test("a paused lookup may recover only the recorded task, never submit a replacement", async () => {
        const originalTask = task({ id: "original-task", status: "paused", upstreamTaskId: "original-upstream" });
        const h = harness("video", { mediaTask: binding });
        network(request => {
            if (request.method === "GET") return Response.json({ task: originalTask });
            expect(request).toEqual({ path: "/api/tasks/original-task/recover", method: "POST" });
            return Response.json({ task: originalTask });
        });
        const output = await recoverCanvasMediaTask("result", h.context);
        expect(output?.status).toBe("failed");
        expect(h.metadata.mediaTask).toEqual({ ...binding, taskId: originalTask.id });
        expect(h.metadata.generationSubmissionUncertain).toBe(true);
        expect(requests).toEqual([
            { path: `/api/tasks/by-request/${encodeURIComponent(binding.requestId)}`, method: "GET" },
            { path: "/api/tasks/original-task/recover", method: "POST" },
        ]);
    });

    test("an account switch while the original query is in flight cannot update its node", async () => {
        const h = harness("video", { mediaTask: binding });
        const initial = structuredClone(h.context.nodes.current);
        network(() => {
            useUserStore.setState({ user: { id: "employee-b", role: "designer", status: "active" } as never });
            return Response.json({ task: task({ status: "failed", failureReason: "old-account result" }) });
        });
        const output = await recoverCanvasMediaTask("result", h.context);
        expect(output?.status).toBe("failed");
        expect(h.context.nodes.current).toEqual(initial);
        expect(h.saved).toHaveLength(0);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.method).toBe("GET");
    });

    test.each(["owner", "project"])("a different %s cannot recover or mutate this node", async mismatch => {
        const h = harness("video", { mediaTask: { ...binding, ...(mismatch === "owner" ? { ownerId: "employee-b" } : { projectId: "another-project" }) } });
        const initial = structuredClone(h.context.nodes.current);
        expect(await rejected(recoverCanvasMediaTask("result", h.context))).toBeInstanceOf(Error);
        expect(h.context.nodes.current).toEqual(initial);
        expect(h.saved).toEqual([]);
        expect(requests).toEqual([]);
    });
});

test("late callbacks after an account switch do not mutate or persist the old node", async () => {
    const h = harness();
    const submission = h.submission();
    await submission.onSubmissionStarted(binding.requestId);
    const initial = structuredClone(h.context.nodes.current);
    const saves = h.saved.length;
    useUserStore.setState({ user: { id: "employee-b", role: "designer", status: "active" } as never });
    expect(await rejected(submission.onSubmitted(task()))).toMatchObject({ name: "AbortError" });
    expect(await rejected(submission.complete({ content: "blob:wrong-owner", status: "success" }))).toMatchObject({ name: "AbortError" });
    await submission.fail(new QueuedTaskSubmissionUncertainError(binding.requestId, task().id));
    expect(h.context.nodes.current).toEqual(initial);
    expect(h.saved).toHaveLength(saves);
});

test("late callbacks after leaving the project do not mutate or persist the old node", async () => {
    const h = harness();
    const submission = h.submission();
    await submission.onSubmissionStarted(binding.requestId);
    const initial = structuredClone(h.context.nodes.current);
    const saves = h.saved.length;
    h.leaveProject();
    expect(await rejected(submission.onSubmitted(task()))).toMatchObject({ name: "AbortError" });
    expect(await rejected(submission.complete({ content: "blob:wrong-project", status: "success" }))).toMatchObject({ name: "AbortError" });
    await submission.fail(new QueuedTaskSubmissionUncertainError(binding.requestId, task().id));
    expect(h.context.nodes.current).toEqual(initial);
    expect(h.saved).toHaveLength(saves);
});

describe("shared media execution cannot bypass unresolved old output nodes", () => {
    for (const mode of [...modes, "text"] as const) {
        for (const status of ["error", "idle", "success"] as const) {
            test.each(["config", "source"])(`${mode}: ${status} output blocks %s rerun even when it is not loading`, async entry => {
                const type = mode === "video" ? CanvasNodeType.Video : mode === "audio" ? CanvasNodeType.Audio : CanvasNodeType.Text;
                let nodes = [
                    node("config", CanvasNodeType.Config, { generationMode: mode, prompt: "offline" }),
                    node("source", type),
                    node("old-result", type, { status, ...(mode === "text" ? { generationSubmissionUncertain: true } : { mediaTask: binding }), generationOrigin: { configNodeId: "config", sourceNodeId: "source", runId: "old-run", mode } }),
                ];
                const connections: CanvasConnection[] = [{ id: "bound", fromNodeId: "config", toNodeId: "source", kind: "config-target" }];
                let executions = 0;
                let recoveries = 0;
                const errors: string[] = [];
                let result: CanvasGenerationResult | undefined;
                await runCanvasGeneration(entry, mode, "ignored", value => { result = value; }, {
                    snapshot: { nodes, connections }, getSnapshot: () => ({ nodes, connections }),
                    buildConfig: () => defaultConfig, isAiConfigReady: () => true,
                    execute: async () => { executions++; }, recover: async () => { recoveries++; return null; },
                    start: () => new AbortController(), finish: () => {}, setRunning: () => {},
                    setNodes: value => { nodes = typeof value === "function" ? value(nodes) : value; },
                    message: { info: () => {}, error: detail => { errors.push(detail); } },
                });
                expect(executions).toBe(0);
                expect(recoveries).toBe(0);
                expect(errors[0]).toMatch(/避免重复提交|勿重复生成/);
                expect(result?.outputs[0]?.status).toBe("failed");
                const metadata = nodes.find(item => item.id === "old-result")!.metadata!;
                if (mode === "text") expect(metadata.generationSubmissionUncertain).toBe(true);
                else expect(metadata.mediaTask).toEqual(binding);
                expect(requests).toEqual([]);
            });
        }
    }
});

describe("text retry requires explicit confirmation against current canvas state", () => {
    function textRetryHarness() {
        type RetryContext = Parameters<typeof confirmCanvasTextRetry>[1];
        type Confirmation = Parameters<RetryContext["modal"]["confirm"]>[0];
        const nodes = { current: [
            node("config", CanvasNodeType.Config, { generationMode: "text" }),
            node("source", CanvasNodeType.Text, { content: "original input" }),
            node("text-result", CanvasNodeType.Text, { generationSubmissionUncertain: true, generationOrigin: { configNodeId: "config", sourceNodeId: "source", runId: "original-run", mode: "text" } }),
            node("unrelated-result", CanvasNodeType.Text, { generationSubmissionUncertain: true }),
        ] };
        const confirmations: Confirmation[] = [];
        const generated: Array<{ id: string; mode: string; prompt: string; uncertainAtGeneration: unknown }> = [];
        const events: string[] = [];
        const info: string[] = [];
        const warnings: string[] = [];
        const context: RetryContext = {
            nodes, locks: new Set<string>(),
            setNodes: value => { events.push("setNodes"); nodes.current = typeof value === "function" ? value(nodes.current) : value; },
            generate: async (id, mode, prompt) => {
                events.push("generate");
                generated.push({ id, mode, prompt, uncertainAtGeneration: nodes.current.find(item => item.id === "text-result")?.metadata?.generationSubmissionUncertain });
            },
            message: { info: detail => { info.push(detail); }, warning: detail => { warnings.push(detail); } },
            modal: { confirm: options => { confirmations.push(options); } },
        };
        return { context, confirmations, generated, events, info, warnings,
            open: () => confirmCanvasTextRetry(nodes.current.find(item => item.id === "text-result")!, context),
            get uncertain() { return nodes.current.find(item => item.id === "text-result")!.metadata!.generationSubmissionUncertain; },
        };
    }

    test("opening text retry only asks for confirmation and keeps the unresolved result", () => {
        const h = textRetryHarness();
        const initial = structuredClone(h.context.nodes.current);
        h.open();
        expect(h.confirmations).toHaveLength(1);
        expect(h.confirmations[0]!.content).toContain("创建新任务并重新调用模型");
        expect(h.confirmations[0]!.cancelText).toBe("取消");
        expect(h.generated).toEqual([]);
        expect(h.events).toEqual([]);
        expect(h.context.nodes.current).toEqual(initial);
        expect(requests).toEqual([]);
    });

    test("confirming clears only the selected result flag before generating from its original text source", async () => {
        const h = textRetryHarness();
        h.open();
        await h.confirmations[0]!.onOk();
        expect(h.events).toEqual(["setNodes", "generate"]);
        expect(h.generated).toEqual([{ id: "source", mode: "text", prompt: "", uncertainAtGeneration: undefined }]);
        expect(h.uncertain).toBeUndefined();
        expect(h.context.nodes.current.find(item => item.id === "unrelated-result")!.metadata!.generationSubmissionUncertain).toBe(true);
        expect(h.context.nodes.current.find(item => item.id === "source")!.metadata!.content).toBe("original input");
        expect(requests).toEqual([]);
    });

    test("a dispatch lock acquired while confirmation is open blocks generation without clearing the flag", async () => {
        const h = textRetryHarness();
        h.open();
        h.context.locks.add("active-dispatch");
        await h.confirmations[0]!.onOk();
        expect(h.info).toHaveLength(1);
        expect(h.info[0]).toContain("仍在执行");
        expect(h.uncertain).toBe(true);
        expect(h.generated).toEqual([]);
        expect(h.events).toEqual([]);
        expect(requests).toEqual([]);
    });

    test("changed non-text configuration or a missing source preserves the flag and prevents generation", async () => {
        for (const change of ["non-text-config", "missing-source"]) {
            const h = textRetryHarness();
            h.open();
            h.context.nodes.current = change === "missing-source"
                ? h.context.nodes.current.filter(item => item.id !== "source")
                : h.context.nodes.current.map(item => item.id === "config" ? { ...item, metadata: { ...item.metadata, generationMode: "image" } } : item);
            await h.confirmations[0]!.onOk();
            expect(h.warnings).toHaveLength(1);
            expect(h.warnings[0]).toContain("原文本配置或输入已变化");
            expect(h.uncertain).toBe(true);
            expect(h.generated).toEqual([]);
            expect(h.events).toEqual([]);
        }
        expect(requests).toEqual([]);
    });
});
