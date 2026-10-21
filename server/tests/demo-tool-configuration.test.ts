import { describe, expect, test } from "bun:test";
import { moduleKeys, toolDefinitions } from "../../shared/feature-catalog";
import { resolveDemoToolConfiguration } from "../src/demo-tool-configuration";
import { MARK_PLATFORM_MODELS } from "../../shared/mark-image-models";

const flags = Object.fromEntries(moduleKeys.map(key => [key, true]));
const models = [{ id: "model-a", modelId: "image-a", providerId: "provider", enabled: true, capabilities: ["generate", "edit"] }, { id: "model-b", modelId: "image-b", providerId: "provider", enabled: true, capabilities: ["generate", "edit"] }];
const providers = [{ id: "provider", enabled: true }];
const binding = { toolKey: "creative-garment-colorway" as const, modelConfigId: "model-a", enabled: true };

describe("demo formal tool configuration", () => {
  test("new scenes inherit only untouched defaults; saved choices and clearing are respected", () => {
    const source = { toolKey: "image-edit", modelConfigId: "model-a", enabled: true };
    const fresh = { toolKey: "creative-pattern-layers", modelConfigId: null, enabled: true, configurationVersion: 0 };
    const input = { operationType: "inpaint", toolKey: fresh.toolKey };
    expect(resolveDemoToolConfiguration(input, [source, fresh], models, providers, flags).modelConfigId).toBe("model-a");
    expect(() => resolveDemoToolConfiguration({ ...input, modelConfigId: "model-b" }, [source, fresh], models, providers, flags)).toThrow("配置已更新");
    expect(resolveDemoToolConfiguration({ ...input, modelConfigId: "model-b" }, [source, { ...fresh, configurationVersion: 1 }], models, providers, flags).modelConfigId).toBe("model-b");
    expect(() => resolveDemoToolConfiguration(input, [source, { ...fresh, enabled: false }], models, providers, flags)).toThrow("关闭");
  });
  test("chat ignores canvas and client choices, including shared upstream IDs from other providers", () => {
    const chats = [
      { id: "chat-a", modelId: "same-upstream", providerId: "provider", enabled: true, capabilities: ["chat"] },
      { id: "chat-b", modelId: "same-upstream", providerId: "second-provider", enabled: true, capabilities: ["chat"] },
    ];
    const configured = [{ toolKey: "gpt-chat", modelConfigId: "chat-a", enabled: true }, { toolKey: "canvas-chat", modelConfigId: "chat-b", enabled: true }, { toolKey: "creative-planner", modelConfigId: "chat-b", enabled: true }];
    const chatProviders = [...providers, { id: "second-provider", enabled: true }];
    for (const toolKey of [undefined, "gpt-chat", "canvas-chat", "creative-planner"]) {
      expect(resolveDemoToolConfiguration({ operationType: "chat", toolKey, modelConfigId: "chat-b" }, configured, chats, chatProviders, flags).modelConfigId).toBe("chat-a");
    }
    expect(() => resolveDemoToolConfiguration({ operationType: "chat", modelConfigId: "chat-b" }, [], chats, chatProviders, flags)).toThrow("尚未配置统一对话模型");
    chats[0]!.enabled = false;
    expect(() => resolveDemoToolConfiguration({ operationType: "chat", toolKey: "canvas-chat", modelConfigId: "chat-b" }, configured, chats, chatProviders, flags)).toThrow("未启用");
  });
  test("catalog includes formal AI slots, promoted design tools and no unfinished placeholders", () => {
    expect(toolDefinitions).toHaveLength(44);
    expect(new Set(moduleKeys).size).toBe(63);
    expect(toolDefinitions.find(tool => tool.toolKey === "creative-planner")).toMatchObject({ operationType: "chat", operations: ["chat"], capabilities: ["chat"], parent: "creative" });
    expect(moduleKeys).toContain("midjourney-blend");
    expect(moduleKeys).toContain("standard-colors");
    expect(moduleKeys).not.toContain("canvas-ai-upscale");
  });
  test("configured model is resolved and unknown keys cannot fall back", () => {
    expect(resolveDemoToolConfiguration({ operationType: "inpaint", toolKey: binding.toolKey, modelConfigId: "image-a" }, [binding], models, providers, flags)).toEqual({ toolKey: binding.toolKey, modelConfigId: "model-a" });
    expect(() => resolveDemoToolConfiguration({ operationType: "inpaint", toolKey: "creative-typo", modelConfigId: "model-a" }, [], models, providers, flags)).toThrow("板块标识无效");
  });
  test("planner fails closed for its switch, creative parent, or missing shared binding", () => {
    const chats = [{ id: "chat-a", modelId: "vision-model", providerId: "provider", enabled: true, capabilities: ["chat", "vision"] }];
    const shared = { toolKey: "gpt-chat", modelConfigId: "chat-a", enabled: false };
    const planner = { toolKey: "creative-planner", modelConfigId: "forged-own-model", enabled: true };
    const input = { operationType: "chat", toolKey: planner.toolKey, modelConfigId: "forged-client-model" };
    expect(resolveDemoToolConfiguration(input, [shared, planner], chats, providers, flags).modelConfigId).toBe("chat-a");
    expect(() => resolveDemoToolConfiguration(input, [shared, { ...planner, enabled: false }], chats, providers, flags)).toThrow("关闭");
    expect(() => resolveDemoToolConfiguration(input, [shared, planner], chats, providers, { ...flags, creative: false })).toThrow("关闭");
    expect(() => resolveDemoToolConfiguration(input, [{ ...shared, modelConfigId: null }, planner], chats, providers, flags)).toThrow("尚未配置统一对话模型");
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
  test("Blend accepts only its model but remains available in the canvas generation slot", () => {
    const preset = MARK_PLATFORM_MODELS.find(model => model.modelId === "midjourney-blend")!;
    const blendModels = [...models, { id: "blend", modelId: preset.modelId, providerId: "provider", enabled: true, capabilities: [...preset.capabilities] }];
    const input = { operationType: "image_generation", toolKey: "midjourney-blend", modelConfigId: "model-a" };
    expect(() => resolveDemoToolConfiguration(input, [], blendModels, providers, flags)).toThrow("仅支持 Midjourney Blend");
    expect(() => resolveDemoToolConfiguration({ ...input, modelConfigId: undefined }, [{ toolKey: "midjourney-blend", modelConfigId: "model-a", enabled: true }], blendModels, providers, flags)).toThrow("仅支持 Midjourney Blend");
    expect(resolveDemoToolConfiguration({ ...input, modelConfigId: "blend" }, [], blendModels, providers, flags).modelConfigId).toBe("blend");
    expect(resolveDemoToolConfiguration({ ...input, toolKey: "canvas-image", modelConfigId: "blend" }, [], blendModels, providers, flags).modelConfigId).toBe("blend");
    expect(() => resolveDemoToolConfiguration({ operationType: "inpaint", toolKey: "canvas-edit", modelConfigId: "blend" }, [], blendModels, providers, flags)).toThrow("不支持");
  });
});
