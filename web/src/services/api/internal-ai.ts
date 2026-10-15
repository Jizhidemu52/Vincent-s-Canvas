import { requestQueuedImages } from "@/services/api/generation-tasks";
import { imageModelProfile, normalizeImageModelSettings } from "@/lib/image-model-settings";
import { imageTaskParameters } from "@/services/api/image";
import { generationDraftInput } from "@/services/api/generation-history";
import { resolveToolConfig } from "@/services/api/tool-runtime";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";

export type SeamlessStitchParameters = {
    cutWidth: number;
    redrawWidth: number;
    blurAmount: number;
    redrawStrength: number;
    steps: number;
};

export const DEFAULT_SEAMLESS_STITCH_PARAMETERS: SeamlessStitchParameters = {
    cutWidth: 200,
    redrawWidth: 200,
    blurAmount: 100,
    redrawStrength: 1,
    steps: 12,
};

export const SEAMLESS_PATTERN_PROMPT = "将参考图处理成可四方连续平铺的无缝花型。保留原图的主体元素、配色、材质与绘画风格，优化边缘和元素布局，使左边缘与右边缘、上边缘与下边缘准确衔接，平铺后没有可见接缝、断裂或突兀的重复边界。输出单张平面花型单元，不要拼贴预览、边框、文字、水印或透视效果。";

export async function requestSeamlessStitch(reference: ReferenceImage, parameters: SeamlessStitchParameters, config: AiConfig) {
    const resolved = await resolveToolConfig(config, "seamless_stitch", "seamless-stitch");
    const profile = imageModelProfile(resolved.model.modelId, [resolved.model]);
    const usesImageSettings = typeof resolved.model.imageSupportsMask === "boolean" || profile.kind === "quality-resolution" || profile.kind === "resolution-1k";
    if (!usesImageSettings) assertSeamlessParameters(parameters);
    const taskParameters = usesImageSettings ? imageTaskParameters(resolved.config, profile, { referenceCount: 1 }) : parameters;
    const prompt = usesImageSettings ? SEAMLESS_PATTERN_PROMPT : "无缝拼接";
    const taskConfig = { ...resolved.config, ...normalizeImageModelSettings(resolved.config, profile), count: "1" };
    const [result] = await requestQueuedImages({
        modelId: resolved.model.modelId,
        resolvedModel: resolved.model,
        prompt,
        count: 1,
        operationType: "seamless_stitch",
        tool: "seamless-stitch",
        parameters: taskParameters,
        ...(usesImageSettings ? { draft: generationDraftInput(taskConfig, prompt) } : {}),
        references: [reference],
    });
    if (!result) throw new Error("无缝拼接任务没有返回图片");
    return { ...result, model: resolved.model, parameters: taskParameters, prompt, config: taskConfig, usesImageSettings };
}

function assertSeamlessParameters(parameters: SeamlessStitchParameters) {
    const positiveInteger = (value: number) => Number.isInteger(value) && value >= 1 && value <= 2_000;
    if (!positiveInteger(parameters.cutWidth) || !positiveInteger(parameters.redrawWidth) || !positiveInteger(parameters.blurAmount)) {
        throw new Error("切割宽度、重绘宽度和羽化必须是 1 到 2000 的整数");
    }
    if (!Number.isFinite(parameters.redrawStrength) || parameters.redrawStrength < 0 || parameters.redrawStrength > 1) {
        throw new Error("重绘强度必须在 0 到 1 之间");
    }
    if (!Number.isInteger(parameters.steps) || parameters.steps < 1 || parameters.steps > 100) {
        throw new Error("步数必须是 1 到 100 的整数");
    }
}
