import { afterEach, beforeEach, expect, test } from "bun:test";
import { deploymentFeatures } from "@/lib/deployment-features";
import { stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";
import { requestQueuedImageBatch, QueuedTaskSubmissionUncertainError } from "@/services/api/generation-tasks";
import { requestBatchEdit } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const originalFetch = globalThis.fetch, originalUser = useUserStore.getState(), originalFeatures = { ...deploymentFeatures };
const globals = globalThis as unknown as Record<string, unknown>, originalWindow = globals.window;
const model = { id: "model-config", modelId: "gpt-image-2", name: "GPT Image", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const files = () => [{ file: new File(["png"], "one.png", { type: "image/png" }), title: "one" }];
let calls: Array<{ path: string; method: string; body: any }>;
beforeEach(() => {
    calls = [];
    globals.window = { location: { pathname: "/canvas/current-later-project" }, setTimeout, clearTimeout };
    Object.assign(deploymentFeatures, { authenticationEnabled: true, oaLoginEnabled: true, creditsEnabled: false });
    useUserStore.setState({ user: { id: "owner", role: "designer", status: "active" } as never, status: "authenticated", hydrateSession: async () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; globals.window = originalWindow; useUserStore.setState(originalUser); Object.assign(deploymentFeatures, originalFeatures); });

function network(override?: (path: string, init?: RequestInit) => Response | undefined | Promise<Response | undefined>) {
    globalThis.fetch = (async (input, init) => {
        const path = String(input);
        calls.push({ path, method: init?.method || "GET", body: init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null });
        const custom = await override?.(path, init); if (custom) return custom;
        if (path === "/api/models") return Response.json({ models: [model], tools: [], prices: [] });
        if (path === "/api/assets/upload-request") return Response.json({ assetId: "source", uploadUrl: null });
        if (path === "/api/assets/source/content") return new Response(null, { status: 200 });
        if (path === "/api/tasks/batch") return Response.json({ batchId: "batch", prompt: "compiled", tasks: [{ id: "task", itemIndex: 0 }], failures: [] });
        if (path === "/api/tasks/task") return Response.json({ task: { id: "task", requestId: "request:0", status: "success", resultUrls: ["result"], failureReason: null } });
        if (path.endsWith("/cancel")) return Response.json({ changed: 1 });
        if (path.startsWith("/api/tasks/batches/by-request/") || path.startsWith("/api/tasks/by-request/") || path.startsWith("/api/prompt-compilations/")) return new Response(null, { status: 404 });
        throw new Error("Unexpected request " + path);
    }) as typeof fetch;
}

test.each(["queue", "image-adapter"] as const)("observation-only abort through %s keeps accepted batch alive and freezes its project", async entry => {
    network();
    const controller = new AbortController();
    const options = { signal: controller.signal, cancelOnAbort: () => false, projectId: "original-project", onSubmitted: () => stopCanvasObservation(controller) };
    const run = entry === "queue"
        ? requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "edit", files: files(), ...options })
        : requestBatchEdit({ ...defaultConfig, model: model.modelId, imageModel: model.modelId }, "edit", files(), options);
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.filter(call => call.path.endsWith("/cancel"))).toEqual([]);
    const posts = calls.filter(call => call.path === "/api/tasks/batch");
    expect(posts).toHaveLength(1);
    expect(posts[0].body.projectId).toBe("original-project");
});

test("default explicit abort retains the existing server batch cancellation behavior", async () => {
    network();
    const controller = new AbortController();
    await expect(requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "edit", files: files(), signal: controller.signal,
        onSubmitted: () => controller.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.filter(call => call.path.endsWith("/cancel")).map(call => call.path)).toEqual(["/api/tasks/batches/batch/cancel"]);
});

test("batch adapter waits for persistence, compilation, submission and progress callbacks before completion", async () => {
    network();
    const order: string[] = [];
    const gate = (name: string) => {
        const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
        return { entered, release, callback: async () => { entered.resolve(); await release.promise; order.push(name); } };
    };
    const compiled = gate("compiled"), submitted = gate("submitted"), progress = gate("progress");
    let completed = false;
    const run = requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "edit", files: files(), projectId: "original-project",
        onSubmissionStarted: async () => { order.push("persisted"); }, onCompiled: compiled.callback, onSubmitted: submitted.callback, onProgress: progress.callback }).then(result => { completed = true; order.push("complete"); return result; });
    await compiled.entered.promise;
    expect(order).toEqual(["persisted"]); expect(completed).toBe(false);
    expect(calls.some(call => call.path === "/api/tasks/task")).toBe(false);
    compiled.release.resolve(); await submitted.entered.promise;
    expect(order).toEqual(["persisted", "compiled"]); expect(completed).toBe(false);
    submitted.release.resolve(); await progress.entered.promise;
    expect(order).toEqual(["persisted", "compiled", "submitted"]); expect(completed).toBe(false);
    progress.release.resolve(); await run;
    expect(order).toEqual(["persisted", "compiled", "submitted", "progress", "complete"]);
});

test.each(["compiled", "submitted"] as const)("rejected %s callback after server acceptance keeps the original request uncertain", async callback => {
    network();
    let original = "";
    const reject = async () => { throw new Error("local persistence unavailable"); };
    const error = await requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "edit", files: files(),
        onSubmissionStarted: requestId => { original = requestId; }, ...(callback === "compiled" ? { onCompiled: reject } : { onSubmitted: reject }) }).catch(value => value);
    expect(error).toBeInstanceOf(QueuedTaskSubmissionUncertainError);
    expect(error.requestId).toBe(original);
    expect(calls.filter(call => call.path === "/api/tasks/batch")).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith("/cancel"))).toEqual([]);
});

test("observation revocation during awaited progress stops without a cancellation or new POST", async () => {
    network();
    const controller = new AbortController();
    await expect(requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "edit", files: files(), signal: controller.signal,
        cancelOnAbort: () => false, onProgress: async () => { await Promise.resolve(); stopCanvasObservation(controller); controller.signal.throwIfAborted(); } })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.filter(call => call.path === "/api/tasks/batch")).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith("/cancel"))).toEqual([]);
});

test("unknown batch submission reconciles only the original request and never repeats POST", async () => {
    let original = "";
    network(async path => { if (path === "/api/tasks/batch") throw new TypeError("accepted response lost"); });
    await expect(requestQueuedImageBatch({ resolvedModel: model, modelId: model.modelId, prompt: "edit", files: files(),
        onSubmissionStarted: requestId => { original = requestId; } })).rejects.toBeInstanceOf(QueuedTaskSubmissionUncertainError);
    expect(original).not.toBe("");
    expect(calls.filter(call => call.path === "/api/tasks/batch")).toHaveLength(1);
    expect(calls.some(call => call.path === "/api/tasks/batches/by-request/" + encodeURIComponent(original))).toBe(true);
    expect(calls.filter(call => call.path.endsWith("/cancel"))).toEqual([]);
});
