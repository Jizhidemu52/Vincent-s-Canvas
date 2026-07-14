import { requestQueuedImages } from "@/services/api/generation-tasks";
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

export async function requestSeamlessStitch(reference: ReferenceImage, parameters: SeamlessStitchParameters, modelId: string) {
    assertSeamlessParameters(parameters);
    const [result] = await requestQueuedImages({
        modelId,
        prompt: "无缝拼接",
        count: 1,
        operationType: "seamless_stitch",
        tool: "seamless-stitch",
        parameters,
        references: [reference],
    });
    if (!result) throw new Error("无缝拼接任务没有返回图片");
    return result;
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
