import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildToolConfigurationInput, compatibleToolModels, completeToolConfigurations, toolConfigurationState } from "../src/pages/admin/components/tool-configuration-state";
import { updateToolApiConfiguration, type ServerModel, type ServerProvider } from "../src/services/api/model-configuration";
import { moduleDefinitions, moduleKeys, nonAiDefinitions, toolDefinitions } from "../src/services/api/modules";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const provider: ServerProvider = { id: "provider", name: "API", protocol: "openai", baseUrl: "https://example.test/v1", enabled: true, hasCredentials: true, createdAt: "", updatedAt: "" };
const model: ServerModel = { id: "model", name: "图片模型", modelId: "image-v1", providerId: "provider", providerName: "API", workflowConfigId: null, workflowName: null, capabilities: ["generate", "edit"], creditCost: 4, rmbCost: 0.8, concurrencyLimit: 2, enabled: true };
const tool = () => completeToolConfigurations([]).find((item) => item.toolKey === "image")!;

describe("formal admin catalog and isolated board saves", () => {
    test("uses every authoritative AI and non-AI definition without invented entries", () => {
        expect(completeToolConfigurations([]).map((item) => item.toolKey)).toEqual(toolDefinitions.map((item) => item.toolKey));
        expect(moduleKeys.length).toBe(toolDefinitions.length + nonAiDefinitions.length);
        expect(new Set(moduleKeys).size).toBe(moduleKeys.length);
        expect(moduleDefinitions.some((item) => item.moduleKey === "canvas-upscale" as string)).toBe(false);
        expect(completeToolConfigurations([]).every((item) => item.enabled === (item.toolKey !== "layer-studio") && item.modelConfigId === null && item.configurationVersion === 0)).toBe(true);
    });

    test("preserves false and zero while clearing binding to null", () => {
        expect(buildToolConfigurationInput(tool(), { enabled: false, modelConfigId: null, creditCostOverride: 0, rmbCostOverride: 0 })).toEqual({ enabled: false, modelConfigId: null, creditCostOverride: 0, rmbCostOverride: 0 });
        expect(buildToolConfigurationInput(tool(), { enabled: true })).toEqual({ enabled: true, modelConfigId: null, creditCostOverride: null, rmbCostOverride: null });
        const chat = completeToolConfigurations([]).find((item) => item.toolKey === "gpt-chat")!;
        expect(buildToolConfigurationInput(chat, { creditCostOverride: 10, rmbCostOverride: 3 })).toMatchObject({ creditCostOverride: 10, rmbCostOverride: 3 });
        expect(buildToolConfigurationInput(chat, { creditCostOverride: 0, rmbCostOverride: 0 })).toMatchObject({ creditCostOverride: 0, rmbCostOverride: 0 });
    });

    test("catalog capabilities cannot be replaced by a bound model or a null join", () => {
        const result = completeToolConfigurations([{ ...tool(), capabilities: null } as unknown as ReturnType<typeof tool>]);
        expect(result.find(item => item.toolKey === "image")?.capabilities).toEqual(["generate"]);
    });

    test("only submits one board PUT, without provider/model/global-price writes", async () => {
        const requests: Array<{ path: string; method?: string; body: unknown }> = [];
        globalThis.fetch = (async (path: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ path: String(path), method: init?.method, body: JSON.parse(String(init?.body)) });
            return Response.json({ tool: { toolKey: "image", configurationVersion: 1 } });
        }) as typeof fetch;
        const input = buildToolConfigurationInput(tool(), { modelConfigId: model.id, enabled: true, creditCostOverride: 0, rmbCostOverride: 0.2 });
        await updateToolApiConfiguration("image", input);
        expect(requests).toEqual([{ path: "/api/admin/model-configuration/tool-configurations/image", method: "PUT", body: input }]);
        const component = readFileSync(new URL("../src/pages/admin/components/api-configuration-hub.tsx", import.meta.url), "utf8");
        expect(component).not.toMatch(/\b(createPriceDraft|publishPrice|updateServerModel|updateServerProvider|createServerModel|createServerProvider)\b/);
    });

    test("limits bindings to enabled compatible models with available API", () => {
        const models = [model, { ...model, id: "off", enabled: false }, { ...model, id: "chat", capabilities: ["chat"] as ServerModel["capabilities"] }];
        expect(compatibleToolModels(tool(), models, [provider], []).map((item) => item.id)).toEqual(["model"]);
        expect(compatibleToolModels(tool(), models, [{ ...provider, hasCredentials: false }], [])).toEqual([]);
        expect(compatibleToolModels(tool(), models, [{ ...provider, enabled: false }], [])).toEqual([]);
        expect(compatibleToolModels(tool(), [{ ...model, workflowConfigId: "missing" }], [provider], [])).toEqual([]);
    });

    test("layer studio is disabled and unbound by default, never inherited or user-selected", () => {
        const studio = completeToolConfigurations([]).find(item => item.toolKey === "layer-studio")!;
        expect(studio).toMatchObject({ enabled: false, modelConfigId: null });
        expect(buildToolConfigurationInput(studio, {})).toMatchObject({ enabled: false, modelConfigId: null });
        expect(toolConfigurationState(studio, [model])).toMatchObject({ ready: false, label: "已停用" });
        expect(toolConfigurationState({ ...studio, enabled: true }, [model])).toMatchObject({ ready: false, label: "待配置" });
        expect(toolConfigurationState({ ...studio, enabled: true }, [model]).reason).not.toMatch(/继承|用户选择/);
        expect(completeToolConfigurations([{ ...studio, enabled: true, modelConfigId: "explicit", creditCostOverride: 0 }]).find(item => item.toolKey === "layer-studio"))
            .toMatchObject({ enabled: true, modelConfigId: "explicit", creditCostOverride: 0 });
    });

    test("layer studio binding matches exact dedicated provider/model and excludes it from every other board", () => {
        const studio = completeToolConfigurations([]).find(item => item.toolKey === "layer-studio")!;
        const apimart: ServerProvider = { ...provider, id: "apimart", protocol: "apimart" };
        const dedicated: ServerModel = { ...model, id: "dedicated", providerId: apimart.id, modelId: "seedream-5-5" };
        const models: ServerModel[] = [model, dedicated, { ...dedicated, id: "wrong-protocol", providerId: provider.id },
            { ...dedicated, id: "workflow", workflowConfigId: "flow" }, { ...dedicated, id: "wrong-version", modelId: "seedream-5" },
            { ...dedicated, id: "disabled", enabled: false }];
        const providers = [provider, apimart];
        expect(compatibleToolModels(studio, models, providers, []).map(item => item.id)).toEqual(["dedicated"]);
        expect(compatibleToolModels(studio, [dedicated], [{ ...apimart, hasCredentials: false }], [])).toEqual([]);
        expect(compatibleToolModels(studio, [dedicated], [{ ...apimart, enabled: false }], [])).toEqual([]);
        for (const other of completeToolConfigurations([]).filter(item => item.toolKey !== "layer-studio")) {
            expect(compatibleToolModels({ ...other, capabilities: ["generate"] }, models, providers, []).some(item => item.modelId === "seedream-5-5")).toBe(false);
        }
        expect(toolConfigurationState({ ...studio, enabled: true, modelConfigId: model.id }, compatibleToolModels(studio, models, providers, []))).toMatchObject({ ready: false, label: "绑定不可用" });
        expect(toolConfigurationState({ ...studio, enabled: true, modelConfigId: dedicated.id }, compatibleToolModels(studio, models, providers, []))).toMatchObject({ ready: true, label: "已绑定" });
    });

    test("the independent Blend board cannot bind another image model, but canvas generation can bind Blend", () => {
        const blend = { ...model, id: "blend-model", modelId: "midjourney-blend", capabilities: ["generate"] as ServerModel["capabilities"] };
        const tools = completeToolConfigurations([]);
        const blendTool = tools.find(item => item.toolKey === "midjourney-blend")!;
        const canvasTool = tools.find(item => item.toolKey === "canvas-image")!;
        expect(compatibleToolModels(blendTool, [model, blend], [provider], []).map(item => item.id)).toEqual(["blend-model"]);
        expect(compatibleToolModels(canvasTool, [model, blend], [provider], []).map(item => item.id)).toEqual(["model", "blend-model"]);
        expect(toolConfigurationState({ ...blendTool, modelConfigId: model.id }, compatibleToolModels(blendTool, [model, blend], [provider], [])).ready).toBe(false);
    });

    test("never mislabels unbound-disabled or unavailable bindings as configured", () => {
        expect(toolConfigurationState({ ...tool(), enabled: false }, [model]).label).toBe("已停用");
        expect(toolConfigurationState(tool(), [model]).label).toBe("继承 / 用户选择");
        expect(toolConfigurationState(tool(), []).ready).toBe(false);
        expect(toolConfigurationState({ ...tool(), modelConfigId: "missing" }, [model]).ready).toBe(false);
        expect(toolConfigurationState({ ...tool(), modelConfigId: "model" }, [model]).ready).toBe(true);
    });

    test("chat is centrally configured, never left to designer selection", () => {
        const chat = completeToolConfigurations([]).find(item => item.toolKey === "gpt-chat")!;
        const canvasChat = completeToolConfigurations([]).find(item => item.toolKey === "canvas-chat")!;
        const textModel: ServerModel = { ...model, id: "sonnet", modelId: "claude-sonnet-5-5", capabilities: ["chat"] };
        expect(toolConfigurationState(chat, [textModel])).toMatchObject({ ready: false, label: "待配置" });
        expect(toolConfigurationState(canvasChat, [textModel]).ready).toBe(false);
        expect(toolConfigurationState({ ...chat, modelConfigId: "sonnet" }, [textModel])).toMatchObject({ ready: true, label: "统一模型已配置" });
        expect(toolConfigurationState({ ...canvasChat, modelConfigId: "sonnet" }, [textModel])).toMatchObject({ ready: true, label: "跟随统一模型" });
        expect(buildToolConfigurationInput(canvasChat, { modelConfigId: "stale-canvas-choice", enabled: false, creditCostOverride: 0, rmbCostOverride: 0.1 })).toEqual({ modelConfigId: null, enabled: false, creditCostOverride: 0, rmbCostOverride: 0.1 });
        expect(buildToolConfigurationInput(chat, { modelConfigId: "sonnet", enabled: true }).modelConfigId).toBe("sonnet");
        expect(chat.label).toBe("对话改图");
    });
});
