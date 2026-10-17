import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { ModelPicker } from "@/components/model-picker";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig } from "@/stores/use-config-store";
import { useModuleStore } from "@/stores/use-module-store";
import { moduleKeys } from "@/services/api/modules";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const models = [
    { id: "image", name: "真实图片模型", modelId: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "text", name: "真实文本模型", modelId: "chat-custom", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
    { id: "video", name: "真实视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 },
];
type BusinessState = ReturnType<typeof useBusinessConfigStore.getState>;
function withBusinessConfig<T>(patch: Partial<BusinessState>, run: () => T): T {
    const moduleState = useModuleStore.getInitialState();
    const savedModules = { ...moduleState };
    Object.assign(moduleState, { status: "ready", flags: Object.fromEntries(moduleKeys.map(key => [key, true])) });
    const initialState = useBusinessConfigStore.getInitialState();
    const saved = { ...initialState };
    Object.assign(initialState, { models, status: "ready", ...patch });
    try { return run(); } finally { Object.assign(initialState, saved); Object.assign(moduleState, savedModules); }
}

function panel(metadata: CanvasNodeMetadata, state: Partial<BusinessState> = {}, isRunning = false, linkedTaskCount = 0, linkedTaskHasImages = false, imageCount = 0, textCount = 0) {
    const node: CanvasNodeData = { id: "config-node", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 400, height: 240, metadata: { prompt: "请生成内容", ...metadata } };
    return withBusinessConfig(state, () => renderToStaticMarkup(<CanvasConfigNodePanel node={node} isRunning={isRunning} linkedTaskCount={linkedTaskCount} linkedTaskHasImages={linkedTaskHasImages} inputSummary={{ textCount, imageCount, videoCount: 0, audioCount: 0 }} onConfigChange={() => undefined} onGenerate={() => undefined} onStop={() => undefined} onComposerToggle={() => undefined} />));
}

function actionButton(markup: string, label = "开始生成") {
    const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((item) => item.includes(label));
    if (!button) throw new Error(`Missing action button: ${label}`);
    return button;
}

describe("configuration node model availability", () => {
    test("saved Blend and removed models use the same bound GPT edit route as execution", () => {
        const blend = { id: "blend", name: "旧融合模型", modelId: "midjourney-blend", capabilities: ["generate"], creditCost: 0, rmbCost: 0 };
        const binding = (toolKey: string) => ({ toolKey, modelConfigId: "image", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 });
        const metadata = { generationMode: "image", model: "midjourney-blend", prompt: "保留主体" } as const;
        for (const state of [
            { models: [...models, blend], tools: [binding("canvas-image"), binding("canvas-edit")] },
            { models: [...models, blend], tools: [binding("canvas-image")] },
            { models, tools: [binding("canvas-edit")] },
        ]) {
            const separate = panel(metadata, state, false, 0, false, 2);
            expect(actionButton(separate, "执行 2 个任务")).not.toContain('disabled=""');
            expect(separate).not.toContain("融合 2–4 张参考图，不使用提示词");
            expect(separate).toContain('aria-label="提示词"');
            expect(separate).toContain("后台指定");
            const combined = panel({ ...metadata, configImageInputMode: "combined" }, state, false, 0, false, 2);
            expect(actionButton(combined, "合并参考生成 1 张")).not.toContain('disabled=""');
        }
    });
    test("implicit image tasks require a prompt, but connected common text can supply it", () => {
        const metadata = { generationMode: "image", model: "gpt-image-2", prompt: "", composerContent: "" } as const;
        expect(actionButton(panel(metadata, {}, false, 0, false, 2), "执行 2 个任务")).toContain('disabled=""');
        expect(actionButton(panel(metadata, {}, false, 0, false, 2, 1), "执行 2 个任务")).not.toContain('disabled=""');
        expect(actionButton(panel({ ...metadata, configImageInputMode: "combined" }, {}, false, 0, false, 2), "合并参考生成 1 张")).toContain('disabled=""');
    });
    test("two input images visibly default to two tasks and can explicitly combine into one", () => {
        const metadata = { generationMode: "image", model: "gpt-image-2" } as const;
        const separate = panel(metadata, {}, false, 0, false, 2);
        expect(separate).toContain("逐图执行 · 2 个任务");
        expect(separate).toContain("每个任务主图均为图片1，公共参考从图片2起");
        expect(actionButton(separate, "执行 2 个任务")).not.toContain('disabled=""');
        const combined = panel({ ...metadata, configImageInputMode: "combined" }, {}, false, 0, false, 2);
        expect(combined).toContain("多张参考图共同生成 1 张结果");
        expect(actionButton(combined, "合并参考生成 1 张")).not.toContain('disabled=""');
    });
    test("image targets select the edit tool even without a shared reference image", () => {
        const tools = [{ toolKey: "canvas-edit", modelConfigId: "image", enabled: false, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }];
        const metadata = { generationMode: "image", model: "gpt-image-2" } as const;
        expect(actionButton(panel(metadata, { tools }, false, 2, true), "执行 2 个任务")).toContain('disabled=""');
        expect(actionButton(panel(metadata, { tools }, false, 2, false), "执行 2 个任务")).not.toContain('disabled=""');
    });
    test("linked tasks supply independent inputs across all four modes", () => {
        const audioModel = { id: "audio", name: "真实音频模型", modelId: "real-audio", capabilities: ["audio"], creditCost: 0, rmbCost: 0 };
        const tools = [{ toolKey: "gpt-chat", modelConfigId: "text", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }];
        for (const [generationMode, model] of [["image", "gpt-image-2"], ["text", "chat-custom"], ["video", "wan2.7"], ["audio", "real-audio"]] as const) {
            const markup = panel({ generationMode, model, prompt: "" }, { models: [...models, audioModel], tools }, false, 3);
            expect(markup).toContain("待执行 3 个任务");
            expect(markup).toContain("每个任务使用自身输入与公共素材");
            expect(markup).toContain("左侧接共用素材，右侧连接任务");
            expect(actionButton(markup, "执行 3 个任务")).not.toContain('disabled=""');
            expect(markup).not.toContain("开始生成");
        }
    });

    test("linked tasks cannot bypass unavailable or disabled models and remain stoppable", () => {
        const disabledTool = { toolKey: "canvas-image", modelConfigId: "image", enabled: false, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 };
        expect(actionButton(panel({ generationMode: "image", model: "gpt-image-2" }, { tools: [disabledTool] }, false, 2), "执行 2 个任务")).toContain('disabled=""');
        expect(actionButton(panel({ generationMode: "audio", model: "missing" }, {}, false, 2), "执行 2 个任务")).toContain('disabled=""');
        expect(actionButton(panel({ generationMode: "image", model: "stale" }, {}, false, 2), "执行 2 个任务")).toContain('disabled=""');
        const running = panel({ generationMode: "audio", model: "missing" }, {}, true, 2);
        expect(actionButton(running, "停止")).not.toContain('disabled=""');
        expect(actionButton(running, "停止")).not.toContain("执行 2 个任务");
    });

    test("missing audio capability shows a clear empty state, hides Alloy and disables generation", () => {
        const markup = panel({ generationMode: "audio", model: "gpt-image-2" });
        expect(markup).toContain("暂无可用音频模型");
        expect(markup).not.toContain("gpt-image-2");
        expect(markup).not.toContain("Alloy");
        expect(actionButton(markup)).toContain('disabled=""');
    });

    test("loading and error states cannot expose or submit stale server models", () => {
        for (const status of ["idle", "loading", "error"] as const) {
            const markup = panel({ generationMode: "image", model: "gpt-image-2" }, { status });
            expect(markup).toContain(status === "error" ? "模型配置加载失败" : "正在加载模型");
            expect(markup).not.toContain("真实图片模型");
            expect(actionButton(markup)).toContain('disabled=""');
        }
    });

    test("text configuration hides model identity and stale node selections cannot block the unified model", () => {
        const tools = [{ toolKey: "gpt-chat", modelConfigId: "text", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }];
        const stale = panel({ generationMode: "text", model: "gpt-image-2" }, { tools });
        expect(stale).not.toContain("真实文本模型");
        expect(stale).not.toContain("chat-custom");
        expect(stale).not.toContain('data-usage-control="model"');
        expect(stale).not.toContain("gpt-image-2");
        expect(actionButton(stale)).not.toContain('disabled=""');
        const synced = panel({ generationMode: "text", model: "chat-custom" }, { tools });
        expect(actionButton(synced)).not.toContain('disabled=""');
        expect(actionButton(panel({ generationMode: "text", model: "chat-custom", prompt: "" }, { tools }))).toContain('disabled=""');
        expect(actionButton(panel({ generationMode: "text", model: "chat-custom" }, { tools: [] }))).toContain('disabled=""');
        for (const status of ["loading", "error"] as const) expect(actionButton(panel({ generationMode: "text", model: "chat-custom" }, { tools, status }))).toContain('disabled=""');
    });

    test("an actually configured audio model enables its settings and generation", () => {
        const audioModel = { id: "audio", name: "真实音频模型", modelId: "real-audio", capabilities: ["audio"], creditCost: 0, rmbCost: 0 };
        const markup = panel({ generationMode: "audio", model: "real-audio" }, { models: [...models, audioModel] });
        expect(markup).toContain("真实音频模型");
        expect(markup).toContain("Alloy");
        expect(actionButton(markup)).not.toContain('disabled=""');
    });

    test("a tool-bound model is displayed and usable without overwriting the saved selection", () => {
        const tools = [{ toolKey: "canvas-image", modelConfigId: "image", enabled: true, creditCostOverride: null, rmbCostOverride: null, configurationVersion: 1 }];
        const markup = panel({ generationMode: "image", model: "saved-old-model" }, { tools, models: models.map((model) => model.id === "image" ? { ...model, publicName: "绑定专用模型" } : model) });
        expect(markup).toContain("后台指定");
        expect(markup).toContain("绑定专用模型");
        expect(markup).not.toContain("真实图片模型");
        expect(actionButton(markup)).not.toContain('disabled=""');
        const disabled = panel({ generationMode: "image", model: "gpt-image-2" }, { tools: [{ ...tools[0]!, enabled: false }] });
        expect(actionButton(disabled)).toContain('disabled=""');
    });

    test("an existing run remains stoppable even if its model disappears", () => {
        const markup = panel({ generationMode: "audio", model: "removed-audio" }, {}, true);
        expect(actionButton(markup, "停止")).not.toContain('disabled=""');
        expect(markup).not.toContain("开始生成");
        const modeInputs = markup.match(/<input\b[^>]*>/g)?.filter((input) => input.includes('type="radio"')) || [];
        expect(modeInputs).toHaveLength(4);
        expect(modeInputs.every((input) => input.includes('disabled=""'))).toBe(true);
    });

    test("explicit server pickers reject local defaults while custom local pickers still display valid models", () => {
        const serverMarkup = withBusinessConfig({}, () => renderToStaticMarkup(<ModelPicker config={defaultConfig} capability="audio" modelsSource="server" value="default::gpt-image-2" onChange={() => undefined} />));
        expect(serverMarkup).toContain("暂无可用音频模型");
        expect(serverMarkup).not.toContain("gpt-image-2");
        const localConfig = { ...defaultConfig, audioModels: ["company::custom-voice"] };
        const localMarkup = withBusinessConfig({ status: "idle" }, () => renderToStaticMarkup(<ModelPicker config={localConfig} capability="audio" modelsSource="local" value="company::custom-voice" onChange={() => undefined} />));
        expect(localMarkup).toContain("custom-voice");
        expect(localMarkup).not.toContain("正在加载模型");
    });
});
