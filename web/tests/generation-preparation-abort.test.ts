import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { requestQueuedImages, type ImageSubmissionModel } from "../src/services/api/generation-tasks";
import { useUserStore } from "../src/stores/use-user-store";
import type { ReferenceImage } from "../src/types/image";
import { generatePlannedPatternLayer } from "../src/pages/creative/pattern-layers-model";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalFileReader = globals.FileReader;
const originalUserState = useUserStore.getState();
beforeEach(() => { useUserStore.setState({ user: { id: "employee-a", role: "designer", status: "active" } as never, status: "authenticated" }); });
afterEach(() => {
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
    globals.FileReader = originalFileReader;
    useUserStore.setState(originalUserState);
});

const model = { id: "model-config-1", name: "GPT Image", modelId: "gpt-image-2.5", capabilities: ["generate", "edit"], creditCost: 10, rmbCost: 1 };
const baseInput = { modelId: "gpt-image-2.5", prompt: "保留中文字，调整花瓣", count: 1, operationType: "inpaint" as const };
const reference: ReferenceImage = { id: "reference-1", name: "reference.png", type: "image/png", dataUrl: "data:image/png;base64,QQ==" };

describe("queued image preparation cancellation", () => {
    test.each(["upload", "accepted"])("a pattern workspace abandoned during %s blocks only unsubmitted work", async stage => {
        globals.window = { location: { pathname: "/creative/pattern-layers" } };
        let current = true;
        let saved = false;
        const taskPosts: RequestInit[] = [];
        const accepted: string[] = [];
        const cancellationRequests: string[] = [];
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [model] });
            if (path === "/api/assets/upload-request") {
                expect(saved).toBe(true);
                if (stage === "upload") current = false;
                return Response.json({ assetId: "pattern-source", uploadUrl: null });
            }
            if (path === "/api/tasks" && init?.method === "POST") {
                taskPosts.push(init);
                if (stage === "accepted") current = false;
                return Response.json({ task: { id: "original-pattern-task" } });
            }
            if (path.endsWith("/cancel")) cancellationRequests.push(path);
            if (path === "/api/tasks/original-pattern-task") return Response.json({ task: { id: "original-pattern-task", requestId: "pattern-request:0", status: "success", resultUrls: ["/api/assets/pattern-mask/content"], failureReason: null } });
            if (path === "/api/auth/session") return Response.json({}, { status: 401 });
            throw new Error(`Unexpected request ${path}`);
        }) as typeof fetch;
        const result = generatePlannedPatternLayer({
            sourceId: reference.id, targetLabel: "红花", imageModelId: model.id, imageModelName: model.name, imageRequestId: "pattern-request",
            isCurrent: () => current,
            analyze: async () => ({ summary: "提取红花", prompt: "只输出红花的黑白蒙版", observations: [], preserve: [], warnings: [], modelId: "planner", modelName: "Planner", requestId: "plan-request" }),
            persist: async () => { saved = true; },
            generate: (trace, onSubmissionStarted) => requestQueuedImages({ ...baseInput, tool: "creative-pattern-layers", prompt: trace.plan.prompt, requestId: trace.imageRequestId, references: [reference], onSubmissionStarted, onSubmitted: ids => { accepted.push(...ids); } }),
        });
        if (stage === "upload") {
            await expect(result).rejects.toThrow("当前分层工程已变化");
            expect(taskPosts).toHaveLength(0);
            expect(accepted).toEqual([]);
        } else {
            expect((await result).result[0]?.sourceTaskId).toBe("original-pattern-task");
            expect(taskPosts).toHaveLength(1);
            expect(taskPosts[0]?.signal).toBeUndefined();
            expect(accepted).toEqual(["original-pattern-task"]);
        }
        expect(cancellationRequests).toEqual([]);
    });

    test("an already-aborted user turn does not even resolve the model", async () => {
        const controller = new AbortController();
        controller.abort();
        const requests: string[] = [];
        globalThis.fetch = (async (url) => { requests.push(String(url)); throw new Error("unexpected request"); }) as typeof fetch;
        await expect(requestQueuedImages({ ...baseInput, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
        expect(requests).toEqual([]);
    });

    test.each(["model", "source-read", "upload-request", "upload-body"])("an account-change abort during %s does not submit a task or start another reference", async (stage) => {
        globals.window = { location: { pathname: "/chat" } };
        globals.FileReader = class {
            result = "";
            onload?: () => void;
            readAsDataURL(blob: Blob) {
                void blob.arrayBuffer().then((bytes) => {
                    this.result = `data:${blob.type};base64,${Buffer.from(bytes).toString("base64")}`;
                    this.onload?.();
                });
            }
        };
        const controller = new AbortController();
        const requests: Array<{ url: string; method: string }> = [];
        let uploadCount = 0;
        let submittedCalls = 0;
        let submissionStartedCalls = 0;
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            requests.push({ url: path, method: init?.method || "GET" });
            if (path === "/api/models") {
                if (stage === "model") controller.abort();
                return Response.json({ tools: [], prices: [], models: [model] });
            }
            if (path === "/api/assets/source/content") {
                if (stage === "source-read") controller.abort();
                return new Response("source image", { headers: { "content-type": "image/png" } });
            }
            if (path === "/api/assets/upload-request") {
                uploadCount += 1;
                if (stage === "upload-request") controller.abort();
                return Response.json({ assetId: "uploaded-1", uploadUrl: stage === "upload-body" ? "/api/assets/uploaded-1/content-upload" : null });
            }
            if (path === "/api/assets/uploaded-1/content-upload") {
                if (stage === "upload-body") controller.abort();
                return new Response(null, { status: 204 });
            }
            throw new Error(`unexpected request ${path}`);
        }) as typeof fetch;
        const references = stage === "source-read" ? [{ ...reference, dataUrl: "/api/assets/source/content" }] : [reference, { ...reference, id: "reference-2" }];
        await expect(requestQueuedImages({ ...baseInput, references, signal: controller.signal, onSubmissionStarted: () => { submissionStartedCalls += 1; }, onSubmitted: () => { submittedCalls += 1; } })).rejects.toMatchObject({ name: "AbortError" });
        expect(requests.filter((item) => item.url === "/api/tasks")).toEqual([]);
        expect(uploadCount).toBe(stage === "model" || stage === "source-read" ? 0 : 1);
        expect(submittedCalls).toBe(0);
        expect(submissionStartedCalls).toBe(0);
    });

    test("the task POST carries the caller signal and a successful task is submitted only once", async () => {
        globals.window = { location: { pathname: "/chat" } };
        const controller = new AbortController();
        const taskPosts: RequestInit[] = [];
        let submittedCalls = 0;
        let submittedModel: ImageSubmissionModel | undefined;
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [model] });
            if (path === "/api/tasks" && init?.method === "POST") {
                taskPosts.push(init);
                return Response.json({ task: { id: "task-1" } });
            }
            if (path === "/api/tasks/task-1") return Response.json({ task: { id: "task-1", requestId: "request-1", status: "success", resultUrls: ["/api/assets/result-1/content"], failureReason: null } });
            if (path === "/api/auth/session") return Response.json({ message: "no session in test" }, { status: 401 });
            throw new Error(`unexpected request ${path}`);
        }) as typeof fetch;
        const result = await requestQueuedImages({ ...baseInput, signal: controller.signal, onSubmitted: (ids, actualModel) => { expect(ids).toEqual(["task-1"]); submittedCalls += 1; submittedModel = actualModel; } });
        expect(taskPosts).toHaveLength(1);
        expect(taskPosts[0]!.signal).toBe(controller.signal);
        expect(submittedCalls).toBe(1);
        expect(submittedModel).toEqual({ modelConfigId: model.id, modelName: model.name });
        expect(result[0]!.sourceTaskId).toBe("task-1");
        expect(result[0]!.dataUrl).toBe("/api/assets/result-1/content");
        expect(result[0]).toMatchObject({ sourceModelConfigId: model.id, sourceModelName: model.name });
    });

    test("the saved requestId reaches the task POST and polling waits for onSubmitted persistence", async () => {
        globals.window = { location: { pathname: "/chat" } };
        const saved = Promise.withResolvers<void>();
        const submitted = Promise.withResolvers<string[]>();
        const taskPosts: Record<string, unknown>[] = [];
        const taskQueries: string[] = [];
        let submissionStarted = false;
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [model] });
            if (path === "/api/tasks" && init?.method === "POST") {
                expect(submissionStarted).toBe(true);
                taskPosts.push(JSON.parse(String(init.body)));
                return Response.json({ task: { id: "original-task" } });
            }
            if (path === "/api/tasks/original-task") {
                taskQueries.push(path);
                return Response.json({ task: { id: "original-task", requestId: "persisted-request:0", status: "success", resultUrls: ["/api/assets/original/content"], failureReason: null } });
            }
            if (path === "/api/auth/session") return Response.json({}, { status: 401 });
            throw new Error(`Unexpected request ${path}`);
        }) as typeof fetch;
        const result = requestQueuedImages({ ...baseInput, requestId: "persisted-request", onSubmissionStarted: () => { submissionStarted = true; }, onSubmitted: async (ids) => { submitted.resolve(ids); await saved.promise; } });
        expect(await submitted.promise).toEqual(["original-task"]);
        expect(taskPosts).toHaveLength(1);
        expect(taskPosts[0]!.requestId).toBe("persisted-request:0");
        expect(taskQueries).toEqual([]);
        saved.resolve();
        expect((await result)[0]!.sourceTaskId).toBe("original-task");
        expect(taskQueries).toEqual(["/api/tasks/original-task"]);
    });

    test("an accepted task whose onSubmitted save rejects propagates the error without another POST", async () => {
        globals.window = { location: { pathname: "/chat" } };
        const requests: string[] = [];
        let submissionStarted = false;
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            requests.push(`${init?.method || "GET"} ${path}`);
            if (path === "/api/models") return Response.json({ tools: [], prices: [], models: [model] });
            if (path === "/api/tasks" && init?.method === "POST") return Response.json({ task: { id: "accepted-task" } });
            if (path === "/api/auth/session") return Response.json({}, { status: 401 });
            throw new Error(`Unexpected request ${path}`);
        }) as typeof fetch;
        await expect(requestQueuedImages({ ...baseInput, requestId: "saved-root", onSubmissionStarted: () => { submissionStarted = true; }, onSubmitted: async (ids) => { expect(ids).toEqual(["accepted-task"]); throw new Error("local save failed"); } })).rejects.toThrow("local save failed");
        expect(submissionStarted).toBe(true);
        expect(requests).toEqual(["GET /api/models", "POST /api/tasks", "GET /api/auth/session"]);
    });
});
