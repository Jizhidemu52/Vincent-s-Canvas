import { canvasMaskAdaptationPlan, adaptCanvasMaskInputs, restoreCanvasMaskResult } from "@/lib/canvas/canvas-mask-adaptation";
import { buildCanvasEditMask } from "@/lib/canvas/canvas-mask-paint";
import { canvasMaskEditImageSettings, readCanvasMaskImageSize } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { imageModelProfile } from "@/lib/image-model-settings";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { createClientId } from "@/lib/client-id";
import type { CanvasMaskAdaptation } from "@/lib/canvas/canvas-mask-adaptation";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
export type ImageAgentRegionSelection = { imageId: string; mask: ReferenceImage; selection: ReferenceImage };

/** Reuse the existing selection painter; convert its alpha into the native edit mask. */
export async function saveChatRegionSelection(imageId: string, selectionBlob: Blob, assertCurrent: () => void): Promise<ImageAgentRegionSelection> {
    const url = URL.createObjectURL(selectionBlob);
    try {
        const image = new Image(); image.src = url; await image.decode(); assertCurrent();
        const canvas = document.createElement("canvas"); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d"); if (!context) throw new Error("无法保存修改区域");
        context.drawImage(image, 0, 0);
        const nativeMask = buildCanvasEditMask(canvas);
        const [selection, mask] = await Promise.all([uploadImage(selectionBlob), uploadImage(nativeMask)]); assertCurrent();
        return {
            imageId,
            selection: { id: createClientId(), name: "修改选区.png", type: "image/png", dataUrl: selection.url, storageKey: selection.storageKey },
            mask: { id: createClientId(), name: "局部编辑蒙版.png", type: "image/png", dataUrl: mask.url, storageKey: mask.storageKey },
        };
    } finally { URL.revokeObjectURL(url); }
}

export async function prepareChatMask(config: AiConfig, references: ReferenceImage[], selection: ImageAgentRegionSelection, assertCurrent: () => void) {
    const source = references[0];
    if (!source || source.id !== selection.imageId) throw new Error("局部选区属于另一张图片，请重新选择底图或清除选区；尚未提交。");
    const [sourceUrl, maskUrl] = await Promise.all([imageToDataUrl(source), imageToDataUrl(selection.mask)]); assertCurrent();
    const [sourceSize, maskSize] = await Promise.all([readCanvasMaskImageSize(sourceUrl), readCanvasMaskImageSize(maskUrl)]); assertCurrent();
    if (sourceSize.width !== maskSize.width || sourceSize.height !== maskSize.height) throw new Error("蒙版与原图尺寸不一致，请重新圈选；尚未提交。");
    const profile = imageModelProfile(config.model || config.imageModel);
    const plan = canvasMaskAdaptationPlan(sourceSize, profile);
    const settings = canvasMaskEditImageSettings(config, plan, profile);
    const original = source.storageKey ? { storageKey: source.storageKey } : await uploadImage(sourceUrl); assertCurrent();
    if (!selection.mask.storageKey) throw new Error("局部蒙版尚未保存，请重新圈选；尚未提交。");
    const adapted = await adaptCanvasMaskInputs(sourceUrl, maskUrl, plan); assertCurrent();
    return {
        config: { ...config, ...settings, count: "1" },
        references: [{ ...source, dataUrl: adapted.sourceDataUrl, storageKey: undefined, type: "image/png" }, ...references.slice(1)],
        mask: { ...selection.mask, dataUrl: adapted.maskDataUrl, storageKey: undefined, type: "image/png" },
        adaptation: { ...plan, sourceStorageKey: original.storageKey, maskStorageKey: selection.mask.storageKey },
    };
}

export function restoreChatMaskResult(pending: { requestId: string; maskAdaptation?: CanvasMaskAdaptation }, resultUrl: string) {
    if (!pending.maskAdaptation) return Promise.resolve(resultUrl);
    return restoreCanvasMaskResult({ id: pending.requestId, type: CanvasNodeType.Image, title: "局部修改", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { maskAdaptation: pending.maskAdaptation } }, resultUrl);
}
