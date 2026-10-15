import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SeamlessStitchPage } from "@/pages/image/seamless-stitch";
import { DEFAULT_SEAMLESS_STITCH_PARAMETERS, requestSeamlessStitch, SEAMLESS_PATTERN_PROMPT } from "@/services/api/internal-ai";
import type { BusinessConfig, PublicModel, PublicToolConfiguration } from "@/services/api/business-config";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { useUserStore } from "@/stores/use-user-store";

const originalFetch = globalThis.fetch;
const globals = globalThis as unknown as Record<string, unknown>;
const originalWindow = globals.window;
const originalUser = useUserStore.getState();
const originalBusiness = useBusinessConfigStore.getState();
const businessInitial = useBusinessConfigStore.getInitialState();
const originalInitialBusiness = { ...businessInitial };
const configInitial = useConfigStore.getInitialState();
const originalInitialConfig = configInitial.config;
const mark = (id: string, profile: "quality-resolution" | "resolution-1k"): PublicModel => ({ id, modelId: id, name: id, capabilities: ["generate", "edit"], imageParameterProfile: profile, creditCost: 0, rmbCost: 0 });
const flare = mark("mark-flare", "quality-resolution");
const sunburst = mark("mark-sunburst", "quality-resolution");
const nano = mark("mark-nano", "resolution-1k");
const internal: PublicModel = { id: "internal-stitch", modelId: "internal-seamless", name: "内部无缝工作流", capabilities: ["edit"], creditCost: 0, rmbCost: 0 };
const reference = { id: "source", name: "flower.png", dataUrl: "data:image/png;base64,aGVsbG8=" };
const binding = (modelConfigId: string | null, enabled = true): PublicToolConfiguration => ({ toolKey: "seamless-stitch", modelConfigId, enabled, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 });
const config = (model: string) => ({ ...defaultConfig, model, imageModel: model, quality: "max", size: "4:3", count: "7", imageOptions: '{"resolution":"4k","output_format":"webp","output_compression":"88","google_search":"true"}' });

beforeEach(() => {
    globals.window = { location: { pathname: "/image" } };
    useUserStore.setState({ user: { id: "employee-a", status: "active", role: "designer" } as never, status: "authenticated" });
});
afterEach(() => {
    globalThis.fetch = originalFetch;
    globals.window = originalWindow;
    useUserStore.setState(originalUser);
    useBusinessConfigStore.setState(originalBusiness);
    Object.assign(businessInitial, originalInitialBusiness);
    configInitial.config = originalInitialConfig;
});

function mockServer(models: PublicModel[], tools: PublicToolConfiguration[] = []) {
    const calls: Array<{ path: string; body?: Record<string, any> }> = [];
    const business: BusinessConfig = { models, tools, prices: [] };
    globalThis.fetch = (async (url, init) => {
        const path = String(url);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        calls.push({ path, body });
        if (path === "/api/models") return Response.json(business);
        if (path === "/api/assets/upload-request") return Response.json({ assetId: "source-asset", uploadUrl: null });
        if (path === "/api/tasks" && init?.method === "POST") return Response.json({ task: { id: "task-1", status: "queued" } });
        const task = { id: "task-1", status: "success", resultUrls: ["/api/assets/result/content"] };
        if (path === "/api/tasks/task-1") return Response.json({ task });
        if (path === "/api/tasks") return Response.json({ tasks: [task] });
        if (path === "/api/auth/session") return Response.json({ user: { id: "employee-a", status: "active", role: "designer" } });
        throw new Error(`Unexpected request ${path}`);
    }) as typeof fetch;
    return calls;
}

test.each([flare, sunburst])("$id sends independent Mark image parameters and a seamless-repeat prompt", async model => {
    const calls = mockServer([model]);
    const result = await requestSeamlessStitch(reference, DEFAULT_SEAMLESS_STITCH_PARAMETERS, config(model.id));
    const task = calls.find(call => call.path === "/api/tasks" && call.body)?.body;
    expect(task).toMatchObject({ operationType: "seamless_stitch", toolKey: "seamless-stitch", modelConfigId: model.id, prompt: SEAMLESS_PATTERN_PROMPT, parameters: { size: "4:3", quality: "max", resolution: "4k", output_format: "webp", output_compression: 88, count: 1 } });
    expect(task?.parameters.inputArchive.config.count).toBe("1");
    for (const key of ["cutWidth", "redrawWidth", "blurAmount", "redrawStrength", "steps", "google_search"]) expect(task?.parameters[key]).toBeUndefined();
    expect(calls.filter(call => call.path === "/api/models")).toHaveLength(1);
    expect(calls.filter(call => call.path === "/api/tasks" && call.body)).toHaveLength(1);
    expect(result).toMatchObject({ model, prompt: SEAMLESS_PATTERN_PROMPT, usesImageSettings: true });
});

