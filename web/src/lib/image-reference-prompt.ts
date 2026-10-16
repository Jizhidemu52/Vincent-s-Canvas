import type { ReferenceImage } from "@/types/image";

export function imageReferenceLabel(index: number) {
    return `图片${index + 1}`;
}

export function buildImageReferencePromptText(prompt: string, references: ReferenceImage[], language: "zh" | "en" = "zh") {
    const text = prompt.trim();
    if (!references.length) return text;
    if (language === "en") return `Reference images in the supplied order: ${references.map((_, index) => `Image ${index + 1}`).join(", ")}. Interpret all image references using these numbers.\n\n${text}`;
    const labels = references.map((_, index) => imageReferenceLabel(index));
    return `参考图片编号：${labels.join("、")}。请按这些编号理解提示词中的图片引用。\n\n${text}`;
}
