import { afterEach, beforeEach, expect, test } from "bun:test";
import { requestBatchEdit, requestEdit, requestGeneration } from "@/services/api/image";
import { defaultConfig } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { PublicModel } from "@/services/api/business-config";

const models: PublicModel[] = [
    { id: "blend", modelId: "blend", name: "aplmart-mj-blend", imageParameterProfile: "midjourney-blend", imageSupportsMask: false, capabilities: ["generate"], creditCost: 0, rmbCost: 0 },
    { id: "grok", modelId: "grok", name: "aplmart-grok2", imageParameterProfile: "grok-image", imageSupportsMask: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "gpt2", modelId: "gpt2", name: "aplmart-gpt2", imageParameterProfile: "gpt", imageSupportsMask: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "nano2", modelId: "nano2", name: "aplmart-nano2", imageParameterProfile: "resolution", imageSupportsMask: false, imageSupportsOfficialFallback: false, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "open", modelId: "gpt-image-2.5-flare", name: "OpenToken", imageParameterProfile: "standard-flex-plus", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
];
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const references = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `ref-${index}`, name: `ref-${index}.png`, type: "image/png", dataUrl: png }));
const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUser = useUserStore.getState();
const originalBusiness = useBusinessConfigStore.getState();
let requests: Array<{ path: string; body?: Record<string, any> }>;
beforeEach(() => {
    requests = [];
    globals.window = { location: { pathname: "/canvas/aplmart-request-test" } };
    useUserStore.setState({ user: { id: "qa-user", status: "active", role: "designer" } as never, status: "authenticated" });
    // Empty UI cache: request profile and mask policy must come from the fresh server snapshot.
    useBusinessConfigStore.setState({ models: [], tools: [] });
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        requests.push({ path, body });
        if (path === "/api/models") return Response.json({ models, tools: [], prices: [] });
        if (path === "/api/assets/upload-request") return Response.json({ assetId: "reference", uploadUrl: null });
        if (path === "/api/tasks" && init?.method === "POST") return Response.json({ task: { id: "task-1", status: "queued" } });
        if (path === "/api/tasks/task-1") return Response.json({ task: { id: "task-1", status: "success", resultUrls: ["/api/assets/result/content"] } });
        if (path === "/api/tasks") return Response.json({ tasks: [{ id: "task-1", status: "success", resultUrls: ["/api/assets/result/content"] }] });
        if (path === "/api/auth/session") return Response.json({ user: { id: "qa-user", status: "active", role: "designer" } });
        throw new Error(`Unexpected request: ${path}`);
    }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; globals.window = originalWindow; useUserStore.setState(originalUser); useBusinessConfigStore.setState(originalBusiness); });
const posts = () => requests.filter(item => item.path === "/api/tasks" && item.body);

test.each([2, 4])("Blend %i references submits one canvas generation with no old or system prompt", async count => {
    await requestGeneration({ ...defaultConfig, model: "blend", size: "7:5", quality: "turbo", count: "9", systemPrompt: "old system instruction", imageOptions: '{"dimensions":"LANDSCAPE","nsfw_check":"false"}' }, "old draft prompt", { tool: "canvas-image" }, references(count));
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.body).toMatchObject({ toolKey: "canvas-image", operationType: "image_generation", modelConfigId: "blend", prompt: "", sourceUrls: Array(count).fill("/api/assets/reference/content"), parameters: { size: "7:5", midjourneySpeed: "turbo", dimensions: "LANDSCAPE", nsfw_check: false, inputArchive: { prompt: "", effectivePrompt: "", config: { count: "1" } } } });
});

test.each([0, 1, 5])("Blend rejects %i references before any upload", async count => {
    await expect(requestGeneration({ ...defaultConfig, model: "blend" }, "", { tool: "canvas-image" }, references(count))).rejects.toThrow("2 至 4");
    expect(requests.map(item => item.path)).toEqual(["/api/models"]);
});

