import { localProcessingParametersSchema, type LocalProcessingRecord } from "../../../../shared/local-processing-contracts";
import { archiveLocalProcessing, compositeOperationId, type LocalProcessingArchive } from "@/services/api/local-processing";
import { fingerprintImage } from "@/services/api/generation-history";
import { assertHistoryOwner, historyAssetPath, readHistoryOriginal } from "@/services/api/generation-task-history";
import { uploadImageReference } from "@/services/api/generation-tasks";
import { getImageBlob } from "@/services/image-storage";
import { rememberMediaSource, rememberUploadedMedia, serverMediaId } from "@/services/canvas-media-links";
import { imageMarkupReference, readImageOptions } from "@/lib/image-advanced-settings";
import type { ReferenceImage } from "@/types/image";
import type { RecolorRule } from "./image-processing";
import { cloneSceneForm, type SceneForm } from "./scene-form-model";
import type { SceneImage, SceneParameters } from "./use-scene-workspace";

export type RecolorArchiveSettings = { rules: RecolorRule[]; tolerance: number };
export type SceneFinalSave = { clientOperationId: string; operation: "recolor" | "selection-composite"; prompt?: string; recolor?: RecolorArchiveSettings };

export async function readSceneImageBlob(image: ReferenceImage & { inputSha256?: string }, ownerId: string): Promise<Blob> {
    assertHistoryOwner(ownerId);
    let blob: Blob | null = null;
    try { blob = image.storageKey ? await getImageBlob(image.storageKey) : null; } catch { }
    assertHistoryOwner(ownerId);
    if (!blob) {
        const path = historyAssetPath(image.dataUrl) || (image.sourceAssetId ? `/api/assets/${image.sourceAssetId}/content` : null);
        if (path) blob = await readHistoryOriginal(path, ownerId);
        else if (/^(?:blob:|data:image\/)/i.test(image.dataUrl)) {
            const response = await fetch(image.dataUrl, { credentials: "omit", redirect: "error" });
            if (!response.ok) throw new Error(`原件“${image.name}”暂时无法读取`);
            blob = await response.blob();
        } else throw new Error(`原件“${image.name}”没有可读取的本机或公司地址`);
    }
    assertHistoryOwner(ownerId);
    if (!blob.size || !blob.type.startsWith("image/")) throw new Error(`原件“${image.name}”不是有效图片`);
    if (image.inputSha256 && await fingerprintImage(blob) !== image.inputSha256) throw new Error(`原件“${image.name}”与保存的输入字节不一致，未归档最终成果`);
    assertHistoryOwner(ownerId);
    return blob;
}

async function ensureSource(image: ReferenceImage & { inputSha256?: string }, ownerId: string, expectedType?: string) {
    const blob = await readSceneImageBlob(image, ownerId);
    if (expectedType && blob.type !== expectedType) throw new Error("标注层原件不是独立透明 PNG，未保存不完整记录");
    const hash = await fingerprintImage(blob);
    assertHistoryOwner(ownerId);
    return uploadImageReference(image, new File([blob], image.name || "处理原件.png", { type: blob.type }), hash, ownerId);
}

export async function freezeSceneSource(image: SceneImage, ownerId: string): Promise<SceneImage> {
    const blob = await readSceneImageBlob(image, ownerId);
    const inputSha256 = await fingerprintImage(blob);
    const sourceAssetId = await uploadImageReference(image, new File([blob], image.name || "处理原件.png", { type: blob.type }), inputSha256, ownerId);
    assertHistoryOwner(ownerId);
    const dataUrl = `/api/assets/${sourceAssetId}/content`;
    return { ...image, inputSha256, sourceAssetId, dataUrl, url: dataUrl, storageKey: undefined };
}

