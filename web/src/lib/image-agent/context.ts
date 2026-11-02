import type { AiTextMessage } from "@/services/api/image";
import { selectImageAgentWorkingSet, type ImageAgentImage } from "./focus";
import { imageAgentWorkNoteText, type ImageAgentWorkNote } from "./work-note";

export type ImageAgentHistoryMessage = {
    id?: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    text: string;
    generatedImageIds?: readonly string[];
    inputImageIds?: readonly string[];
};
export const IMAGE_AGENT_HISTORY_MESSAGES = 20;
export const IMAGE_AGENT_HISTORY_CHARACTERS = 48_000;
export const IMAGE_AGENT_PREVIEW_BYTES = 8 * 1024 * 1024;

export function imageAgentHistoryMessages(history: readonly ImageAgentHistoryMessage[], images: readonly ImageAgentImage[]): AiTextMessage[] {
    const eligible = history.filter(item => item.role === "user" || item.role === "assistant");
    let remaining = IMAGE_AGENT_HISTORY_CHARACTERS;
    const recent = eligible.slice(-IMAGE_AGENT_HISTORY_MESSAGES).toReversed().flatMap(item => {
        if (remaining <= 0) return [];
        const text = item.text.slice(0, Math.min(12_000, remaining));
        remaining -= text.length;
        return [{ ...item, text: text + (text.length < item.text.length ? "\n[较长历史已节选]" : "") }];
    }).reverse();
    const older = eligible.slice(0, eligible.length - recent.length);
    const messages: AiTextMessage[] = [];
    if (older.length) {
        // An attributed excerpt, not an invented model-written summary. Work notes
        // carry lasting constraints independently of this bounded conversation view.
        const summary = older.filter(item => item.role === "user").slice(-8).map(item => item.text.slice(0, 180)).join("；");
        if (summary) messages.push({ role: "user", content: `较早对话摘要（用户原话节选，当前要求优先）：${summary.slice(0, 1000)}` });
    }
    for (const item of recent) {
        const labels = (ids?: readonly string[]) => (ids || []).map(id => images.find(image => image.id === id)?.label).filter(Boolean).join("、");
        const generated = labels(item.generatedImageIds), received = labels(item.inputImageIds);
        const text = [item.text, generated ? `【已生成 ${generated}】` : "", received ? `【附图 ${received}】` : ""].filter(Boolean).join("\n");
        if (text) messages.push({ role: item.role as "user" | "assistant", content: text });
    }
    return messages;
}

export async function buildImageAgentContext<T extends ImageAgentImage>(options: {
    images: readonly T[];
    history: readonly ImageAgentHistoryMessage[];
    currentText: string;
    readImage: (image: T) => Promise<string>;
    focusId?: string;
    lockedImageId?: string;
    explicitIds?: readonly string[];
    uploadIds?: readonly string[];
    newCreation?: boolean;
    note?: ImageAgentWorkNote;
}) {
    const workingSet = selectImageAgentWorkingSet(options.images, options);
    const content: Exclude<AiTextMessage["content"], string> = [];
    let bytes = 0;
    const previews: Array<{ id: string; dataUrl: string }> = [];
    for (const image of workingSet) {
        const dataUrl = await options.readImage(image);
        if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+=*$/i.test(dataUrl)) throw new Error(`${image.label}预览不可用，请重新提供该图片。`);
        bytes += Math.ceil((dataUrl.length - dataUrl.indexOf(",") - 1) * 0.75);
        if (bytes > IMAGE_AGENT_PREVIEW_BYTES) throw new Error("本轮图片预览超过 8 MB，请减少参考图后重试。");
        previews.push({ id: image.id, dataUrl });
        content.push({ type: "text", text: `${image.label}（image_id=${image.id}）${image.id === options.focusId ? " · 当前图" : ""}` }, { type: "image_url", image_url: { url: dataUrl } });
    }
    const note = imageAgentWorkNoteText(options.note);
    if (note) content.push({ type: "text", text: `当前作品说明（已记录的要求，不代表视觉验收）：\n${note}` });
    const messages = imageAgentHistoryMessages(options.history, options.images);
    if (content.length) messages.push({ role: "user", content });
    // The user's actual instruction is always the last message, after all pixels.
    messages.push({ role: "user", content: options.currentText });
    const priority = new Set([...workingSet.map(image => image.id), ...(options.focusId ? [options.focusId] : [])]);
    const catalogIds = new Set([...priority, ...options.images.toReversed().map(image => image.id)].slice(0, 40));
    const imageCatalog = options.images.filter(image => catalogIds.has(image.id)).map(image => ({
        id: image.id, label: image.label, name: image.name?.slice(0, 120), kind: image.kind,
        parentId: image.parentId, workId: image.workId, previewed: previews.some(preview => preview.id === image.id),
        ...(image.unavailableReason ? { unavailable: true } : {}),
    }));
    return { messages, previews, workingSet, profileContext: {
        stage: "plan", currentUserText: options.currentText, focusImageId: options.focusId,
        lockedImageId: options.lockedImageId, newCreation: Boolean(options.newCreation),
        imageCatalog, previewImageIds: previews.map(image => image.id), workNote: note,
    } };
}
