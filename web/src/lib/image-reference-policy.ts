import type { ImageReferenceItem } from "@/types/image";

export type ImageReferenceValidation = {
    valid: boolean;
    message?: string;
    minimum: number;
    maximum: number;
    supportsReferences: boolean;
};

export function referencePolicyForModel(modelId: string): Omit<ImageReferenceValidation, "valid" | "message"> & { label: string } {
    const normalized = modelId.trim().toLowerCase();
    if (normalized.includes("midjourney-blend")) return { label: "Midjourney Blend", minimum: 2, maximum: 4, supportsReferences: true };
    if (normalized === "midjourney" || normalized === "midjourney-v7") return { label: "Midjourney", minimum: 0, maximum: 0, supportsReferences: false };
    if (normalized.includes("gemini-3.1-flash") || normalized.includes("nano-banana-2")) return { label: "Gemini 3.1 Flash", minimum: 0, maximum: 14, supportsReferences: true };
    if (normalized.includes("gpt-image-2")) return { label: "GPT-Image-2", minimum: 0, maximum: 16, supportsReferences: true };
    return { label: "当前模型", minimum: 0, maximum: 16, supportsReferences: true };
}

export function validateImageReferences(modelId: string, references: ImageReferenceItem[]): ImageReferenceValidation {
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