function assertSafeParameterValues(value: unknown, depth = 0): void {
    if (depth > 8) throw new Error("处理参数嵌套过深，未保存不完整记录");
    if (typeof value === "string") {
        const text = value.trim();
        if (/^(?:blob:|data:|file:|filesystem:|[a-z]:[\\/]|\\\\)/i.test(text)) throw new Error("处理参数不能包含本机地址");
        if (/^https?:\/\//i.test(text)) {
            const url = new URL(text), host = url.hostname.toLowerCase();
            if (url.username || url.password || /^(?:localhost|\[::1\]|0\.0\.0\.0|127\.[\d.]+|10\.[\d.]+|192\.168\.[\d.]+|172\.(?:1[6-9]|2\d|3[01])\.[\d.]+)$/.test(host)) throw new Error("处理参数不能包含本机地址或凭据");
        }
        if (/^[{[\"]/.test(text)) {
            let parsed: unknown;
            try { parsed = JSON.parse(text); } catch { return; }
            if (!localProcessingParametersSchema.safeParse({ config: { value: parsed } }).success) throw new Error("处理参数不能包含凭据或本机地址");
            assertSafeParameterValues(parsed, depth + 1);
        }
    } else if (value && typeof value === "object") {
        for (const item of Object.values(value)) assertSafeParameterValues(item, depth + 1);
    }
}

async function archivedSceneParameters(form: SceneForm, config: SceneParameters, ownerId: string) {
    const options: Record<string, unknown> = { ...readImageOptions(config.imageOptions) };
    const markup = imageMarkupReference(config.imageOptions);
    delete options.markup_reference;
    if (typeof options.metadata === "string" && options.metadata.trim()) {
        try { options.metadata = JSON.parse(options.metadata); } catch { throw new Error("任务附加信息不是有效 JSON，未保存不完整记录"); }
        if (!options.metadata || typeof options.metadata !== "object" || Array.isArray(options.metadata)) throw new Error("任务附加信息必须是 JSON 对象");
    }
    const parameters = { form: cloneSceneForm(form), config: { model: config.model, imageModel: config.imageModel, size: config.size, quality: config.quality, count: config.count,
        ...(config.imageOptions !== undefined ? { imageOptions: options } : {}) } };
    if (!localProcessingParametersSchema.safeParse(parameters).success) throw new Error("处理参数必须是完整的安全 JSON，不能包含本机地址或凭据");
    assertSafeParameterValues(parameters);
    const sourceAssetIds: string[] = [];
    if (markup) {
        const sourceAssetId = await ensureSource(markup, ownerId, "image/png");
        options.markup_reference = { sourceAssetId, name: markup.name, type: markup.type,
            ...(markup.width !== undefined ? { width: markup.width } : {}), ...(markup.height !== undefined ? { height: markup.height } : {}), ...(markup.bytes !== undefined ? { bytes: markup.bytes } : {}) };
        sourceAssetIds.push(sourceAssetId);
    }
    if (!localProcessingParametersSchema.safeParse(parameters).success) throw new Error("标注层参数不完整，未保存处理记录");
    assertSafeParameterValues(parameters);
    return { parameters, sourceAssetIds };
}

export function selectionFinalSave(taskId: string, source: SceneImage): SceneFinalSave {
    const assetId = source.sourceAssetId || serverMediaId(source.dataUrl);
    if (!assetId) throw new Error("原任务结果没有公司素材编号，不能归档最终合成图");
    return { clientOperationId: compositeOperationId(taskId, assetId), operation: "selection-composite" };
}

export async function saveSceneFinalImage(input: {
    final: SceneImage; finalBlob?: Blob; original: SceneImage; mask?: SceneImage; raw?: SceneImage;
    taskId?: string; prompt: string; form: SceneForm; config: SceneParameters; save: SceneFinalSave; ownerId: string;
}): Promise<{ image: SceneImage; record: LocalProcessingRecord }> {
    assertHistoryOwner(input.ownerId);
    const { parameters, sourceAssetIds } = await archivedSceneParameters(input.form, input.config, input.ownerId);
    const sourceAssetId = await ensureSource(input.original, input.ownerId);
    const prompt = input.save.prompt || input.prompt;
    let archive: LocalProcessingArchive;
    if (input.save.operation === "recolor") {
        if (!input.save.recolor) throw new Error("精确换色缺少原始颜色映射，不能保存不完整记录");
        archive = { clientOperationId: input.save.clientOperationId, board: "creative-pattern-colorway", operation: "recolor",
            prompt, parameters: { ...parameters, recolor: input.save.recolor }, sourceAssetIds: [...new Set([sourceAssetId, ...sourceAssetIds])] };
    } else {
        const rawAssetId = input.raw?.sourceAssetId || serverMediaId(input.raw?.dataUrl || "");
        if (!input.taskId || !input.mask || !rawAssetId) throw new Error("最终合成缺少原任务、选区或原始结果，不能保存不完整记录");
        const maskAssetId = await ensureSource(input.mask, input.ownerId);
        archive = { clientOperationId: input.save.clientOperationId, board: "creative-local-restyle", operation: "selection-composite",
            prompt, parameters: { ...parameters, selection: { sourceAssetId, maskAssetId } },
            sourceAssetIds: [...new Set([sourceAssetId, maskAssetId, rawAssetId, ...sourceAssetIds])], sourceTaskId: input.taskId };
    }
    const blob = input.finalBlob || await readSceneImageBlob(input.final, input.ownerId);
    const record = await archiveLocalProcessing(new File([blob], input.final.name || "处理最终成果.png", { type: blob.type }), archive, input.ownerId);
    assertHistoryOwner(input.ownerId);
    if (input.final.storageKey) {
        await Promise.allSettled([rememberMediaSource(input.final.storageKey, record.contentUrl), rememberUploadedMedia(input.ownerId, input.final.storageKey, record.contentUrl)]);
        assertHistoryOwner(input.ownerId);
    }
    return { image: { ...input.final, sourceAssetId: record.outputAssetId, dataUrl: record.contentUrl, url: record.contentUrl }, record };
}
