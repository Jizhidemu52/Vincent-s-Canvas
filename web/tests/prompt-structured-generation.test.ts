import { afterEach, beforeEach, expect, test } from "bun:test";
import { createImageTaskRequests, requestQueuedImages, requestQueuedImageBatch, QueuedTaskHttpError, QueuedTaskSubmissionUncertainError } from "../src/services/api/generation-tasks";
import { generationDraftInput } from "../src/services/api/generation-history";
import { defaultConfig } from "../src/stores/use-config-store";
import { useUserStore } from "../src/stores/use-user-store";
import { createCanvasDesignTemplate, canvasDesignTemplates } from "../src/lib/canvas/canvas-design-templates";
import { createImageSequence, defaultImageSequenceSteps, imageSequenceStepTypes } from "../src/lib/canvas/canvas-image-sequence";
import { CanvasNodeType } from "../src/types/canvas";

const originalFetch = globalThis.fetch;
const previousUser = useUserStore.getState();
const previousWindow = (globalThis as any).window;
const model = { id: "model-config", modelId: "gpt-image-2", name: "GPT Image", capabilities: ["generate", "edit"], creditCost: 1, rmbCost: 1 };
const promptInput = { scene: "local-restyle" as const, fields: { restyleArea: "领口", change: "荷叶领", preserve: "袖口不变" }, userText: "荷叶领", mode: "edit" as const, referenceRoles: ["服装主图"], hasMask: true, maskReferenceIndex: 1 };
const task = { id: "task-original", requestId: "client-original:0", prompt: "Final server optimized prompt", userInput: promptInput, optimized: true, status: "success", resultUrls: ["/api/assets/result/content"], failureReason: null,
    queuedAt: "2026-11-10T07:50:48.000Z", completedAt: "2026-11-10T07:59:32.500Z" };
beforeEach(() => { useUserStore.setState({ user: { id: "employee-a", role: "designer", status: "active" } as never, status: "authenticated", hydrateSession: async () => {} }); (globalThis as any).window = { location: { pathname: "/image" } }; });
afterEach(() => { globalThis.fetch = originalFetch; useUserStore.setState(previousUser); (globalThis as any).window = previousWindow; });

test("structured input is a task sibling; mask remains last and source order is unchanged", () => {
    const [request] = createImageTaskRequests({ requestId: "client-original", projectId: "image-workbench", operationType: "inpaint", toolKey: "creative-local-restyle", modelConfigId: model.id, prompt: "荷叶领", promptInput, sourceUrls: ["main", "mask"], count: 5, parameters: { mask: true } });
    expect(request?.promptInput).toEqual(promptInput);
    expect(request?.sourceUrls).toEqual(["main", "mask"]);
    expect(request?.parameters).not.toHaveProperty("promptInput");
    expect(request?.parameters.n).toBe(1);
});

test("task compilation is server-side and final result prompt is canonical", async () => {
    const events: string[] = [];
    let payload: any;
    globalThis.fetch = (async (url, init) => {
        if (String(url) === "/api/tasks") { events.push("post"); payload = JSON.parse(String(init?.body)); return Response.json({ task }); }
        if (String(url) === "/api/tasks/task-original") return Response.json({ task });
        throw new Error(`Unexpected ${url}`);
    }) as typeof fetch;
    const result = await requestQueuedImages({ resolvedModel: model, modelId: model.modelId, prompt: "荷叶领", promptInput, count: 1, operationType: "inpaint", tool: "creative-local-restyle", requestId: "client-original", draft: generationDraftInput({ ...defaultConfig, systemPrompt: "PRIVATE_RECIPE_MUST_NOT_ARCHIVE" }, "荷叶领"),
        onOptimizing: () => { events.push("optimizing"); }, onCompiled: prompt => { expect(prompt).toBe(task.prompt); events.push("compiled"); }, onSubmitted: () => { events.push("accepted"); } });
    expect(events).toEqual(["optimizing", "post", "compiled", "accepted"]);
    expect(payload.promptInput).toEqual(promptInput);
    expect(payload.parameters.inputArchive.prompt).toBe("荷叶领");
    expect(payload.parameters.inputArchive.userInput).toEqual(promptInput);
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_RECIPE");
    expect(result[0]).toMatchObject({ sourceTaskId: task.id, prompt: task.prompt, optimized: true, durationMs: 524500 });
});

