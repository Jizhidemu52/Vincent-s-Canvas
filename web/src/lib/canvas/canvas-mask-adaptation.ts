import { imageModelSettingsError, nearestImageSize, type imageModelProfile } from "@/lib/image-model-settings";
import { imageToDataUrl } from "@/services/image-storage";
import type { CanvasNodeData } from "@/types/canvas";

type Size = { width: number; height: number };
export type CanvasMaskAdaptation = Size & { sourceWidth: number; sourceHeight: number; x: number; y: number; fittedWidth: number; fittedHeight: number; sourceStorageKey: string; maskStorageKey: string };

/** One integer letterbox transform is shared by the image and its original-coordinate mask. */
export function canvasMaskAdaptationPlan(source: Size, profile: ReturnType<typeof imageModelProfile>) {
    if (![source.width, source.height].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("原图像素尺寸无效，尚未提交生成。");
    if (!profile.verified || !profile.supportsMask) throw new Error("当前模型不支持局部蒙版，请选择支持蒙版的模型。");
    const raw = `${source.width}x${source.height}`;
    const valid = (size: string) => !imageModelSettingsError(size, profile) && (profile.customSize || profile.sizes.includes(size));
    let target = raw;
    if (!valid(target)) {
        const choices = profile.sizes.filter(value => /^\d+x\d+$/.test(value) && valid(value));
        // Ratio-based models also accept exact pixels; these are conservative legal presets.
        const candidates = choices.length ? choices : ["1024x1024", "1536x1024", "1024x1536"].filter(valid);
        if (!candidates.length) throw new Error("当前模型没有可自动适配的蒙版尺寸，请换一个支持蒙版的模型。");
        target = nearestImageSize(raw, candidates);
    }
    const [width, height] = target.split("x").map(Number) as [number, number];
    const scale = Math.min(width / source.width, height / source.height);
    const fittedWidth = Math.max(1, Math.round(source.width * scale)), fittedHeight = Math.max(1, Math.round(source.height * scale));
    return { width, height, sourceWidth: source.width, sourceHeight: source.height, fittedWidth, fittedHeight, x: Math.floor((width - fittedWidth) / 2), y: Math.floor((height - fittedHeight) / 2) };
}

async function decoded(url: string) {
    const image = new Image(); image.src = url;
    await image.decode();
    return image;
}
function raster(width: number, height: number) {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("浏览器无法处理蒙版图片，请重新打开后重试。");
    return { canvas, context };
}
export async function adaptCanvasMaskInputs(sourceUrl: string, maskUrl: string, plan: ReturnType<typeof canvasMaskAdaptationPlan>) {
    const [source, mask] = await Promise.all([decoded(sourceUrl), decoded(maskUrl)]);
    if (source.naturalWidth !== plan.sourceWidth || source.naturalHeight !== plan.sourceHeight || mask.naturalWidth !== plan.sourceWidth || mask.naturalHeight !== plan.sourceHeight) throw new Error("原图或蒙版尺寸已变化，尚未提交生成。");
    const output = raster(plan.width, plan.height), outputMask = raster(plan.width, plan.height);
    output.context.fillStyle = "#fff"; output.context.fillRect(0, 0, plan.width, plan.height);
    output.context.drawImage(source, plan.x, plan.y, plan.fittedWidth, plan.fittedHeight);
    outputMask.context.fillStyle = "#fff"; outputMask.context.fillRect(0, 0, plan.width, plan.height);
    outputMask.context.clearRect(plan.x, plan.y, plan.fittedWidth, plan.fittedHeight);
    outputMask.context.drawImage(mask, plan.x, plan.y, plan.fittedWidth, plan.fittedHeight);
    return { sourceDataUrl: output.canvas.toDataURL("image/png"), maskDataUrl: outputMask.canvas.toDataURL("image/png") };
}

/** Lossless final PNG: all pixels outside the ORIGINAL mask are copied byte-for-byte. */
export async function restoreCanvasMaskResult(node: CanvasNodeData, resultUrl: string): Promise<string> {
    const plan = node.metadata?.maskAdaptation;
    if (!plan) return resultUrl;
    const [sourceUrl, maskUrl] = await Promise.all([imageToDataUrl({ storageKey: plan.sourceStorageKey }), imageToDataUrl({ storageKey: plan.maskStorageKey })]);
    if (!sourceUrl || !maskUrl) throw new Error("原图或原始蒙版暂不可用，已保留原任务；恢复素材后查询，不会重新生成。");
    const [source, mask, result] = await Promise.all([decoded(sourceUrl), decoded(maskUrl), decoded(resultUrl)]);
    if (source.naturalWidth !== plan.sourceWidth || source.naturalHeight !== plan.sourceHeight || mask.naturalWidth !== plan.sourceWidth || mask.naturalHeight !== plan.sourceHeight) throw new Error("原始素材尺寸与蒙版记录不符，已保留原任务，请恢复原始素材后再查询。");
    if (result.naturalWidth !== plan.width || result.naturalHeight !== plan.height) throw new Error("返回图片尺寸与适配坐标不符，已保留原任务，不展示错位蒙版结果。");
    const output = raster(plan.sourceWidth, plan.sourceHeight), maskRaster = raster(plan.sourceWidth, plan.sourceHeight), generated = raster(plan.sourceWidth, plan.sourceHeight);
    output.context.drawImage(source, 0, 0); maskRaster.context.drawImage(mask, 0, 0);
    generated.context.drawImage(result, plan.x, plan.y, plan.fittedWidth, plan.fittedHeight, 0, 0, plan.sourceWidth, plan.sourceHeight);
    const originalPixels = output.context.getImageData(0, 0, plan.sourceWidth, plan.sourceHeight);
    const maskPixels = maskRaster.context.getImageData(0, 0, plan.sourceWidth, plan.sourceHeight).data;
    const generatedPixels = generated.context.getImageData(0, 0, plan.sourceWidth, plan.sourceHeight).data;
    for (let index = 0; index < originalPixels.data.length; index += 4) if (maskPixels[index + 3]! < 128) originalPixels.data.set(generatedPixels.subarray(index, index + 4), index);
    output.context.putImageData(originalPixels, 0, 0);
    return output.canvas.toDataURL("image/png");
}
