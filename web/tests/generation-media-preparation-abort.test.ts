import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueuedTaskSubmissionUncertainError, requestQueuedMedia, submitQueuedMediaTask, type QueuedMediaInput } from "@/services/api/generation-tasks";
import { useUserStore } from "@/stores/use-user-store";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUserState = useUserStore.getState();
const model = { id: "media-model", name: "Media model", modelId: "media-model", capabilities: ["video", "audio"], creditCost: 1, rmbCost: 1 };
const source = new File(["media"], "source.mp4", { type: "video/mp4" });
const input = (operationType = "video_generation"): QueuedMediaInput => ({ modelId: model.id, operationType, prompt: "test" });

beforeEach(() => {
    globals.window = { location: { pathname: "/canvas/project" }, setTimeout, clearTimeout };
    useUserStore.setState({ user: { id: "employee-a", role: "designer", status: "active" } as never, status: "authenticated" });
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
    useUserStore.setState(originalUserState);
});

describe("queued media preparation cancellation", () => {
    test.each(["video_generation", "audio_generation"])("already-aborted %s does not resolve a model or submit anything", async operation => {
        const controller = new AbortController();
        controller.abort();
        const requests: string[] = [];
        globalThis.fetch = (async url => { requests.push(String(url)); throw new Error("unexpected request"); }) as typeof fetch;
        await expect(submitQueuedMediaTask({ ...input(operation), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(requests).toEqual([]);
    });

    for (const operation of ["video_generation", "audio_generation"]) {
        test.each(["model", "upload-request", "upload-body"])(`${operation} aborted during %s never submits a task or starts a second asset`, async stage => {
            const controller = new AbortController();
            const requests: Array<{ path: string; signal?: AbortSignal | null }> = [];
            globalThis.fetch = (async (url, init) => {
                const path = String(url);
                requests.push({ path, signal: init?.signal });
                if (path === "/api/models") {
                    if (stage === "model") controller.abort();
                    return Response.json({ tools: [], prices: [], models: [model] });
                }
                if (path === "/api/assets/upload-request") {
                    if (stage === "upload-request") controller.abort();
                    return Response.json({ assetId: "source-1", uploadUrl: stage === "upload-body" ? "/api/assets/source-1/content-upload" : null });
                }
                if (path === "/api/assets/source-1/content-upload") {
                    controller.abort();
                    return new Response(null, { status: 204 });
                }
                throw new Error(`unexpected request ${path}`);
            }) as typeof fetch;
            await expect(submitQueuedMediaTask({ ...input(operation), sourceFiles: [source, source], signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
            expect(requests.filter(request => request.path.startsWith("/api/tasks"))).toEqual([]);
            expect(requests.filter(request => request.path === "/api/assets/upload-request")).toHaveLength(stage === "model" ? 0 : 1);
            requests.filter(request => request.path.startsWith("/api/assets/")).forEach(request => expect(request.signal).toBe(controller.signal));
        });
    }

    test("aborting while video preflight returns prevents the paid task POST", async () => {
        const controller = new AbortController();
        const requests: string[] = [];
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            requests.push(path);
            if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [model] });
            if (path === "/api/tasks/preflight") {
                expect(init?.signal).toBe(controller.signal);
                controller.abort();
                return Response.json({ ok: true, normalized: { seconds: 5 } });
            }
            throw new Error(`unexpected request ${path}`);
        }) as typeof fetch;
        await expect(submitQueuedMediaTask({ ...input(), signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(requests).toEqual(["/api/models", "/api/tasks/preflight"]);
    });

    test("video preflight and the single task POST carry the caller signal and identical request identity", async () => {
        const controller = new AbortController();
        const taskRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [model] });
            if (path === "/api/tasks/preflight" || path === "/api/tasks") {
                expect(init?.signal).toBe(controller.signal);
                taskRequests.push({ path, body: JSON.parse(String(init?.body)) });
                return Response.json(path.endsWith("preflight") ? { ok: true, normalized: { seconds: 5 } } : { task: { id: "accepted-task" } });
            }
            if (path === "/api/auth/session") return Response.json({}, { status: 401 });
            throw new Error(`unexpected request ${path}`);
        }) as typeof fetch;
        expect((await submitQueuedMediaTask({ ...input(), signal: controller.signal })).id).toBe("accepted-task");
        expect(taskRequests.map(request => request.path)).toEqual(["/api/tasks/preflight", "/api/tasks"]);
        expect(taskRequests[0]!.body.requestId).toBe(taskRequests[1]!.body.requestId);
        expect(taskRequests[1]!.body.parameters).toMatchObject({ seconds: 5 });
    });

    test("abort during the audio task POST stops the request without another POST or poll", async () => {
        const controller = new AbortController();
        const started = Promise.withResolvers<void>();
        const requests: string[] = [];
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            requests.push(path);
            if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [model] });
            if (path === "/api/tasks") {
                expect(init?.signal).toBe(controller.signal);
                started.resolve();
                return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true }));
            }
            throw new Error(`unexpected request ${path}`);
        }) as typeof fetch;
        const result = requestQueuedMedia({ ...input("audio_generation"), signal: controller.signal });
        await started.promise;
        controller.abort();
        await expect(result).rejects.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
        expect(requests).toEqual(["/api/models", "/api/tasks"]);
    });

    test("an abort after acknowledgement still reports and cancels the original task ID", async () => {
        const controller = new AbortController();
        const requests: string[] = [];
        const submitted: string[] = [];
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            requests.push(`${init?.method || "GET"} ${path}`);
            if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [model] });
            if (path === "/api/tasks") return Response.json({ task: { id: "accepted-task" } });
            if (path === "/api/tasks/accepted-task/cancel") return Response.json({ changed: 1 });
            if (path === "/api/auth/session") return Response.json({}, { status: 401 });
            throw new Error(`unexpected request ${path}`);
        }) as typeof fetch;
        await expect(requestQueuedMedia({ ...input("audio_generation"), signal: controller.signal, onSubmitted: task => { submitted.push(task.id); controller.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
        expect(submitted).toEqual(["accepted-task"]);
        expect(requests.filter(request => request.startsWith("POST /api/tasks"))).toEqual(["POST /api/tasks", "POST /api/tasks/accepted-task/cancel"]);
    });
});
