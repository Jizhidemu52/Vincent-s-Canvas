import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyToolModel, requireToolKey, resolveConfiguredToolModel } from "../src/services/api/tool-runtime";
import { requestGeneration, requestEdit, requestImageQuestion, requestBatchEdit } from "../src/services/api/image";
import { createVideoGenerationTask, requestVideoGeneration } from "../src/services/api/video";
import { requestAudioGeneration } from "../src/services/api/audio";
import { createQueuedMediaTaskPayloads, submitQueuedMediaTask } from "../src/services/api/generation-tasks";
import { defaultConfig } from "../src/stores/use-config-store";
import { useUserStore } from "../src/stores/use-user-store";
import { useBusinessConfigStore } from "../src/stores/use-business-config-store";
import type { BusinessConfig, PublicToolConfiguration } from "../src/services/api/business-config";

const image = { id: "bound-image", modelId: "gpt-image-2", name: "绑定图片模型", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 };
const text = { id: "bound-text", modelId: "claude-fable-5-1", name: "绑定对话模型", capabilities: ["chat"], creditCost: 0, rmbCost: 0 };
const video = { id: "bound-video", modelId: "wan2.7", name: "绑定视频模型", capabilities: ["video"], creditCost: 0, rmbCost: 0 };
const audio = { id: "bound-audio", modelId: "gpt-4o-mini-tts", name: "绑定音频模型", capabilities: ["audio"], creditCost: 0, rmbCost: 0 };
const binding = (toolKey: string, modelConfigId: string | null, enabled = true): PublicToolConfiguration => ({ toolKey, modelConfigId, enabled, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 3 });
const business = (...tools: PublicToolConfiguration[]): BusinessConfig => ({ models: [image, text, video, audio], tools, prices: [] });
const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUser = useUserStore.getState();
const originalBusiness = useBusinessConfigStore.getState();

beforeEach(() => {
    globals.window = { location: { pathname: "/canvas/test-canvas" } };
    useUserStore.setState({ user: { id: "employee-a", status: "active", role: "designer" } as never, status: "authenticated" });
});
afterEach(() => { globalThis.fetch = originalFetch; globals.window = originalWindow; useUserStore.setState(originalUser); useBusinessConfigStore.setState(originalBusiness); });

function mockServer(config: BusinessConfig, taskError = false) {
    const requests: Array<{ path: string; body?: Record<string, any> }> = [];
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path, body });
        if (path === "/api/models") return Response.json(config);
        if (path === "/api/assets/upload-request") return Response.json({ assetId: "reference-1", uploadUrl: null });
        if (path === "/api/tasks/preflight") return Response.json({ ok: true, normalized: { seconds: 5 } });
        if (path === "/api/tasks" && init?.method === "POST") return taskError ? Response.json({ message: "板块模型已变化，请刷新后重试", code: "TOOL_MODEL_CHANGED" }, { status: 409 }) : Response.json({ task: { id: "task-1", status: "queued" } });
        if (path === "/api/tasks/batch") return Response.json({ batchId: "batch-1", tasks: [{ id: "task-1", itemIndex: 0 }], failures: [] });
        const task = { id: "task-1", status: "success", resultUrls: ["/api/assets/result/content"], failureReason: null };
        if (path === "/api/tasks/task-1") return Response.json({ task });
        if (path === "/api/tasks") return Response.json({ tasks: [task] });
        if (path === "/api/auth/session") return Response.json({}, { status: 401 });
        if (path === "/api/chat/responses") return Response.json({ content: "已完成", toolCalls: [] });
        if (path === "/api/assets/result/content") return new Response("audio bytes", { headers: { "content-type": "audio/mpeg" } });
        throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    return requests;
}

