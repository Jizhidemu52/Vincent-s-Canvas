import { displayNotice } from "@/hooks/use-display-text";
import { uiText } from "@/lib/i18n";
import { promptImageSettings } from "@/lib/prompt-editor-parameters";
import { hydratePromptReuse } from "@/services/api/prompts";
import { fetchServerAssetContent } from "@/services/api/server-assets";
import { uploadImage } from "@/services/image-storage";
import type { CanvasSelectionReference } from "@/lib/canvas/canvas-selection-references";
import type { App } from "antd";
import { nanoid } from "nanoid";

type TemplateSettings = ReturnType<typeof promptImageSettings> & { model: string };
type Feedback = ReturnType<typeof App.useApp>;
type QuickTemplateOptions = {
    token: string;
    batch: boolean;
    fallbackModel: string;
    current: () => boolean;
    inputCurrent: () => boolean;
    captureInput: () => () => boolean;
    consume: () => void;
    apply: (prompt: string, settings: TemplateSettings, references: CanvasSelectionReference[], batch: boolean) => void;
    generate: () => Promise<void>;
    message: Feedback["message"];
    modal: Feedback["modal"];
};

/** Template-only hydration and confirmation stay off the normal canvas entry. */
export async function fillCanvasQuickTemplate(options: QuickTemplateOptions) {
    const { current, inputCurrent, message, modal } = options;
    const keepNewerInput = () => {
        if (current()) {
            options.consume();
            message.info(uiText("输入已变化，未用模板覆盖当前草稿，请重新选择模板以套用。"));
        }
    };
    if (!inputCurrent()) { keepNewerInput(); return; }
    const payload = await hydratePromptReuse(options.token);
    if (!inputCurrent()) { keepNewerInput(); return; }
    const batch = payload.template.targetTool === "batch-edit" || options.batch;
    const model = payload.pricing.selectedModel?.modelId || options.fallbackModel;
    const settings = { ...promptImageSettings(payload.template.parameters, model), model };
    // Resolve the complete template before touching the form. Any intervening
    // input or A -> B -> A selection rejects the entire fill, not just images.
    const references = batch ? [] : await Promise.all(payload.template.referenceAssetIds.map(async assetId => {
        const blob = await fetchServerAssetContent(assetId);
        if (!inputCurrent()) return null;
        const image = await uploadImage(blob);
        return { id: nanoid(), name: "模板参考图.png", type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey, sourceAssetId: assetId };
    }));
    if (!inputCurrent()) { keepNewerInput(); return; }
    options.apply(payload.template.prompt, settings, references.filter(reference => reference !== null), batch);
    options.consume();
    payload.warnings.forEach(warning => message.warning(displayNotice(warning)));
    if (payload.pricing.modelChanged) message.warning(displayNotice(payload.pricing.selectedModel ? uiText("模型已变更，当前使用 {value1}", { value1: payload.pricing.selectedModel.name }) : uiText("模型已变更，请选择管理员当前启用的模型")));
    if (payload.mode === "fill_and_generate" && !batch) {
        const appliedInputCurrent = options.captureInput();
        modal.confirm({ title: uiText("确认在画布生成？"), content: uiText("请检查提示词和参考图，确认后提交生成任务。"), okText: uiText("确认生成"), cancelText: uiText("仅保留填入"), onOk: () => {
            if (!appliedInputCurrent()) { keepNewerInput(); return; }
            return options.generate();
        } });
    } else if (payload.mode === "fill_and_generate" && batch) {
        message.info(uiText("模板已填入，请先选择文件夹，再确认批量生成。"));
    } else message.success(uiText("模板已填入，请检查后再生成。"));
}
