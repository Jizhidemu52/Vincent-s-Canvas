import { afterEach, beforeEach, expect, test } from "bun:test";
import { optimizeImagePrompt, requestEdit, requestGeneration } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import { preparePromptTaskInput } from "../../server/src/prompt-task-input";
import type { PromptCompiler } from "../../server/src/prompt-compiler";
import { promptInputSchema, type PromptInputData } from "../../shared/prompt-contracts";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const originalUser = useUserStore.getState();
const model = { id: "image-model", modelId: "gpt-image-2", name: "Image", capabilities: ["generate", "edit", "upscale"], creditCost: 0, rmbCost: 0 };
const config = { ...defaultConfig, model: model.modelId, imageModel: model.modelId, imageOptions: '{"output_format":"png"}' };
const reference = { id: "source", name: "source.png", type: "image/png", dataUrl: "data:image/png;base64,YQ==", sourceAssetId: "source" };
const compilation = { id: "11111111-1111-4111-8111-111111111111", status: "success" as const, prompt: "Optimized blue dress", optimized: true };

beforeEach(() => {
    globalThis.window = { location: { pathname: "/image" }, setTimeout, clearTimeout } as Window & typeof globalThis;
    useUserStore.setState({ user: { id: "operation-test", status: "active", role: "designer" } as never, status: "authenticated", hydrateSession: async () => undefined });
    globalThis.fetch = (async () => { throw new Error("Unexpected unmocked transport"); }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; globalThis.window = originalWindow; useUserStore.setState(originalUser); });

function network() {
    const requests: Array<{ path: string; method: string; body?: any }> = [];
    let prepared: any;
    const compiler = { compile: async (_actor: unknown, input: any) => ({ ...compilation, requestId: input.requestId }) } as PromptCompiler;
    globalThis.fetch = (async (url, init) => {
        const path = String(url), method = init?.method || "GET", body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path, method, body });
        if (path === "/api/models") return Response.json({ models: [model], tools: [], prices: [] });
        if (path === "/api/assets/source") return Response.json({ asset: { id: "source", kind: "image", status: "ready" } });
        if (path === "/api/assets/source/content" && method === "HEAD") return new Response(null, { status: 200 });
        if (path === "/api/prompt-compilations") return Response.json({ compilation: { ...compilation, requestId: body.requestId } });
        if (path === "/api/tasks" && method === "POST") {
            // Exercise the production admission guard, not a test copy of its mode rules.
            prepared = await preparePromptTaskInput(compiler, { id: "operation-test", role: "designer" }, { ...body, promptInput: body.promptInput ? promptInputSchema.parse(body.promptInput) : undefined });
            return Response.json({ task: { id: "task", ...prepared, status: "waiting", resultUrls: [] } });
        }
        if (path === "/api/tasks/task") return Response.json({ task: { id: "task", ...prepared, status: "success", resultUrls: ["/api/assets/result/content"], failureReason: null } });
        throw new Error(`Unexpected mocked request ${method} ${path}`);
    }) as typeof fetch;
    return requests;
}

test.each([['image_generation', 'generate', 'image'], ['inpaint', 'edit', 'image-edit']] as const)("%s optimization and generation agree with server admission while retaining references", async (operationType, mode, tool) => {
    const requests = network();
    const input: PromptInputData = { scene: "free-optimize", mode, fields: {}, userText: "blue dress", referenceRoles: ["source.png"] };
    const compiled = await optimizeImagePrompt(config, input, [reference], { operationType, toolKey: tool });
    const promptInput = { ...input, compilationId: compiled.id };
    const options = { operationType, tool, promptInput };
    const result = operationType === "image_generation"
        ? await requestGeneration(config, compiled.prompt, options, [reference])
        : await requestEdit(config, compiled.prompt, [reference], undefined, options);
    const compilePost = requests.find(request => request.path === "/api/prompt-compilations")!.body;
    const taskPost = requests.find(request => request.path === "/api/tasks")!.body;
    expect(compilePost).toMatchObject({ toolKey: tool, modelConfigId: model.id, promptInput: { mode }, sourceUrls: ["/api/assets/source/content"] });
    expect(taskPost).toMatchObject({ toolKey: tool, operationType, modelConfigId: model.id, promptInput: { mode, compilationId: compiled.id }, sourceUrls: compilePost.sourceUrls });
    expect(result[0]).toMatchObject({ sourceTaskId: "task", prompt: compilation.prompt, optimized: true });
    expect(requests.filter(request => request.path === "/api/tasks" && request.method === "POST")).toHaveLength(1);
});

test("upscale rejects compilation before model lookup but keeps ordinary enhancement usable", async () => {
    const requests = network();
    await expect(optimizeImagePrompt(config, { scene: "free-optimize", mode: "edit" }, [reference], { operationType: "upscale", toolKey: "detail-enhance" })).rejects.toThrow("直接填写增强要求后生成");
    expect(requests).toEqual([]);
    await requestEdit(config, "Enhance fabric details", [reference], undefined, { operationType: "upscale", tool: "detail-enhance" });
    expect(requests.find(request => request.path === "/api/tasks")!.body).toMatchObject({ operationType: "upscale", toolKey: "detail-enhance" });
    expect(requests.find(request => request.path === "/api/tasks")!.body.promptInput).toBeUndefined();
    expect(requests.some(request => request.path === "/api/prompt-compilations")).toBe(false);
});

test("inconsistent explicit mode is rejected locally without weakening the server contract", async () => {
    const requests = network();
    await expect(optimizeImagePrompt(config, { scene: "free-optimize", mode: "edit" }, [reference], { operationType: "image_generation", toolKey: "image" })).rejects.toThrow("优化模式与实际生成操作不一致");
    expect(requests).toEqual([]);
    await expect(preparePromptTaskInput({} as PromptCompiler, { id: "operation-test", role: "designer" }, {
        requestId: "test-rejected", modelConfigId: model.id, operationType: "image_generation", toolKey: "image", prompt: "blue", parameters: {}, sourceUrls: ["/api/assets/source/content"], promptInput: promptInputSchema.parse({ scene: "free-optimize", mode: "edit" }),
    })).rejects.toMatchObject({ code: "PROMPT_OPERATION_INVALID" });
});
