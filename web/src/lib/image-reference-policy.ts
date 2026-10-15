import type { ImageReferenceItem, ImageReferenceOrigin, ReferenceImage } from "@/types/image";
import { imageModelProfile } from "./image-model-settings";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

export type ImageReferenceValidation = {
    valid: boolean;
    message?: string;
    minimum: number;
    maximum: number;
    supportsReferences: boolean;
};

export function referencePolicyForModel(modelId: string, profile = imageModelProfile(modelId)): Omit<ImageReferenceValidation, "valid" | "message"> & { label: string } {
    const normalized = modelId.trim().toLowerCase();
    const label = (name: string) => isAdminRole(useUserStore.getState().user?.role) ? name : "当前模型";
    if (profile.kind === "quality-resolution") return { label: label("当前出图模型"), minimum: 0, maximum: 16, supportsReferences: true };
    if (profile.kind === "resolution-1k") return { label: "当前工作台（应用限制，并非渠道固定上限）", minimum: 0, maximum: 16, supportsReferences: true };
    if (profile.kind === "grok-image") return { label: label("Grok Image 2"), minimum: 0, maximum: 3, supportsReferences: true };
    if (profile.kind === "midjourney-blend") return { label: label("Midjourney Blend"), minimum: 2, maximum: 4, supportsReferences: true };
    if (profile.kind === "midjourney") return { label: label("当前工作台的 Midjourney 参考图"), minimum: 0, maximum: 16, supportsReferences: true };
    if (profile.kind === "gpt") return { label: label("APIMart GPT-Image-2"), minimum: 0, maximum: 15, supportsReferences: true };
    if (profile.kind === "gemini") return { label: label("Gemini 3.1 Flash"), minimum: 0, maximum: 14, supportsReferences: true };
    if (normalized.includes("gpt-image-2")) return { label: label("GPT-Image-2"), minimum: 0, maximum: 16, supportsReferences: true };
    return { label: "当前模型", minimum: 0, maximum: 16, supportsReferences: true };
}

export function validateImageReferences(modelId: string, references: ReferenceImage[], profile?: ReturnType<typeof imageModelProfile>): ImageReferenceValidation {
    const policy = referencePolicyForModel(modelId, profile);
    if (!policy.supportsReferences && references.length) return { ...policy, valid: false, message: "当前模型不支持参考图，请移除参考图或切换模型。" };
    if (references.length < policy.minimum || references.length > policy.maximum) {
        const range = policy.minimum === policy.maximum ? `${policy.maximum}` : `${policy.minimum} 至 ${policy.maximum}`;
        return { ...policy, valid: false, message: `${policy.label} 需要 ${range} 张参考图。` };
    }
    const kind = (profile || imageModelProfile(modelId)).kind;
    if (kind === "grok-image" || kind === "gemini" || kind === "midjourney-blend") {
        const maximumBytes = (kind === "midjourney-blend" ? 12 : 10) * 1024 * 1024;
        for (const reference of references) {
            const dataMatch = /^data:([^;,]+);base64,(.*)$/s.exec(reference.dataUrl || "");
            const bytes = reference.bytes ?? (dataMatch ? Math.floor(dataMatch[2]!.length * 3 / 4) - (dataMatch[2]!.endsWith("==") ? 2 : dataMatch[2]!.endsWith("=") ? 1 : 0) : undefined);
            if (bytes !== undefined && bytes > maximumBytes) return { ...policy, valid: false, message: `参考图 ${reference.name} 超过单张 ${maximumBytes / 1024 / 1024} MiB 上限。` };
            const mime = reference.type || dataMatch?.[1];
            if (kind !== "midjourney-blend" && mime && !["image/jpeg", "image/png", "image/webp"].includes(mime.toLowerCase())) return { ...policy, valid: false, message: `参考图 ${reference.name} 格式不支持，请使用 JPEG、PNG 或 WebP。` };
        }
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
