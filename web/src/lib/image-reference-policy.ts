import type { ImageReferenceItem, ImageReferenceOrigin, ReferenceImage } from "@/types/image";
import { imageModelProfile } from "./image-model-settings";

export type ImageReferenceValidation = {
    valid: boolean;
    message?: string;
    minimum: number;
    maximum: number;
    supportsReferences: boolean;
};

export function referencePolicyForModel(modelId: string): Omit<ImageReferenceValidation, "valid" | "message"> & { label: string } {
    const normalized = modelId.trim().toLowerCase();
    const profile = imageModelProfile(modelId);
    if (profile.kind === "midjourney-blend") return { label: "Midjourney Blend", minimum: 2, maximum: 4, supportsReferences: true };
    if (profile.kind === "midjourney") return { label: "当前工作台的 Midjourney 参考图", minimum: 0, maximum: 16, supportsReferences: true };
    if (profile.kind === "gpt") return { label: "APIMart GPT-Image-2", minimum: 0, maximum: 15, supportsReferences: true };
    if (profile.kind === "gemini") return { label: "Gemini 3.1 Flash", minimum: 0, maximum: 14, supportsReferences: true };
    if (normalized.includes("gpt-image-2")) return { label: "GPT-Image-2", minimum: 0, maximum: 16, supportsReferences: true };
    return { label: "当前模型", minimum: 0, maximum: 16, supportsReferences: true };
}

export function validateImageReferences(modelId: string, references: ReferenceImage[]): ImageReferenceValidation {
    const policy = referencePolicyForModel(modelId);
    if (!policy.supportsReferences && references.length) return { ...policy, valid: false, message: "当前模型不支持参考图，请移除参考图或切换模型。" };
    if (references.length < policy.minimum || references.length > policy.maximum) {
        const range = policy.minimum === policy.maximum ? `${policy.maximum}` : `${policy.minimum} 至 ${policy.maximum}`;
        return { ...policy, valid: false, message: `${policy.label} 需要 ${range} 张参考图。` };
    }
    return { ...policy, valid: true };
}

export function dedupeImageReferences(references: ImageReferenceItem[]) {
    const seen = new Set<string>();
    return references.filter((reference) => {
        const identity = imageReferenceIdentity(reference);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

export function moveImageReference<T>(references: T[], fromIndex: number, toIndex: number) {
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= references.length || toIndex >= references.length || fromIndex === toIndex) return references;
    const next = [...references];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    return next;
}

export function imageReferenceIdentity(reference: ImageReferenceItem) {
    if (reference.storageKey) return `storage:${reference.storageKey}`;
    if (reference.url && !reference.url.startsWith("data:")) return `url:${reference.url}`;
    if (reference.dataUrl && !reference.dataUrl.startsWith("data:")) return `url:${reference.dataUrl}`;
    if (reference.sourceAssetId) return `asset:${reference.sourceAssetId}`;
    return `reference:${reference.referenceKey}`;
}

export function createImageReferenceItem(reference: ReferenceImage, origin: ImageReferenceOrigin): ImageReferenceItem {
    return {
        ...reference,
        referenceKey: `${origin}:${reference.id}`,
        origin,
        originLabel: referenceOriginLabel(origin),
    };
}

function referenceOriginLabel(origin: ImageReferenceOrigin) {
    if (origin === "asset") return "素材库";
    if (origin === "canvas") return "画布";
    if (origin === "connection") return "已连接";
    if (origin === "clipboard") return "剪切板";
    if (origin === "generated") return "生成结果";
    if (origin === "template") return "模板";
    return "上传";
}
