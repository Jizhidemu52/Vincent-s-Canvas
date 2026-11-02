import { resolveCompletePrompt } from "@/lib/prompt-template-reuse";
import { promptImageSettings } from "@/lib/prompt-editor-parameters";
import { fetchServerAsset } from "@/services/api/server-assets";
import { uploadImage } from "@/services/image-storage";
import type { PromptReusePayload } from "@/services/api/prompts";
import type { CanvasNodeMetadata, CanvasStoredImageReference } from "@/types/canvas";

/** Restore executable settings, not only the template's display/provenance fields. */
export function canvasPromptTemplateMetadata(payload: PromptReusePayload, references: CanvasStoredImageReference[]): Partial<CanvasNodeMetadata> {
    const { template } = payload;
    const model = payload.pricing.selectedModel?.modelId || template.modelSnapshot.modelId;
    const parameters = template.parameters;
    const value = (...keys: string[]) => {
        const entry = keys.map(key => parameters[key]).find(item => item !== undefined && item !== null);
        return typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" ? String(entry) : undefined;
    };
    const video = template.targetTool === "video";
    const imageSettings = video ? undefined : promptImageSettings(parameters, model || "");
    return {
        prompt: template.prompt, composerContent: template.prompt, draftPrompt: template.prompt,
        generationMode: video ? "video" : "image", model, count: 1,
        ...(imageSettings ? { size: imageSettings.size, quality: imageSettings.quality, imageOptions: imageSettings.imageOptions } : {
            size: value("size", "aspect_ratio"), seconds: value("videoSeconds", "seconds", "duration"),
            videoMode: value("videoMode", "mode"), vquality: value("vquality", "resolution"),
            generateAudio: value("videoGenerateAudio", "generateAudio", "generate_audio"),
            watermark: value("videoWatermark", "watermark"),
        }),
        systemPrompt: value("systemPrompt", "system_prompt"),
        configImageInputMode: "combined", manualImageReferences: references,
        imageReferenceOrder: references.map(item => item.referenceKey),
        promptTemplateSource: {
            templateId: template.id, versionId: template.currentVersionId, version: template.version,
            title: template.title, targetTool: template.targetTool, modelConfigId: template.modelConfigId,
            modelSnapshot: template.modelSnapshot, parameters: template.parameters,
            referenceAssetIds: template.referenceAssetIds, sourceTaskId: template.sourceTaskId, sourceAssetId: template.sourceAssetId,
            resolvedModel: payload.pricing.selectedModel, warnings: payload.warnings,
        },
    };
}

/** Read and hydrate everything before touching a canvas. Never starts generation. */
export async function loadCanvasPromptTemplate(templateId: string, assertCurrent: () => void) {
    const payload = await resolveCompletePrompt(templateId, "fill", assertCurrent);
    assertCurrent();
    if (!payload.template.prompt.trim()) throw new Error("模板提示词为空，画布未修改");
    const references: CanvasStoredImageReference[] = [];
    for (const id of payload.template.referenceAssetIds) {
        assertCurrent();
        const { asset } = await fetchServerAsset(id);
        assertCurrent();
        if (asset.kind !== "image" || asset.status !== "ready") throw new Error("模板参考图不可用，请先修复模板素材；画布尚未修改。");
        const image = await uploadImage(asset.contentUrl || `/api/assets/${encodeURIComponent(id)}/content`);
        assertCurrent();
        references.push({ id, referenceKey: `asset:${id}`, name: asset.filename || "模板参考图", type: image.mimeType, content: image.url, storageKey: image.storageKey, origin: "asset" });
    }
    return { payload, metadata: canvasPromptTemplateMetadata(payload, references) };
}
