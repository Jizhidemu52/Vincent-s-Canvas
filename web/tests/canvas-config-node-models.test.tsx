import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { ModelPicker } from "@/components/model-picker";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { defaultConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

const models = [
    { id: "image", name: "真实图片模型", modelId: "gpt-image-2", capabilities: ["generate", "edit"], creditCost: 0, rmbCost: 0 },
    { id: "text", name: "真实文本模型", modelId: "chat-custom", capabilities: ["chat"], creditCost: 0, rmbCost: 0 },
    { id: "video", name: "真实视频模型", modelId: "wan2.7", capabilities: ["video"], creditCost: 0, rmbCost: 0 },
];
type BusinessState = ReturnType<typeof useBusinessConfigStore.getState>;
function withBusinessConfig<T>(patch: Partial<BusinessState>, run: () => T): T {
    const initialState = useBusinessConfigStore.getInitialState();
    const saved = { ...initialState };
    Object.assign(initialState, { models, status: "ready", ...patch });
    try { return run(); } finally { Object.assign(initialState, saved); }
}

function panel(metadata: CanvasNodeMetadata, state: Partial<BusinessState> = {}, isRunning = false) {
    const node: CanvasNodeData = { id: "config-node", type: CanvasNodeType.Config, title: "配置", position: { x: 0, y: 0 }, width: 400, height: 240, metadata: { prompt: "请生成内容", ...metadata } };
    return withBusinessConfig(state, () => renderToStaticMarkup(<CanvasConfigNodePanel node={node} isRunning={isRunning} inputSummary={{ textCount: 0, imageCount: 0, videoCount: 0, audioCount: 0 }} onConfigChange={() => undefined} onGenerate={() => undefined} onStop={() => undefined} onComposerToggle={() => undefined} />));
}

function actionButton(markup: string, label = "开始生成") {
    const button = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g)?.find((item) => item.includes(label));
    if (!button) throw new Error(`Missing action button: ${label}`);
    return button;
}

describe("configuration node model availability", () => {
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

    test("correcting a stale saved model must finish before generation is enabled", () => {
        const stale = panel({ generationMode: "text", model: "gpt-image-2" });
        expect(stale).toContain("真实文本模型");
        expect(stale).not.toContain("gpt-image-2");
        expect(actionButton(stale)).toContain('disabled=""');
        const synced = panel({ generationMode: "text", model: "chat-custom" });
        expect(actionButton(synced)).not.toContain('disabled=""');
        expect(actionButton(panel({ generationMode: "text", model: "chat-custom", prompt: "" }))).toContain('disabled=""');
    });

    test("an actually configured audio model enables its settings and generation", () => {
        const audioModel = { id: "audio", name: "真实音频模型", modelId: "real-audio", capabilities: ["audio"], creditCost: 0, rmbCost: 0 };
        const markup = panel({ generationMode: "audio", model: "real-audio" }, { models: [...models, audioModel] });
        expect(markup).toContain("真实音频模型");
        expect(markup).toContain("Alloy");
        expect(actionButton(markup)).not.toContain('disabled=""');
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
