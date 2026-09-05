export type ChatContextMessage = {
    role: "user" | "assistant";
    content: string;
};

export const MAX_CHAT_CONTEXT_MESSAGES = 24;
export const MAX_CHAT_CONTEXT_CHARACTERS = 48_000;

/** Keeps persisted history intact while bounding only the next model request. */
export function latestChatContext(
    messages: ChatContextMessage[],
    maxMessages = MAX_CHAT_CONTEXT_MESSAGES,
    maxCharacters = MAX_CHAT_CONTEXT_CHARACTERS,
) {
    const selected: ChatContextMessage[] = [];
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
