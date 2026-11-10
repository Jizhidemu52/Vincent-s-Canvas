import type { ReferenceImage } from "@/types/image";

export function imageReferenceLabel(index: number) {
    return `图片${index + 1}`;
}

export function buildImageReferencePromptText(prompt: string, references: ReferenceImage[], language: "zh" | "en" = "zh") {
    if (!references.length) return prompt;
    const roles = references.flatMap((image, index) => image.role?.trim() ? [`${language === "en" ? `Image ${index + 1}` : imageReferenceLabel(index)}：${image.role}`] : []);
    const purpose = roles.length ? `\n${roles.join("\n")}` : "";
    if (language === "en") return `Reference images in the supplied order: ${references.map((_, index) => `Image ${index + 1}`).join(", ")}. Interpret all image references using these numbers.${purpose}\n\n${prompt}`;
    const labels = references.map((_, index) => imageReferenceLabel(index));
    return `参考图片编号：${labels.join("、")}。请按这些编号理解提示词中的图片引用。${purpose}\n\n${prompt}`;
}

/** Shared by the send path and the read-only preview. Mask/markup are never passed here. */
export function buildDirectImagePrompt(config: { systemPrompt?: string }, prompt: string, references: ReferenceImage[] = [], language: "zh" | "en" = "zh") {
    const text = buildImageReferencePromptText(prompt, references, language);
    return config.systemPrompt?.trim() ? `${config.systemPrompt}\n\n${text}` : text;
}

export const imageReferenceRoleOptions = [
    "以此图作为编辑原图。", "参考此图中的主体。", "只参考此图的颜色。", "只参考此图的图案。",
    "只参考此图的材质。", "只参考此图的版型或结构。", "只参考此图的构图或位置。", "只参考此图的风格。",
];

/** Applied only when importing/restoring a complete input; reordering never reassigns roles. */
export function initializeImageReferenceRoles<T extends ReferenceImage>(references: T[], mode: "generate" | "edit"): T[] {
    return references.map((image, index) => image.role === undefined ? { ...image, role: index === 0 ? mode === "edit" ? imageReferenceRoleOptions[0] : imageReferenceRoleOptions[1] : "" } : image);
}

export function imageReferenceRoles(references: ReferenceImage[]) {
    return references.map(image => image.role || "用途未指定，按用户原文使用此图。");
}

export function imageReferencesMatch(left: ReferenceImage[], right: ReferenceImage[]) {
    return left.length === right.length && left.every((image, index) => {
        const other = right[index];
        return Boolean(other && image.id === other.id && image.name === other.name && image.role === other.role && image.dataUrl === other.dataUrl && image.url === other.url && image.storageKey === other.storageKey && image.sourceAssetId === other.sourceAssetId);
    });
}