for (const compilationStatus of ["success", "failed"]) test(`an existing task takes precedence over a ${compilationStatus} compilation after a lost POST`, async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        if (String(url) === "/api/tasks") throw new TypeError("lost accepted response");
        if (String(url).startsWith("/api/prompt-compilations/")) return Response.json({ compilation: { id: "original-compilation", requestId: task.requestId, status: compilationStatus, prompt: task.prompt, optimized: compilationStatus === "success" } });
        return Response.json({ task });
    }) as typeof fetch;
    const result = await requestQueuedImages({ resolvedModel: model, modelId: model.modelId, prompt: "荷叶领", promptInput, count: 1, operationType: "inpaint", tool: "creative-local-restyle", requestId: "client-original" });
    expect(result[0]?.sourceTaskId).toBe(task.id);
    expect(calls.filter(call => call.startsWith("POST"))).toEqual(["POST /api/tasks"]);
    expect(calls).toContain("GET /api/tasks/by-request/client-original%3A0");
    expect(calls.some(call => call.includes("/api/prompt-compilations/"))).toBe(false);
});

test("HTTP 409 optimizing is not a definitive rejection and retains the original request", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url, init) => {
        calls.push(`${init?.method || "GET"} ${url}`);
        if (String(url) === "/api/tasks") return Response.json({ error: "PROMPT_OPTIMIZING", message: "still compiling" }, { status: 409 });
        if (String(url).startsWith("/api/prompt-compilations")) return Response.json({ compilation: { status: "optimizing" } });
        return new Response(null, { status: 404 });
    }) as typeof fetch;
    await expect(requestQueuedImages({ resolvedModel: model, modelId: model.modelId, prompt: "荷叶领", promptInput, count: 1, operationType: "inpaint", tool: "creative-local-restyle", requestId: "client-original" })).rejects.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
    expect(calls.filter(call => call.startsWith("POST"))).toHaveLength(1);
    expect(calls).toContain("GET /api/prompt-compilations/by-request/client-original%3A0");
});

test("a lost POST acknowledgement adopts a confirmed failed compilation without resubmitting", async () => {
    const calls: string[] = [];
    let submitted = false;
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        calls.push(`${init?.method || "GET"} ${path}`);
        if (path === "/api/tasks") {
            expect(JSON.parse(String(init?.body)).requestId).toBe("client-original:0");
            throw new TypeError("lost response");
        }
        if (path === "/api/tasks/by-request/client-original%3A0") return new Response(null, { status: 404 });
        if (path === "/api/prompt-compilations/by-request/client-original%3A0") return Response.json({ compilation: {
            id: "failed-compilation", requestId: "client-original:0", status: "failed", errorCode: "PROMPT_OUTPUT_REJECTED", message: "优化结果未通过检查，尚未提交图片生成。", optimized: false,
        } });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    const error = await requestQueuedImages({ resolvedModel: model, modelId: model.modelId, prompt: "荷叶领", promptInput, count: 1, operationType: "inpaint", tool: "creative-local-restyle", requestId: "client-original", onSubmitted: () => { submitted = true; } }).catch(error => error);
    expect(error).toBeInstanceOf(QueuedTaskHttpError);
    expect(error).toMatchObject({ submissionRejected: true, requestId: "client-original:0", code: "PROMPT_OUTPUT_REJECTED" });
    expect(error.message).toContain("尚未提交图片生成");
    expect(submitted).toBe(false);
    expect(calls.filter(call => call.startsWith("POST"))).toEqual(["POST /api/tasks"]);
});

