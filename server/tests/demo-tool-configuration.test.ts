import { describe, expect, test } from "bun:test";
import { moduleKeys, toolDefinitions } from "../../shared/feature-catalog";
import { resolveDemoToolConfiguration } from "../src/demo-tool-configuration";

const flags = Object.fromEntries(moduleKeys.map(key => [key, true]));
const models = [{ id: "model-a", modelId: "image-a", providerId: "provider", enabled: true, capabilities: ["generate", "edit"] }, { id: "model-b", modelId: "image-b", providerId: "provider", enabled: true, capabilities: ["generate", "edit"] }];
const providers = [{ id: "provider", enabled: true }];
const binding = { toolKey: "creative-garment-colorway" as const, modelConfigId: "model-a", enabled: true };

describe("demo formal tool configuration", () => {
  test("catalog includes formal AI slots, promoted design tools and no unfinished placeholders", () => {
    expect(toolDefinitions).toHaveLength(26);
    expect(new Set(moduleKeys).size).toBe(43);
    expect(moduleKeys).toContain("standard-colors");
    expect(moduleKeys).not.toContain("canvas-ai-upscale");
  });
  test("configured model is resolved and unknown keys cannot fall back", () => {
    expect(resolveDemoToolConfiguration({ operationType: "inpaint", toolKey: binding.toolKey, modelConfigId: "image-a" }, [binding], models, providers, flags)).toEqual({ toolKey: binding.toolKey, modelConfigId: "model-a" });
    expect(() => resolveDemoToolConfiguration({ operationType: "inpaint", toolKey: "creative-typo", modelConfigId: "model-a" }, [], models, providers, flags)).toThrow("板块标识无效");
  });
  test("changed binding, disabled slot and parent reject before provider submission", () => {
    const input = { operationType: "inpaint", toolKey: binding.toolKey, modelConfigId: "model-b" };
    expect(() => resolveDemoToolConfiguration(input, [binding], models, providers, flags)).toThrow("配置已更新");
    expect(() => resolveDemoToolConfiguration(input, [{ ...binding, enabled: false }], models, providers, flags)).toThrow("关闭");
    expect(() => resolveDemoToolConfiguration(input, [], models, providers, { ...flags, creative: false })).toThrow("关闭");
  });
  test("unbound slots retain user choice; operation and provider are still checked", () => {
    expect(resolveDemoToolConfiguration({ operationType: "inpaint", toolKey: "canvas-edit", modelConfigId: "model-b" }, [], models, providers, flags).modelConfigId).toBe("model-b");
    expect(() => resolveDemoToolConfiguration({ operationType: "inpaint", toolKey: "canvas-video", modelConfigId: "model-b" }, [], models, providers, flags)).toThrow("操作类型");
    expect(() => resolveDemoToolConfiguration({ operationType: "inpaint", toolKey: "canvas-edit", modelConfigId: "model-b" }, [], models, [{ id: "provider", enabled: false }], flags)).toThrow("未启用");
  });
});