test("Nano seamless stitching discards unsupported GPT and legacy workflow parameters", async () => {
    const calls = mockServer([nano]);
    await requestSeamlessStitch(reference, { ...DEFAULT_SEAMLESS_STITCH_PARAMETERS, steps: -1 }, { ...config(nano.id), quality: "2k" });
    const parameters = calls.find(call => call.path === "/api/tasks" && call.body)?.body?.parameters;
    expect(parameters).toMatchObject({ size: "4:3", resolution: "2k", count: 1 });
    for (const key of ["quality", "output_format", "output_compression", "background", "steps", "google_search"]) expect(parameters[key]).toBeUndefined();
});

test.each(["gpt", "grok-image"] as const)("new %s uses image controls and single-reference parameters, not internal workflow knobs", async kind => {
    const model: PublicModel = { ...flare, id: `mark-${kind}`, modelId: `mark-${kind}`, imageParameterProfile: kind, imageSupportsMask: false };
    const calls = mockServer([model]);
    const result = await requestSeamlessStitch(reference, { ...DEFAULT_SEAMLESS_STITCH_PARAMETERS, steps: -1 }, { ...config(model.id), quality: kind === "gpt" ? "2k" : "medium", imageOptions: '{"resolution":"2k"}' });
    const body = calls.find(call => call.path === "/api/tasks" && call.body)?.body;
    expect(result.usesImageSettings).toBe(true);
    expect(body.prompt).toBe(SEAMLESS_PATTERN_PROMPT);
    expect(body.parameters.resolution).toBe("2k");
    expect(body.parameters.quality).toBeUndefined();
    expect(body.parameters.steps).toBeUndefined();
    expect(body.parameters.n).toBe(1);
});

test("fresh backend binding wins and supplies the parameter profile before upload", async () => {
    const calls = mockServer([flare, nano], [binding(nano.id)]);
    useBusinessConfigStore.setState({ models: [flare] });
    const result = await requestSeamlessStitch(reference, DEFAULT_SEAMLESS_STITCH_PARAMETERS, config(flare.id));
    const task = calls.find(call => call.path === "/api/tasks" && call.body)?.body;
    expect(task).toMatchObject({ modelConfigId: nano.id, parameters: { size: "4:3", resolution: "1k" } });
    expect(task?.parameters.quality).toBeUndefined();
    expect(result.model.id).toBe(nano.id);
    expect(calls[0]?.path).toBe("/api/models");
});

test("internal workflow keeps its original prompt, parameters and validation", async () => {
    const calls = mockServer([internal], [binding(internal.id)]);
    await requestSeamlessStitch(reference, DEFAULT_SEAMLESS_STITCH_PARAMETERS, config(internal.id));
    const task = calls.find(call => call.path === "/api/tasks" && call.body)?.body;
    expect(task).toMatchObject({ modelConfigId: internal.id, prompt: "无缝拼接", parameters: { ...DEFAULT_SEAMLESS_STITCH_PARAMETERS, count: 1 } });
    expect(task?.parameters.size).toBeUndefined();
    expect(task?.parameters.inputArchive).toBeUndefined();
    const rejected = mockServer([internal]);
    await expect(requestSeamlessStitch(reference, { ...DEFAULT_SEAMLESS_STITCH_PARAMETERS, steps: 0 }, config(internal.id))).rejects.toThrow("步数");
    expect(rejected.map(call => call.path)).toEqual(["/api/models"]);
});

test("disabled binding and invalid Mark size reject before any reference upload", async () => {
    const disabled = mockServer([flare], [binding(flare.id, false)]);
    await expect(requestSeamlessStitch(reference, DEFAULT_SEAMLESS_STITCH_PARAMETERS, config(flare.id))).rejects.toThrow("已停用");
    expect(disabled.map(call => call.path)).toEqual(["/api/models"]);
    const invalid = mockServer([flare]);
    await expect(requestSeamlessStitch(reference, DEFAULT_SEAMLESS_STITCH_PARAMETERS, { ...config(flare.id), size: "512x512" })).rejects.toThrow();
    expect(invalid.map(call => call.path)).toEqual(["/api/models"]);
});

test.each([flare, sunburst, nano, internal])("$id renders the correct seamless controls without changing the existing workspace", model => {
    globals.window = originalWindow;
    const business = { models: [model], tools: [], prices: [], status: "ready" as const };
    useBusinessConfigStore.setState(business);
    Object.assign(businessInitial, business);
    configInitial.config = config(model.id);
    const html = renderToStaticMarkup(<MemoryRouter><App><SeamlessStitchPage /></App></MemoryRouter>);
    expect(html).toContain("处理模型");
    expect(html).toContain("输入图片");
    expect(html).toContain("历史出图");
    if (model.id === internal.id) {
        expect(html).toContain("花型预设");
        expect(html).toContain("切割宽度");
        expect(html).toContain("重绘强度");
    } else {
        expect(html).toContain('aria-label="清晰度 / 分辨率"');
        expect(html).not.toContain("花型预设");
        expect(html).not.toContain("切割宽度");
        expect(html).not.toContain("重绘强度");
        if (model.id === nano.id) {
            expect(html).not.toContain("图片质量");
            expect(html).not.toContain("0.5K");
        } else expect(html).toContain('aria-label="图片质量"');
    }
});