for (const unresolved of ["task-read-failed", "task-response-invalid", "foreign-compilation", "compilation-optimizing", "compilation-uncertain", "compilation-success", "compilation-missing", "compilation-read-failed"]) {
    test(`${unresolved} cannot turn a lost acknowledgement into permission to submit again`, async () => {
        const calls: string[] = [];
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            calls.push(`${init?.method || "GET"} ${path}`);
            if (path === "/api/tasks") throw new TypeError("lost response");
            if (path === "/api/tasks/by-request/client-original%3A0") {
                if (unresolved === "task-read-failed") return Response.json({ message: "snapshot unavailable" }, { status: 503 });
                if (unresolved === "task-response-invalid") return Response.json({});
                return new Response(null, { status: 404 });
            }
            if (path === "/api/prompt-compilations/by-request/client-original%3A0") {
                if (unresolved === "compilation-missing") return new Response(null, { status: 404 });
                if (unresolved === "compilation-read-failed") return Response.json({ message: "compilation unavailable" }, { status: 503 });
                return Response.json({ compilation: { id: "original-compilation", requestId: unresolved === "foreign-compilation" ? "another-request:0" : "client-original:0",
                    status: unresolved.startsWith("compilation-") ? unresolved.slice("compilation-".length) : "failed", message: "original compilation result", optimized: false } });
            }
            throw new Error(`Unexpected ${path}`);
        }) as typeof fetch;
        const error = await requestQueuedImages({ resolvedModel: model, modelId: model.modelId, prompt: "荷叶领", promptInput, count: 1, operationType: "inpaint", tool: "creative-local-restyle", requestId: "client-original" }).catch(error => error);
        expect(error).toBeInstanceOf(QueuedTaskSubmissionUncertainError);
        expect(error).toMatchObject({ requestId: "client-original:0" });
        expect(error.submissionRejected).not.toBe(true);
        expect(calls.filter(call => call.startsWith("POST"))).toEqual(["POST /api/tasks"]);
    });
}

test("batch transports one common compilation input, never one per item", async () => {
    let uploads = 0, posts = 0, optimizing = 0, payload: any;
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        if (path === "/api/assets/upload-request") return Response.json({ assetId: `upload-${++uploads}`, uploadUrl: null });
        if (/^\/api\/assets\/upload-\d+\/content$/.test(path) && init?.method === "HEAD") return new Response(null, { status: 200 });
        if (path === "/api/tasks/batch") { posts++; payload = JSON.parse(String(init?.body)); return Response.json({ batchId: "batch-id", tasks: [{ id: "batch-0", itemIndex: 0 }, { id: "batch-1", itemIndex: 1 }], failures: [], prompt: "Batch final prompt", optimized: true }); }
        if (path.startsWith("/api/tasks?")) return Response.json({ tasks: [0, 1].map(index => ({ ...task, id: `batch-${index}`, prompt: "Batch final prompt" })) });
        throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;
    const result = await requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "换蓝色", promptInput: { scene: "batch-optimize", userText: "换蓝色", mode: "edit" }, files: [0, 1].map(index => ({ title: `${index}.png`, file: new File([String(index)], `${index}.png`, { type: "image/png" }) })), onOptimizing: () => { optimizing++; } });
    expect(posts).toBe(1); expect(optimizing).toBe(1);
    expect(payload.promptInput.scene).toBe("batch-optimize");
    expect(payload.items).toEqual([{ sourceUrls: ["/api/assets/upload-1/content"] }, { sourceUrls: ["/api/assets/upload-2/content"] }]);
    expect(result.tasks).toHaveLength(2);
});

test("a partially enqueued recovered batch remains uncertain instead of discarding unfinished bindings", async () => {
    let posts = 0, submitted = false;
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        if (path === "/api/assets/upload-request") return Response.json({ assetId: "source", uploadUrl: null });
        if (path === "/api/tasks/batch") { posts++; throw new TypeError("lost response"); }
        if (path.startsWith("/api/tasks/batches/by-request/")) return Response.json({ batchId: "partial-batch", tasks: [{ ...task, itemIndex: 0 }], failures: [], submissionComplete: false, totalItems: 2 });
        if (path.startsWith("/api/prompt-compilations/")) return Response.json({ compilation: { status: "success", prompt: "shared" } });
        return Response.json({ task });
    }) as typeof fetch;
    await expect(requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "blue", files: [0, 1].map(index => ({ title: String(index), file: new File([String(index)], `${index}.png`, { type: "image/png" }) })), onSubmitted: () => { submitted = true; } })).rejects.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
    expect(posts).toBe(1); expect(submitted).toBe(false);
});

