import type { ConversationImageItem } from "@/components/conversation-image-controls";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";
import { canvasImageEditContext, type CanvasImageEditLineage, type CanvasImageEditTarget } from "./canvas-assistant-image-edit";

export type CanvasConversationImage = ConversationImageItem & {
    messageId: string;
    referenceIndex?: number;
    attachmentId?: string;
    reference: CanvasAssistantReference;
};

type ImageSource = { id: string; storageKey?: string; dataUrl?: string; url?: string };
const sourceKey = (image: ImageSource) => image.storageKey || image.dataUrl || image.url || "";

/** Build from the full saved conversation, never its deferred/virtualized render window. */
export function canvasConversationImages(messages: CanvasAssistantMessage[]): CanvasConversationImage[] {
    const images: CanvasConversationImage[] = [];
    for (const message of messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        for (const [referenceIndex, reference] of (message.references || []).entries()) {
            if (reference.type !== CanvasNodeType.Image) continue;
            const key = sourceKey(reference);
            if (key && images.some(image => sourceKey(image) === key)) continue;
            images.push({ id: `chat-image:${message.id}:reference:${referenceIndex}:${reference.id}`, label: `图${images.length + 1}`, name: reference.title,
                dataUrl: reference.dataUrl, storageKey: reference.storageKey, messageId: message.id, referenceIndex, reference: { ...reference },
                ...(!key ? { unavailableReason: "图片素材已不可用" } : {}) });
        }
        if (message.role !== "assistant" || message.detail?.status !== "completed") continue;
        for (const attachment of message.attachments || []) {
            if (attachment.mediaType !== "image") continue;
            // Two results may share bytes but carry different requested targets. Keep their task identities.
            images.push({ id: `chat-image:${message.id}:result:${attachment.id}`, label: `图${images.length + 1}`, name: attachment.name,
                dataUrl: attachment.url, storageKey: attachment.storageKey, messageId: message.id, attachmentId: attachment.id,
                reference: { id: attachment.id, type: CanvasNodeType.Image, title: attachment.name, dataUrl: attachment.url, storageKey: attachment.storageKey },
                ...(!sourceKey(attachment) ? { unavailableReason: "图片素材已不可用" } : {}) });
        }
    }
    return images;
}

export function canvasConversationImageForAsset(images: CanvasConversationImage[], messageId: string, source: ImageSource) {
    return images.find(image => image.messageId === messageId && (image.attachmentId || image.reference.id) === source.id && sourceKey(image) === sourceKey(source))
        || images.find(image => Boolean(sourceKey(source)) && sourceKey(image) === sourceKey(source));
}

export function canvasConversationImageLabels(images: CanvasConversationImage[], messages: CanvasAssistantMessage[]) {
    const labels = new Map<string, string>();
    for (const message of messages) for (const reference of [...(message.references || []), ...(message.contextReferences || []), ...(message.attachments || [])]) {
        const image = canvasConversationImageForAsset(images, message.id, reference);
        if (image) labels.set(`${message.id}:${reference.id}`, image.label);
    }
    return labels;
}

export function canvasConversationOriginals(image: CanvasConversationImage, messages: CanvasAssistantMessage[], catalog: CanvasConversationImage[]): ConversationImageItem[] {
    if (!image.attachmentId) return [];
    const lineage = messages.find(message => message.id === image.messageId)?.detail?.imageEdit as CanvasImageEditLineage | undefined;
    return (lineage?.originalReferences || []).map((reference, index) => {
        const existing = catalog.find(item => Boolean(sourceKey(reference)) && sourceKey(item) === sourceKey(reference));
        return { id: `original:${image.id}:${index}`, label: existing?.label || `原图${index + 1}`, name: reference.title,
            dataUrl: reference.dataUrl, storageKey: reference.storageKey, ...(!sourceKey(reference) ? { unavailableReason: "原图素材已不可用" } : {}) };
    });
}

/** Freeze one explicit UI choice together with its own task's saved contract and original assets. */
export function canvasConversationTarget(messages: CanvasAssistantMessage[], image: CanvasConversationImage, mode: "edit" | "original") {
    const messageIndex = messages.findIndex(message => message.id === image.messageId);
    if (messageIndex < 0 || image.unavailableReason || !sourceKey(image)) throw new Error("编辑目标已不可用，请重新选择图片");
    const source = messages[messageIndex]!;
    const actual = image.attachmentId ? source.attachments?.find(item => item.id === image.attachmentId && item.mediaType === "image")
        : source.references?.[image.referenceIndex ?? -1];
    if (!actual || sourceKey(actual) !== sourceKey(image)) throw new Error("编辑目标已变化，请重新选择图片");
    const context = image.attachmentId ? canvasImageEditContext(messages.slice(0, messageIndex + 1)) : canvasImageEditContext([]);
    if (image.attachmentId && !context.results.some(item => item.id === image.attachmentId)) throw new Error("编辑目标尚未完成，请重新选择图片");
    if (mode === "original" && (!context.originals.length || context.originals.some(item => !sourceKey(item)))) throw new Error("本任务没有保存可用原图，请补充原图后重做");
    const target: CanvasImageEditTarget = { mode, reference: { ...image.reference }, resultImageId: image.attachmentId };
    return { target, context };
}