test.each([0, 1, 3])("Grok %i reference mode serializes quality only for text-to-image and always one task", async count => {
    const config = { ...defaultConfig, model: "grok", quality: "low", size: "19.5:9", count: "8", systemPrompt: "", imageOptions: '{"resolution":"2k","nsfw_check":"false","output_format":"webp","background":"transparent"}' };
    if (count) await requestEdit(config, "改为蓝色", references(count), undefined, { tool: "canvas-edit" });
    else await requestGeneration(config, "蓝色花瓶", { tool: "canvas-image" });
    expect(posts()).toHaveLength(1);
    const parameters = posts()[0]!.body!.parameters;
    expect(parameters).toMatchObject({ size: "19.5:9", resolution: "2k", nsfw_check: false });
    expect(parameters.quality).toBe(count ? undefined : "low");
    expect(parameters.inputArchive.parameters.quality).toBe(count ? undefined : "low");
    expect(parameters.output_format).toBeUndefined(); expect(parameters.background).toBeUndefined();
});

test("Grok prompt, image count, MIME and known byte limits reject before uploads", async () => {
    const config = { ...defaultConfig, model: "grok", systemPrompt: "" };
    for (const [prompt, refs] of [["", []], ["a".repeat(8001), []], ["edit", references(4)], ["edit", [{ ...references(1)[0]!, type: "image/gif" }]], ["edit", [{ ...references(1)[0]!, bytes: 10 * 1024 * 1024 + 1 }]]] as const) {
        requests = [];
        await expect(requestGeneration(config, prompt, { tool: "canvas-image" }, [...refs])).rejects.toThrow();
        expect(requests.map(item => item.path)).toEqual(["/api/models"]);
    }
});

test.each(["gpt2", "grok", "nano2"])("%s rejects mask using fresh public capability before uploading", async model => {
    await expect(requestEdit({ ...defaultConfig, model }, "edit", references(1), references(1)[0], { tool: "canvas-mask-edit" })).rejects.toThrow("不支持蒙版");
    expect(requests.map(item => item.path)).toEqual(["/api/models"]);
});

test.each(["0.5k", "1k", "2k", "4k"])("Nano2 Official %s uses fresh public capabilities and strips stale quality/fallback options", async resolution => {
    await requestGeneration({ ...defaultConfig, model: "nano2", size: "3:4", quality: resolution, count: "9", imageOptions: '{"official_fallback":"true","quality":"high","output_format":"webp"}' }, "blue cardigan", { tool: "canvas-image" }, references(1));
    expect(posts()).toHaveLength(1);
    const payload = posts()[0]!.body!;
    expect(payload.modelConfigId).toBe("nano2");
    expect(payload.parameters).toMatchObject({ size: "3:4", resolution, count: 1 });
    for (const key of ["quality", "official_fallback", "output_format"]) {
        expect(payload.parameters[key]).toBeUndefined();
        expect(payload.parameters.inputArchive.parameters[key]).toBeUndefined();
    }
});

test("Nano2 rejects its reference count, MIME and per-image byte boundaries before any upload", async () => {
    for (const refs of [references(15), [{ ...references(1)[0]!, type: "image/gif" }], [{ ...references(1)[0]!, bytes: 10 * 1024 * 1024 + 1 }]]) {
        requests = [];
        await expect(requestGeneration({ ...defaultConfig, model: "nano2" }, "edit cardigan", { tool: "canvas-image" }, refs)).rejects.toThrow();
        expect(requests.map(item => item.path)).toEqual(["/api/models"]);
    }
});

test("OpenToken ignores historical output counts while allowing consecutive independent submissions", async () => {
    const config = { ...defaultConfig, model: "gpt-image-2.5-flare", count: "10" };
    await requestGeneration(config, "first", { tool: "canvas-image" });
    expect(posts()).toHaveLength(1);
    await requestGeneration(config, "second", { tool: "canvas-image" });
    expect(posts()).toHaveLength(2);
    expect(posts().map(item => item.body!.prompt)).toEqual(["first", "second"]);
});

test("batch refuses multiple inputs before configuration reads and file uploads", async () => {
    const files = [1, 2].map(index => ({ file: new File(["x"], `${index}.png`, { type: "image/png" }), title: String(index) }));
    await expect(requestBatchEdit({ ...defaultConfig, model: "grok" }, "edit", files)).rejects.toThrow("只能处理 1 张");
    expect(requests).toHaveLength(0);
});
