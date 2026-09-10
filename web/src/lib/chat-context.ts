import type { AiTextMessage } from "@/services/api/image";

export type ChatContextMessage = {
    role: "user" | "assistant";
    content: string;
};

export const MAX_CHAT_CONTEXT_MESSAGES = 24;
export const MAX_CHAT_CONTEXT_CHARACTERS = 48_000;
const MAX_CHAT_CONTEXT_IMAGES = 5;
const MAX_CHAT_CONTEXT_IMAGE_BYTES = 8 * 1024 * 1024;

export type ChatHistoryMessage = {
    role: "user" | "assistant" | "error";
    content: string;
    attachments?: Array<{ name: string; textContent?: string; dataUrl?: string }>;
};

function messageTextContent(message: ChatHistoryMessage) {
    const textFiles = message.attachments?.filter((item) => item.textContent).map((item) => `\n\n[附件：${item.name}]\n${item.textContent}`).join("") || "";
    return `${message.content}${textFiles}`;
}

function messageImages(message: ChatHistoryMessage) {
    return message.attachments?.flatMap((item) => item.dataUrl ? [item.dataUrl] : []) || [];
}

function boundedImages(urls: string[]) {
    const selected: string[] = [];
    let bytes = 0;
    for (const url of urls) {
        if (selected.length >= MAX_CHAT_CONTEXT_IMAGES) break;
        const comma = url.indexOf(",");
        const size = comma < 0 ? url.length : Math.ceil((url.length - comma - 1) * 0.75);
        if (bytes + size > MAX_CHAT_CONTEXT_IMAGE_BYTES) continue;
        selected.push(url);
        bytes += size;
    }
    return selected;
}

function messageContent(text: string, urls: string[]): AiTextMessage["content"] {
    const images = urls.map((url) => ({ type: "image_url" as const, image_url: { url } }));
    return images.length ? [{ type: "text" as const, text }, ...images] : text;
}

export function buildChatRequestMessages(history: ChatHistoryMessage[], current: ChatHistoryMessage): AiTextMessage[] {
    const context = latestChatContext(history
        .filter((message): message is ChatHistoryMessage & { role: "user" | "assistant" } => message.role === "user" || message.role === "assistant")
        .map((message) => ({ role: message.role, content: messageTextContent(message), images: message.role === "user" ? messageImages(message) : [] })));
    const currentImages = messageImages(current);
    // Keep only the latest image-bearing user turn inside the text window.
    // New image uploads replace that batch; document-only follow-ups do not.
    let retainedImageTurn = -1;
    if (!currentImages.length) {
        for (let index = context.length - 1; index >= 0; index -= 1) {
            if (context[index]!.images.length) { retainedImageTurn = index; break; }
        }
    }
    return [
        ...context.map((message, index) => ({ role: message.role, content: messageContent(message.content, index === retainedImageTurn ? boundedImages(message.images) : []) })),
        { role: "user", content: messageContent(messageTextContent(current), boundedImages(currentImages)) },
    ];
}

/** Keeps persisted history intact while bounding only the next model request. */
export function latestChatContext<T extends ChatContextMessage>(
    messages: T[],
    maxMessages = MAX_CHAT_CONTEXT_MESSAGES,
    maxCharacters = MAX_CHAT_CONTEXT_CHARACTERS,
) {
    const selected: T[] = [];
    let remaining = Math.max(0, Math.floor(maxCharacters));
    const messageLimit = Math.max(1, Math.floor(maxMessages));

    for (let index = messages.length - 1; index >= 0 && selected.length < messageLimit && remaining > 0; index -= 1) {
        const message = messages[index]!;
        const content = message.content || "";
        if (!content) continue;
        if (content.length <= remaining) {
            selected.push(message);
            remaining -= content.length;
            continue;
        }
        const marker = "[已截断]";
        const available = Math.max(0, remaining - marker.length);
        selected.push({ ...message, content: `${content.slice(0, available)}${marker}` });
        remaining = 0;
    }

    return selected.reverse();
}
