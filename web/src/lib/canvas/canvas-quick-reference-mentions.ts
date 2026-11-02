import type { ConversationImageItem } from "@/components/conversation-image-controls";
import type { ReferenceImage } from "@/types/image";

export function quickMentionReferenceIndex(references: readonly ReferenceImage[], image: ConversationImageItem) {
    return references.findIndex(reference => reference.id === image.id || reference.id === image.id.replace(/^canvas:/, "")
        || Boolean(reference.storageKey && reference.storageKey === image.storageKey)
        || Boolean(reference.dataUrl && reference.dataUrl === image.dataUrl));
}

/** Current tray labels take precedence over canvas/history catalog numbering. */
export function quickMentionImages(references: readonly ReferenceImage[], candidates: readonly ConversationImageItem[] = []): ConversationImageItem[] {
    const images = references.map((reference, index) => ({ id: reference.id, label: `图${index + 1}`, name: reference.name, dataUrl: reference.dataUrl, storageKey: reference.storageKey,
        source: candidates.find(image => quickMentionReferenceIndex([reference], image) === 0)?.source || "canvas" as const }));
    return [...images, ...candidates.filter(image => quickMentionReferenceIndex(references, image) < 0)];
}