for (const observed of ["failed-before-admission", "batch-read-failed", "task-read-failed", "existing-item", "foreign-compilation", "optimizing"]) {
    test(`batch lost acknowledgement ${observed} preserves authoritative admission boundaries`, async () => {
        let requestId = "", posts = 0, submitted = false;
        globalThis.fetch = (async (url, init) => {
            const path = String(url);
            if (path === "/api/assets/upload-request") return Response.json({ assetId: "source", uploadUrl: null });
            if (path === "/api/assets/source/content" && init?.method === "HEAD") return new Response(null, { status: 200 });
            if (path === "/api/tasks/batch") { requestId = JSON.parse(String(init?.body)).requestId; posts++; throw new TypeError("lost response"); }
            if (path.startsWith("/api/tasks/batches/by-request/")) return observed === "batch-read-failed" ? new Response(null, { status: 503 }) : new Response(null, { status: 404 });
            if (path.startsWith("/api/tasks/by-request/")) return observed === "task-read-failed" ? new Response(null, { status: 503 }) : observed === "existing-item" ? Response.json({ task: { ...task, requestId: `${requestId}:0` } }) : new Response(null, { status: 404 });
            if (path.startsWith("/api/prompt-compilations/")) return Response.json({ compilation: { id: "batch-compilation", requestId: observed === "foreign-compilation" ? "wrong-request" : requestId, status: observed === "optimizing" ? "optimizing" : "failed", errorCode: "PROMPT_OUTPUT_REJECTED", message: "提示词准备失败，尚未提交图片生成。" } });
            throw new Error(`Unexpected ${path}`);
        }) as typeof fetch;
        const error = await requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "blue", promptInput: { scene: "batch-optimize", userText: "blue", mode: "edit" }, files: [{ title: "a", file: new File(["a"], "a.png", { type: "image/png" }) }], onSubmitted: () => { submitted = true; } }).catch(error => error);
        expect(error).toBeInstanceOf(observed === "failed-before-admission" ? QueuedTaskHttpError : QueuedTaskSubmissionUncertainError);
        expect(error.submissionRejected === true).toBe(observed === "failed-before-admission");
        expect(posts).toBe(1);
        expect(submitted).toBe(false);
    });
}

test("templates keep three parallel branches and attach only structured public recipe fields", () => {
    const source = { id: "source", type: CanvasNodeType.Image, title: "服装", position: { x: 0, y: 0 }, width: 100, height: 100, metadata: { content: "/source.png", status: "success" as const } };
    for (const template of canvasDesignTemplates) {
        let id = 0;
        const graph = createCanvasDesignTemplate(template.id, source, { x: 200, y: 0 }, model.id, () => `node-${++id}`);
        expect(graph.nodes).toHaveLength(3);
        expect(graph.connections).toHaveLength(3);
        expect(graph.connections.every(edge => edge.fromNodeId === source.id && !edge.kind)).toBe(true);
        expect(graph.nodes.every(node => node.metadata?.promptInput && !node.metadata?.systemPrompt)).toBe(true);
        expect(graph.nodes.every(node => node.metadata!.prompt!.length < 40)).toBe(true);
    }
    const sequence = createImageSequence(source, defaultImageSequenceSteps, { x: 200, y: 0 }, model.id);
    expect(sequence.nodes.map(node => node.metadata?.promptInput?.fields?.step_type)).toEqual(["white_bg", "recolor", "on_model"]);
    expect(imageSequenceStepTypes.map(item => item.value)).toEqual(["white_bg", "recolor", "on_model", "detail_shot", "scene", "custom"]);
});
