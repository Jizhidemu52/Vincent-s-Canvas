import type { ConversationImageItem } from "@/components/conversation-image-controls";

export type ImageMentionToken = { start: number; end: number; query: string };
export function imageMentionAt(value: string, caret: number): ImageMentionToken | null {
    if (!Number.isInteger(caret) || caret < 0 || caret > value.length) return null;
    const match = /@([^\s@]*)$/u.exec(value.slice(0, caret));
    return match ? { start: match.index, end: caret, query: match[1] } : null;
}
export function filterMentionImages(images: readonly ConversationImageItem[], query: string) {
    const term = query.trim().toLocaleLowerCase();
    return images.filter(image => !term || `${image.label} ${image.name}`.toLocaleLowerCase().includes(term));
}
export function insertImageMention(value: string, token: ImageMentionToken, label: string) {
    const prefix = value.slice(0, token.start), suffix = value.slice(token.end);
    const inserted = `@${label}${/^\s/u.test(suffix) ? "" : " "}`;
    return { value: prefix + inserted + suffix, caret: prefix.length + inserted.length };
}
