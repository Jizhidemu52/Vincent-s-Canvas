import type { ConversationImageItem } from "@/components/conversation-image-controls";
import { createImageReferenceItem } from "@/lib/image-reference-policy";
import type { ImageReferenceItem } from "@/types/image";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";

export type CanvasConfigMentionInput = NodeGenerationInput & { mentionImage?: ConversationImageItem; mentionSource?: "canvas" | "conversation"; mentionLabel?: string };

export function canvasMentionImageIndex(references: readonly ImageReferenceItem[], image: ConversationImageItem) {
    const nodeId = image.source === "canvas" ? image.id.replace(/^canvas:/, "") : `conversation:${image.id}`;
    return references.findIndex(reference => (image.source === "canvas" && reference.id === nodeId)
        || Boolean(image.storageKey && reference.storageKey === image.storageKey)
        || Boolean(image.dataUrl && reference.dataUrl === image.dataUrl));
}

/** Add a stored reference explicitly, never a hidden canvas node or paid task. */
export function appendCanvasMentionImage(references: readonly ImageReferenceItem[], image: ConversationImageItem, maximum = 16, scopeKey = "") {
    const existing = canvasMentionImageIndex(references, image);
    if (existing >= 0) return { references: [...references], reference: references[existing]!, index: existing, added: false };
    if (references.length >= maximum || image.unavailableReason || (!image.dataUrl && !image.storageKey)) return null;
    const id = image.source === "canvas" ? image.id.replace(/^canvas:/, "") : `conversation:${scopeKey ? `${scopeKey}:` : ""}${image.id}`;
    const reference = { ...createImageReferenceItem({ id, name: image.name, type: "image/png", dataUrl: image.dataUrl || "", storageKey: image.storageKey }, image.source === "canvas" ? "canvas" : "upload"),
        referenceKey: image.source === "conversation" ? id : `canvas:${id}`, originLabel: image.source === "conversation" ? "对话图片" : "画布图片" };
    return { references: [...references, reference], reference, index: references.length, added: true };
}

/** Only unselected images need an explicit import; existing graph aliases remain unchanged. */
export function configMentionInputs(inputs: NodeGenerationInput[], references: readonly ImageReferenceItem[], images: readonly ConversationImageItem[], labels?: Record<string, string>, imageOffset = 0): CanvasConfigMentionInput[] {
    const result: CanvasConfigMentionInput[] = inputs.map(input => {
        if (input.type !== "image") return input;
        const image = input.image && images.find(item => canvasMentionImageIndex([input.image as ImageReferenceItem], item) >= 0);
        return { ...input, mentionSource: image?.source || (input.nodeId.startsWith("conversation:") ? "conversation" : "canvas"), mentionLabel: labels?.[input.nodeId] || `图${inputs.filter(item => item.type === "image").indexOf(input) + imageOffset + 1}` };
    });
    for (const image of images) {
        // In per-image mode connected task inputs are not fixed common references.
        if (canvasMentionImageIndex(references, image) >= 0) continue;
        if (result.some(input => input.image && canvasMentionImageIndex([input.image as ImageReferenceItem], image) >= 0)) continue;
        result.push({ nodeId: `mention:${image.source}:${image.id}`, type: "image", title: image.name,
            image: { id: image.id, name: image.name, type: "image/png", dataUrl: image.dataUrl || "", storageKey: image.storageKey },
            mentionImage: image, mentionSource: image.source || "conversation", mentionLabel: `图${inputs.filter(item => item.type === "image").length + imageOffset + 1} · 添加` });
    }
    return [...result.filter(input => input.type !== "image"), ...result.filter(input => input.type === "image" && input.mentionSource === "canvas"), ...result.filter(input => input.type === "image" && input.mentionSource !== "canvas")];
}
