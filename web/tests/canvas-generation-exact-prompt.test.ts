import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import { defaultConfig } from "@/stores/use-config-store";

function api(resolvedModelId = "gpt-image-2") {
    const url = new URL("../src/services/api/image.ts", import.meta.url), requireModule = createRequire(url);
    const code = ts.transpileModule(readFileSync(url, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const requests: any[] = [], resolutions: string[] = [];
    const dependencies: Record<string, unknown> = {
        "@/services/api/generation-tasks": { requestQueuedImages: async (input: unknown) => { requests.push(input); return []; } },
        "./tool-runtime": { resolveToolConfig: async (config: typeof defaultConfig, operation: string, tool?: string) => {
            resolutions.push(operation);
            return { config, toolKey: tool, model: { id: resolvedModelId, modelId: resolvedModelId, name: resolvedModelId, capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 } };
        } },
    };
    const module = { exports: {} as typeof import("@/services/api/image") };
    new Function("require", "module", "exports", code)((key: string) => dependencies[key] || requireModule(key), module, module.exports);
    return { ...module.exports, requests, resolutions };
}

test("exact canvas replay keeps the final prompt byte-for-byte while normal image generation still adds the system prefix", async () => {
    const h = api(), config = { ...defaultConfig, model: "gpt-image-2", imageModel: "gpt-image-2", systemPrompt: "系统要求", imageOptions: '{"background":"opaque"}' };
    const prompt = "系统要求\n\n参考图片编号：图片1。\n\n原始构图";
    await h.requestGeneration(config, prompt, { exactPrompt: true, tool: "canvas-image" });
    await h.requestEdit(config, prompt, [{ id: "a", name: "a.png", type: "image/png", dataUrl: "blob:a" }], undefined, { exactPrompt: true, tool: "canvas-edit" });
    expect(h.requests.map(request => request.prompt)).toEqual([prompt, prompt]);
    expect(h.requests.every(request => request.promptInput === undefined)).toBe(true);
    expect(h.resolutions).toEqual(["image_generation", "inpaint"]);
    await h.requestGeneration(config, "正常提示词", { tool: "canvas-image" });
    expect(h.requests[2].prompt).toContain("系统要求");
    expect(h.requests[2].prompt).toContain("正常提示词");
});

test("exact replay rejects a changed model binding and cancelled submission before any queued request", async () => {
    const h = api("a-different-model"), config = { ...defaultConfig, model: "gpt-image-2" };
    await expect(h.requestGeneration(config, "original prompt", { exactPrompt: true, tool: "canvas-image" })).rejects.toThrow("原生成模型当前不可用");
    await expect(h.requestEdit(config, "original prompt", [{ id: "a", name: "a.png", type: "image/png", dataUrl: "blob:a" }], undefined, { exactPrompt: true, tool: "canvas-edit" })).rejects.toThrow("原生成模型当前不可用");
    expect(h.requests).toEqual([]);
    const controller = new AbortController(); controller.abort();
    await expect(h.requestGeneration(config, "p", { exactPrompt: true, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(h.resolutions).toHaveLength(2);
});
