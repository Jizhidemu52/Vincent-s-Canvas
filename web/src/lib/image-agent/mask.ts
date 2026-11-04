import { canvasMaskAdaptationPlan, adaptCanvasMaskInputs, restoreCanvasMaskResult } from "@/lib/canvas/canvas-mask-adaptation";
import { buildCanvasEditMask } from "@/lib/canvas/canvas-mask-paint";
import { canvasMaskEditImageSettings, readCanvasMaskImageSize } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { imageModelProfile } from "@/lib/image-model-settings";
import { imageToDataUrl, uploadImage } from "@/services/image-storage";
import { createClientId } from "@/lib/client-id";
import { IMAGE_AGENT_MAX_IMAGES } from "@/lib/image-agent/focus";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { readFileAsDataUrl } from "@/lib/image-utils";
import { compositeSelectedImage, createSelectionGuide } from "@/pages/creative/image-processing-browser";
import { selectionSizeMatches } from "@/pages/creative/image-processing";
import type { CanvasMaskAdaptation } from "@/lib/canvas/canvas-mask-adaptation";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
export type ImageAgentRegionSelection = { imageId: string; mask: ReferenceImage; selection: ReferenceImage };
/** Nested storageKey fields keep both originals reachable by the existing image cleanup. */
export type ChatRegionComposite = {
    mode: "selection-composite";
    source: { imageId: string; storageKey: string; width: number; height: number };
    selection: { storageKey: string; width: number; height: number };
};
type PreparedChatRegionEdit = {
    config: AiConfig; references: ReferenceImage[]; mask?: ReferenceImage;
    adaptation?: CanvasMaskAdaptation; regionComposite?: ChatRegionComposite; promptPrefix: string;
};

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

/** Standalone chat opt-in; canvas/native callers retain the existing mask-only contract. */
export async function prepareChatRegionEdit(config: AiConfig, references: ReferenceImage[], selection: ImageAgentRegionSelection, assertCurrent: () => void): Promise<PreparedChatRegionEdit> {
    assertCurrent();
    const profile = imageModelProfile(config.model || config.imageModel);
    if (profile.supportsMask) return { ...await prepareChatMask(config, references, selection, assertCurrent), promptPrefix: "只修改蒙版透明区域，选区外保持不变。" };
    if (!profile.verified || profile.kind === "midjourney" || profile.kind === "midjourney-blend") throw new Error("当前模型不能用于选区改图，请选择支持参考图编辑的模型；尚未提交。");
    const source = references[0];
    if (!source || source.id !== selection.imageId) throw new Error("局部选区属于另一张图片，请重新选择底图或清除选区；尚未提交。");
    if (!selection.selection.storageKey) throw new Error("局部选区尚未保存，请重新圈选；尚未提交。");
    const guideReference: ReferenceImage = { id: `selection-guide:${selection.selection.id}`, name: "蓝色选区示意.png", type: "image/png", dataUrl: "" };
    if (references.length + 1 > IMAGE_AGENT_MAX_IMAGES) throw new Error("底图、参考图与选区示意图合计最多 5 张，请移除一张参考图；尚未提交。");
    const validation = validateImageReferences(config.model || config.imageModel, [...references, guideReference], profile);
    if (!validation.valid) throw new Error(`${validation.message} 选区示意图也计入参考图数量；尚未提交。`);
    const [sourceUrl, selectionUrl] = await Promise.all([imageToDataUrl(source), imageToDataUrl({ storageKey: selection.selection.storageKey })]); assertCurrent();
    if (!sourceUrl || !selectionUrl) throw new Error("原图或局部选区不可读取，请重新提供原图和选区；尚未提交。");
    const [sourceSize, selectionSize] = await Promise.all([readCanvasMaskImageSize(sourceUrl), readCanvasMaskImageSize(selectionUrl)]); assertCurrent();
    if (sourceSize.width !== selectionSize.width || sourceSize.height !== selectionSize.height) throw new Error("选区与原图尺寸不一致，请重新圈选；尚未提交。");
    if (!selectionSizeMatches(config.size, sourceSize)) throw new Error("选区合成需要保持原图比例，请在出图设置中选择跟随底图画幅或相同比例；尚未提交。");
    const original = source.storageKey ? { storageKey: source.storageKey } : await uploadImage(sourceUrl); assertCurrent();
    const guideBlob = await createSelectionGuide(sourceUrl, selectionUrl); assertCurrent();
    const guide = await uploadImage(guideBlob); assertCurrent();
    const preparedReferences = [...references, { ...guideReference, dataUrl: guide.url, storageKey: guide.storageKey, bytes: guide.bytes, width: guide.width, height: guide.height }];
    const preparedValidation = validateImageReferences(config.model || config.imageModel, preparedReferences, profile);
    if (!preparedValidation.valid) throw new Error(preparedValidation.message || "选区示意图不可用于当前模型；尚未提交。");
    return {
        config: { ...config, count: "1" }, references: preparedReferences,
        regionComposite: { mode: "selection-composite", source: { imageId: source.id, storageKey: original.storageKey, ...sourceSize }, selection: { storageKey: selection.selection.storageKey, ...selectionSize } },
        promptPrefix: `附加的输入图${preparedReferences.length}是输入图1的蓝色选区示意，仅用于定位允许修改的区域，不是配色或款式参考。只修改该选区，保持输入图1的画幅、主体位置和选区外内容；不要把蓝色标记画进结果。`,
    };
}

export async function restoreChatMaskResult(pending: { requestId: string; maskAdaptation?: CanvasMaskAdaptation; regionComposite?: ChatRegionComposite }, resultUrl: string) {
    if (pending.regionComposite) {
        const region = pending.regionComposite;
        if (pending.maskAdaptation || region.mode !== "selection-composite" || !region.source?.imageId || !region.source.storageKey || !region.selection?.storageKey
            || ![region.source.width, region.source.height].every(value => Number.isSafeInteger(value) && value > 0)
            || region.selection.width !== region.source.width || region.selection.height !== region.source.height) throw new Error("选区合成记录不完整或坐标不匹配，已保留原任务，不展示未受保护的整图结果。");
        const [sourceUrl, selectionUrl] = await Promise.all([imageToDataUrl({ storageKey: region.source.storageKey }), imageToDataUrl({ storageKey: region.selection.storageKey })]);
        if (!sourceUrl || !selectionUrl) throw new Error("原图或局部选区暂不可用，已保留原任务；恢复素材后查询，不会重新生成。");
        const [sourceSize, selectionSize] = await Promise.all([readCanvasMaskImageSize(sourceUrl), readCanvasMaskImageSize(selectionUrl)]);
        if ([sourceSize, selectionSize].some(size => size.width !== region.source.width || size.height !== region.source.height)) throw new Error("原图或选区尺寸与保存记录不符，已保留原任务，不展示错位合成结果。");
        const blob = await compositeSelectedImage(sourceUrl, resultUrl, selectionUrl);
        if (blob.type !== "image/png") throw new Error("选区合成没有返回无损 PNG，已保留原任务，不展示未验证的结果。");
        return readFileAsDataUrl(new File([blob], "选区合成.png", { type: "image/png" }));
    }
    if (!pending.maskAdaptation) return Promise.resolve(resultUrl);
    return restoreCanvasMaskResult({ id: pending.requestId, type: CanvasNodeType.Image, title: "局部修改", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { maskAdaptation: pending.maskAdaptation } }, resultUrl);
}
