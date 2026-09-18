import type { PublicModel } from "@/services/api/business-config";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { isAdminRole, useUserStore } from "@/stores/use-user-store";

type DisplayModel = Pick<PublicModel, "id" | "modelId" | "name" | "capabilities"> & { publicName?: string; modelIdentityHidden?: boolean };
const legacyImageName = /(?:gpt[-_ ]?image[-\w.]*|(?:open|vcen)[- ]gpt2|gemini[-\w. ]*image(?:[-\w.]*)?|nano[- ]banana[-\w.]*|midjourney(?:[- ]blend)?|dall[- ]?e[-\w.]*|seedream[-\w.]*|flux[-\w.]*|stable[- ]diffusion[-\w.]*)/gi;
const rawName = (value: string) => value.includes("::") ? value.slice(value.indexOf("::") + 2) : value;

export function isImageDisplayModel(model: DisplayModel) {
    return model.capabilities.some(item => ["generate", "edit", "upscale", "remove_background", "batch"].includes(item))
        && !model.capabilities.some(item => ["chat", "video", "audio"].includes(item));
}

export function imageModelIdentityHidden(value: string, models: readonly DisplayModel[] = useBusinessConfigStore.getState().models, role = useUserStore.getState().user?.role) {
    if (isAdminRole(role)) return false;
    const name = rawName(value);
    const model = models.find(item => [item.id, item.modelId, item.name, item.publicName].includes(name));
    return Boolean(model && isImageDisplayModel(model)) || new RegExp(legacyImageName.source, "i").test(name) || /^出图模型/.test(name);
}

/** Presentation only. Never use a display label to choose a provider adapter. */
export function imageModelDisplayName(value: string, models: readonly DisplayModel[] = useBusinessConfigStore.getState().models, role = useUserStore.getState().user?.role) {
    const name = rawName(value);
    const model = models.find(item => [item.id, item.modelId, item.name, item.publicName].includes(name));
    if (isAdminRole(role)) return model?.name || value;
    if (model && isImageDisplayModel(model)) {
        return model.publicName || (/^出图模型\d+$/.test(model.name) ? model.name : "出图模型");
    }
    return imageModelIdentityHidden(value, models, role) ? (/^出图模型/.test(name) ? name : "出图模型（旧记录）") : value;
}

export function maskImageModelText(text: string, models: readonly DisplayModel[] = useBusinessConfigStore.getState().models, role = useUserStore.getState().user?.role) {
    if (isAdminRole(role)) return text;
    let result = text;
    for (const model of models.filter(isImageDisplayModel)) {
        for (const name of [model.modelId, model.name].filter(Boolean).sort((a, b) => b.length - a.length)) {
            result = result.split(name).join(imageModelDisplayName(model.id, models, role));
        }
    }
    return result.replace(legacyImageName, "出图模型");
}

/** Hide system model metadata in previews/exports without altering user prompts. */
export function displayModelMetadata<T>(value: T, models: readonly DisplayModel[] = useBusinessConfigStore.getState().models, role = useUserStore.getState().user?.role, preserveOpaqueIds = false): T {
    if (isAdminRole(role)) return value;
    const visit = (item: unknown, key = ""): unknown => {
        if (typeof item === "string") {
            if (["model", "modelId", "modelName", "imageModel", "imageModelId", "models", "imageModels"].includes(key)) {
                const model = models.find(model => [model.id, model.modelId, model.name, model.publicName].includes(rawName(item)));
                if (preserveOpaqueIds && key !== "modelName" && model && isImageDisplayModel(model)) return model.id;
                return imageModelDisplayName(item, models, role);
            }
            if (["meta", "failureReason", "error", "errorMessage"].includes(key)) return maskImageModelText(item, models, role);
            return item;
        }
        if (Array.isArray(item)) return item.map(child => visit(child, key));
        if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([childKey, child]) => [childKey, visit(child, childKey)]));
        return item;
    };
    return visit(value) as T;
}

export function exportModelMetadata<T>(value: T): T {
    return displayModelMetadata(value, undefined, undefined, true);
}
