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
export const IMAGE_AGENT_EARLIER_HISTORY_CHARACTERS = 8000;
// The full profile has a separate 60k server limit and also carries the current
// instruction, selected nodes and documents. Version prose cannot consume it all.
export const IMAGE_AGENT_CATALOG_BRIEF_CHARACTERS = 16_000;

function boundedVersionBrief(text: string, serializedBudget: number, maximum: number) {
    const suffix = "\n[历史要求已节选；细节请查阅该版本，不推断省略内容]";
    const encoded = (value: string) => JSON.stringify({ designBrief: value }).length;
    if (text.length <= maximum && encoded(text) <= serializedBudget) return text;
    let low = 0, high = Math.min(text.length, Math.max(0, maximum - suffix.length));
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (encoded(text.slice(0, middle) + suffix) <= serializedBudget) low = middle;
        else high = middle - 1;
    }
    return low && encoded(text.slice(0, low) + suffix) <= serializedBudget ? text.slice(0, low) + suffix : undefined;
}

function historyText(item: ImageAgentHistoryMessage, images: readonly ImageAgentImage[]) {
    const labels = (ids?: readonly string[]) => (ids || []).map(id => images.find(image => image.id === id)?.label).filter(Boolean).join("、");
    const generated = labels(item.generatedImageIds), received = labels(item.inputImageIds);
    return [item.text, generated ? `【已生成 ${generated}】` : "", received ? `【附图 ${received}】` : ""].filter(Boolean).join("\n");
}

/** Keep an assistant proposal together with the following user choices/rejections.
 * These are attributed original excerpts, not a fabricated accepted-design summary. */
function earlierConversation(history: readonly ImageAgentHistoryMessage[], images: readonly ImageAgentImage[]) {
    const groups: ImageAgentHistoryMessage[][] = [];
    for (const item of history) {
        if (!groups.length || (item.role === "assistant" && groups.at(-1)!.at(-1)?.role === "user")) groups.push([]);
        groups.at(-1)!.push(item);
    }
    const prefix = "较早对话摘录（按原顺序；助手建议不等于用户已采纳，选择或否决以用户反馈为准；当前要求优先）：\n";
    const excerpts: string[] = [];
    let remaining = IMAGE_AGENT_EARLIER_HISTORY_CHARACTERS - prefix.length;
    const render = (items: readonly ImageAgentHistoryMessage[], maximum: number) => items.map(item => {
        const text = historyText(item, images);
        return `${item.role === "assistant" ? "助手建议/回复" : "用户反馈/要求"}：${text.length > maximum ? `${text.slice(0, maximum)}\n[本条较长，后续内容未带入，不能据此推断完整方案]` : text}`;
    }).join("\n\n");
    for (const group of groups.toReversed()) {
        let text = render(group, Number.POSITIVE_INFINITY);
        if (text.length + 2 > remaining) {
            if (excerpts.length) break;
            // Keep the proposal plus the newest feedback even for an unusual run
            // of consecutive messages; omission is explicit, not an invented summary.
            const maximum = Math.max(2, Math.floor(remaining / 200));
            const slots = group.length > maximum ? [group[0]!, ...group.slice(-(maximum - 1))] : group;
            text = render(slots, Math.max(1, Math.floor(remaining / slots.length) - 80));
            if (slots.length < group.length) text = `[本段中间${group.length - slots.length}条较早消息未带入]\n${text}`;
        }
        excerpts.unshift(text); remaining -= text.length + 2;
        if (remaining < 100) break;
    }
    return excerpts.length ? prefix + excerpts.join("\n\n") : "";
}

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
        const excerpt = earlierConversation(older, images);
        if (excerpt) messages.push({ role: "user", content: excerpt });
    }
    for (const item of recent) {
        const text = historyText(item, images);
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
    if (note) content.push({ type: "text", text: `当前作品说明（已记录的要求，不代表视觉验收；历史相对变化不是本轮增量，保持以本轮所选底图当前可见状态为准）：\n${note}` });
    const messages = imageAgentHistoryMessages(options.history, options.images);
    if (content.length) messages.push({ role: "user", content });
    // The user's actual instruction is always the last message, after all pixels.
    messages.push({ role: "user", content: options.currentText });
    const priority = new Set([...workingSet.map(image => image.id), ...(options.focusId ? [options.focusId] : [])]);
    const catalogIds = new Set([...new Set([...priority, ...options.images.toReversed().map(image => image.id)])].slice(0, 40));
    const briefs = new Map<string, string>();
    let briefBudget = IMAGE_AGENT_CATALOG_BRIEF_CHARACTERS;
    // Keep full working-version excerpts first, followed by small older-version
    // cues. All identities remain in the table even when prose is omitted.
    const briefOrder = [...options.images.filter(image => priority.has(image.id)), ...options.images.toReversed().filter(image => !priority.has(image.id))];
    for (const image of briefOrder) {
        if (!catalogIds.has(image.id) || !image.designBrief) continue;
        const brief = boundedVersionBrief(image.designBrief, briefBudget, priority.has(image.id) ? 1600 : 200);
        if (!brief) continue;
        briefs.set(image.id, brief);
        briefBudget -= JSON.stringify({ designBrief: brief }).length;
    }
    const imageCatalog = options.images.filter(image => catalogIds.has(image.id)).map(image => ({
        id: image.id, label: image.label, name: image.name?.slice(0, 120), kind: image.kind,
        parentId: image.parentId, workId: image.workId, previewed: previews.some(preview => preview.id === image.id),
        ...(briefs.has(image.id) ? { designBrief: briefs.get(image.id)! } : {}),
        ...(image.unavailableReason ? { unavailable: true } : {}),
    }));
    return { messages, previews, workingSet, profileContext: {
        stage: "plan", currentUserText: options.currentText, focusImageId: options.focusId,
        lockedImageId: options.lockedImageId, newCreation: Boolean(options.newCreation),
        imageCatalog, previewImageIds: previews.map(image => image.id), workNote: note,
    } };
}
