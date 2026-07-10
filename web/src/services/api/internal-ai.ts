import { requestQueuedImages } from "@/services/api/generation-tasks";
import type { ReferenceImage } from "@/types/image";

const INTERNAL_SEAMLESS_MODEL_ID = "internal-seamless";

export async function requestSeamlessStitch(reference: ReferenceImage, rows: number, cols: number) {
    if (!isEvenMultiplier(rows) || !isEvenMultiplier(cols)) throw new Error("横向和纵向倍率必须是 2 的倍数");
    const [result] = await requestQueuedImages({
        modelId: INTERNAL_SEAMLESS_MODEL_ID,
        prompt: JSON.stringify({ instruction: "无缝拼接", rows, cols }),
        count: 1,
        operationType: "seamless_stitch",
        references: [reference],
    });
    if (!result) throw new Error("无缝拼接任务没有返回图片");
    return result;
}

function isEvenMultiplier(value: number) {
    return Number.isInteger(value) && value >= 2 && value <= 32 && value % 2 === 0;
}