describe("formal tool model consumption", () => {
    test("a binding wins over the selected model without mutating the saved config", () => {
        const config = { ...defaultConfig, model: "nano-banana-2", imageModel: "nano-banana-2" };
        expect(applyToolModel(config, business(binding("canvas-image", image.id)), "canvas-image").model).toBe(image.modelId);
        expect(config.model).toBe("nano-banana-2");
    });

    test("unbound and absent bindings preserve the user's selected model, while disabled and broken bindings fail closed", () => {
        expect(resolveConfiguredToolModel(business(), "canvas-image", image.modelId)).toBe(image);
        expect(resolveConfiguredToolModel(business(binding("canvas-image", null)), "canvas-image", image.modelId)).toBe(image);
        expect(() => resolveConfiguredToolModel(business(binding("canvas-image", null, false)), "canvas-image", image.modelId)).toThrow("已停用");
        expect(() => resolveConfiguredToolModel(business(binding("canvas-image", "removed")), "canvas-image", image.modelId)).toThrow("绑定的模型暂不可用");
        expect(() => resolveConfiguredToolModel(business(binding("gpt-chat", text.id, false), binding("gpt-chat-image", image.id)), "gpt-chat-image", image.modelId)).toThrow("已停用");
    });

    test("only catalog keys and compatible operations are accepted", () => {
        expect(requireToolKey("image_generation", "image-generation")).toBe("image");
        expect(requireToolKey("inpaint", "agent-direct")).toBe("canvas-edit");
        expect(() => requireToolKey("image_generation", "canvas-chat")).toThrow("不匹配");
        expect(() => requireToolKey("inpaint", "invented-tool")).toThrow("不匹配");
    });

    test("generation binds before normalization and sends one immutable model snapshot plus first-class toolKey", async () => {
        const requests = mockServer(business(binding("creative-text-to-style", image.id)));
        await requestGeneration({ ...defaultConfig, model: "nano-banana-2", imageModel: "nano-banana-2", size: "3:4", quality: "low", count: "1" }, "连衣裙", { tool: "creative-text-to-style" });
        const post = requests.find(item => item.path === "/api/tasks" && item.body)?.body;
        expect(requests.filter(item => item.path === "/api/models")).toHaveLength(1);
        expect(post).toMatchObject({ toolKey: "creative-text-to-style", modelConfigId: image.id, operationType: "image_generation", parameters: { tool: "creative-text-to-style", size: "1152x1536", quality: "low" } });
        expect(post?.parameters.resolution).toBeUndefined();
    });

    test.each(["generation", "edit", "batch"].flatMap(operation => ["missing", "stale"].map(cache => ({ operation, cache }))))("$operation uses the fresh anonymous model profile with a $cache UI cache without replacing it", async ({ operation, cache }) => {
        const opaqueId = "9cb6ad6a-72eb-4af2-a864-b09b391ab803";
        const boundModel = { ...image, id: opaqueId, modelId: opaqueId, name: "出图模型2", modelIdentityHidden: true, imageParameterProfile: "standard-flex-plus" as const };
        const tool = operation === "generation" ? "canvas-image" : operation === "edit" ? "canvas-edit" : "canvas-batch";
        const staleModels = cache === "missing" ? [image] : [{ ...boundModel, imageParameterProfile: "standard" as const }];
        useBusinessConfigStore.setState({ models: staleModels });
        const requests = mockServer({ models: [boundModel], prices: [], tools: [binding(tool, opaqueId)] });
        const config = { ...defaultConfig, model: image.modelId, size: "3:4", quality: "xhigh", count: "1", imageOptions: JSON.stringify({ output_format: "webp", output_compression: "88" }) };
        if (operation === "generation") await requestGeneration(config, "flower", { tool });
        else if (operation === "edit") await requestEdit(config, "flower", [], undefined, { tool });
        else await requestBatchEdit(config, "flower", [{ file: new File(["source"], "source.png", { type: "image/png" }), title: "source" }]);
        const post = requests.find(item => item.path === (operation === "batch" ? "/api/tasks/batch" : "/api/tasks") && item.body)?.body;
        expect(post).toMatchObject({ modelConfigId: opaqueId, parameters: { size: "1152x1536", quality: "xhigh", output_format: "webp", output_compression: 88 } });
        if (operation !== "batch") expect(post?.parameters.inputArchive.config).toMatchObject({ size: "1152x1536", quality: "xhigh" });
        expect(requests.filter(item => item.path === "/api/models")).toHaveLength(1);
        expect(useBusinessConfigStore.getState().models).toBe(staleModels);
    });

    test.each(["generation", "edit"])("%s validates anonymous reference limits from the fresh model snapshot before reads or uploads", async operation => {
        const opaqueId = "c329da32-b3b8-4d5a-ae81-7c97a504ca4c";
        const tool = operation === "generation" ? "canvas-image" : "canvas-edit";
        useBusinessConfigStore.setState({ models: [image] });
        const boundModel = { ...image, id: opaqueId, modelId: opaqueId, name: "出图模型3", modelIdentityHidden: true, imageParameterProfile: "resolution" as const };
        const requests = mockServer({ models: [boundModel], prices: [], tools: [binding(tool, opaqueId)] });
        const references = Array.from({ length: 15 }, (_, index) => ({ id: String(index), name: "reference.png", dataUrl: "missing:reference" }));
        const result = operation === "generation" ? requestGeneration(defaultConfig, "flower", { tool }, references) : requestEdit(defaultConfig, "flower", references, undefined, { tool });
        await expect(result).rejects.toThrow("0 至 14");
        expect(requests.map(item => item.path)).toEqual(["/api/models"]);
    });

    test.each(["canvas-mask-edit", "canvas-angle", "gpt-chat-image"])("%s retains its independent edit provenance", async tool => {
        const requests = mockServer(business(binding(tool, image.id)));
        await requestEdit({ ...defaultConfig, model: image.modelId, count: "1" }, "改为蓝色", [], undefined, { tool });
        expect(requests.find(item => item.path === "/api/tasks" && item.body)?.body).toMatchObject({ toolKey: tool, operationType: "inpaint", parameters: { tool } });
    });

    test("disabled tools reject before reference reads or uploads", async () => {
        const requests = mockServer(business(binding("canvas-mask-edit", image.id, false)));
        await expect(requestEdit(defaultConfig, "change", [{ id: "ref", name: "ref.png", dataUrl: "missing:reference" }], undefined, { tool: "canvas-mask-edit" })).rejects.toThrow("已停用");
        expect(requests.map(item => item.path)).toEqual(["/api/models"]);
    });

    test("configuration changes are surfaced without retrying or swapping the normalized model", async () => {
        const requests = mockServer(business(binding("canvas-image", image.id)), true);
        await expect(requestGeneration(defaultConfig, "flower", { tool: "canvas-image" })).rejects.toThrow("模型已变化");
        expect(requests.filter(item => item.path === "/api/models")).toHaveLength(1);
        expect(requests.filter(item => item.path === "/api/tasks" && item.body)).toHaveLength(1);
        expect(requests.find(item => item.path === "/api/tasks" && item.body)?.body?.modelConfigId).toBe(image.id);
    });

    test("an employee change while resolving the binding never submits under the new identity", async () => {
        const requests: string[] = [];
        globalThis.fetch = (async url => {
            requests.push(String(url));
            useUserStore.setState({ user: { id: "employee-b", status: "active" } as never });
            return Response.json(business(binding("canvas-image", image.id)));
        }) as typeof fetch;
        await expect(requestGeneration(defaultConfig, "private draft", { tool: "canvas-image" })).rejects.toThrow("员工会话已变化");
        expect(requests).toEqual(["/api/models"]);
    });

    test.each(["gpt-chat", "canvas-chat"])("%s binds the actual chat request", async tool => {
        const requests = mockServer(business(binding(tool, text.id)));
        await requestImageQuestion({ ...defaultConfig, model: "gpt-6-astra" }, [{ role: "user", content: "描述服装" }], () => undefined, { tool });
        expect(requests.find(item => item.path === "/api/chat/responses")?.body).toMatchObject({ toolKey: tool, modelId: text.modelId });
    });

    test("batch images carry the independent canvas batch binding and metadata", async () => {
        const requests = mockServer(business(binding("canvas-batch", image.id)));
        await requestBatchEdit(defaultConfig, "换色", [{ file: new File(["source"], "source.png", { type: "image/png" }), title: "source" }]);
        expect(requests.find(item => item.path === "/api/tasks/batch")?.body).toMatchObject({ toolKey: "canvas-batch", modelConfigId: image.id, parameters: { tool: "canvas-batch" } });
        expect(requests.filter(item => item.path === "/api/models")).toHaveLength(1);
    });

    test("video preflight and task submission preserve the same canvas tool and model snapshot", async () => {
        const requests = mockServer(business(binding("canvas-video", "new-admin-binding")));
        await submitQueuedMediaTask({ modelId: video.modelId, resolvedModel: video, toolKey: "canvas-video", operationType: "video_generation", prompt: "move", parameters: { size: "9:16" } });
        const preflight = requests.find(item => item.path === "/api/tasks/preflight")?.body;
        const submitted = requests.find(item => item.path === "/api/tasks" && item.body)?.body;
        expect(preflight).toMatchObject({ toolKey: "canvas-video", modelConfigId: video.id });
        expect(submitted).toMatchObject({ toolKey: "canvas-video", modelConfigId: video.id, requestId: preflight?.requestId });
        expect(requests.some(item => item.path === "/api/models")).toBe(false);
        const [first, second] = createQueuedMediaTaskPayloads({ toolKey: "canvas-video", operationType: "video_generation", projectId: "canvas", modelConfigId: video.id, requestId: "stable", prompt: "move", sourceUrls: [] });
        expect(first).toEqual(second);
    });

    test.each(["video", "canvas-video"] as const)("%s resolves its video model before normalizing the preflight parameters", async toolKey => {
        const requests = mockServer(business(binding(toolKey, video.id)));
        await requestVideoGeneration({ ...defaultConfig, model: "not-a-video-model", videoModel: "not-a-video-model" }, "walk", [], [], [], { toolKey });
        expect(requests.filter(item => item.path === "/api/models")).toHaveLength(1);
        expect(requests.find(item => item.path === "/api/tasks/preflight")?.body).toMatchObject({ toolKey, modelConfigId: video.id });
        expect(requests.find(item => item.path === "/api/tasks" && item.body)?.body).toMatchObject({ toolKey, modelConfigId: video.id });
    });

    test("a newly created video task reports its effective bound model for recovery metadata", async () => {
        mockServer(business(binding("canvas-video", video.id)));
        const task = await createVideoGenerationTask({ ...defaultConfig, model: "old-selected-model" }, "walk", [], [], [], { toolKey: "canvas-video" });
        expect(task).toEqual({ id: "task-1", provider: "server", model: video.modelId });
    });

    test("canvas audio resolves its own binding exactly once and returns the result bytes", async () => {
        const requests = mockServer(business(binding("canvas-audio", audio.id)));
        const result = await requestAudioGeneration({ ...defaultConfig, model: "not-an-audio-model" }, "介绍新系列");
        expect(requests.filter(item => item.path === "/api/models")).toHaveLength(1);
        expect(requests.find(item => item.path === "/api/tasks" && item.body)?.body).toMatchObject({ toolKey: "canvas-audio", modelConfigId: audio.id, parameters: { tool: "canvas-audio", voice: "alloy" } });
        expect(result.type).toBe("audio/mpeg");
    });
});
