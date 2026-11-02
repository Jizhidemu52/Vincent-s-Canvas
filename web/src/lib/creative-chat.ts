import type { ChatHistoryMessage } from "@/lib/chat-context";
import { buildImageAgentContext, type ImageAgentHistoryMessage } from "@/lib/image-agent/context";
import { imageAgentCandidateIds, imageAgentWorkId, resolveImageAgentBase, resolveImageAgentFocus, selectImageAgentWorkingSet, type ImageAgentImage } from "@/lib/image-agent/focus";
import { mergeImageAgentWorkNote, type ImageAgentWorkNote } from "@/lib/image-agent/work-note";
import { DuplicateJsonKeyError, parseStrictJson } from "@/lib/strict-json";
import type { AiTextMessage, ToolResponseResult } from "@/services/api/image";
import type { ReferenceImage } from "@/types/image";

type CreativeChatAttachment = { id?: string; name: string; kind?: "image" | "text"; mimeType?: string; dataUrl?: string; textContent?: string; storageKey?: string };
/** Historical records remain readable; new edits use parentId/workId/workNote. */
export type CreativeImageLineage = { parentImageId?: string; sourceImageIds: string[]; preservedConstraints: string[] };
export type CreativeImageWork = { parentId?: string; workId?: string; workNote?: ImageAgentWorkNote };
export type CreativeChatMessage = Omit<ChatHistoryMessage, "attachments"> & {
    id?: string; parentMessageId?: string; editTargetImageId?: string;
    focusImageId?: string; focusLocked?: boolean; newCreation?: boolean;
    attachments?: CreativeChatAttachment[];
    generatedImages?: Array<CreativeImageWork & { id: string; dataUrl: string; name?: string; mimeType?: string; storageKey?: string; prompt?: string; modelId?: string; lineage?: CreativeImageLineage }>;
};
export type CreativeImageCatalogEntry = ReferenceImage & ImageAgentImage & { messageId: string; prompt?: string; modelId?: string; lineage?: CreativeImageLineage };
export type CreativeChatPlan =
    | { kind: "discussion"; content: string; candidateImageIds?: string[] }
    | { kind: "image"; content: string; action: "generate" | "edit"; prompt: string; references: ReferenceImage[]; parentId?: string; workId?: string; workNote: ImageAgentWorkNote; keep: string[] };

export type CreativeChatImageSelection = { explicitTargetImageId?: string; referenceImageIds?: string[]; newCreation?: boolean };
export type CreativeChatContextOptions = { catalog?: CreativeImageCatalogEntry[]; selectedImageId?: string; lockedImageId?: string; newCreation?: boolean; referenceImageIds?: string[]; inspectionImageIds?: string[] };
export const MAX_CREATIVE_CHAT_REFERENCES = 5;
export const MAX_CREATIVE_CHAT_PREVIEW_BYTES = 8 * 1024 * 1024;

function isImage(item: CreativeChatAttachment) {
    return item.kind !== "text" && (!item.mimeType || item.mimeType.startsWith("image/"))
        && (item.kind === "image" || item.mimeType?.startsWith("image/") || item.dataUrl?.startsWith("data:image/"));
}
function unavailableImageReason(dataUrl: string, storageKey?: string) {
    return (!dataUrl && !storageKey) || (dataUrl.startsWith("data:") && !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(dataUrl))
        ? "图片原件缺失或无效，请重新添加" : undefined;
}

/** Persisted IDs and parent links remain authoritative; previews never define identity. */
export function buildCreativeImageCatalog(history: CreativeChatMessage[], current?: CreativeChatMessage): CreativeImageCatalogEntry[] {
    const catalog: CreativeImageCatalogEntry[] = [];
    const byId = new Map<string, CreativeImageCatalogEntry>();
    for (const message of [...history, ...(current ? [current] : [])]) {
        if (message.role === "error") continue;
        const items = message.role === "assistant"
            ? (message.generatedImages || []).map((item, index) => ({ ...item, kind: "image" as const, name: item.name || `生成结果-${index + 1}.png`, mimeType: item.mimeType || "image/png" }))
            : message.attachments || [];
        for (const [index, item] of items.entries()) {
            if (!isImage(item)) continue;
            const kind = message.role === "assistant" ? "generated" : "upload";
            const id = item.id || (message.id ? `${message.id}:${kind}:${index}` : "");
            if (!id) continue;
            const dataUrl = item.dataUrl || "";
            const previous = byId.get(id);
            if (previous) {
                const sameStored = previous.storageKey && previous.storageKey === item.storageKey;
                if (!sameStored && previous.dataUrl !== dataUrl) previous.unavailableReason = "图片标识重复且原件不一致，请重新添加";
                continue;
            }
            const generated = message.role === "assistant" ? message.generatedImages?.[index] : undefined;
            const entry: CreativeImageCatalogEntry = {
                id, name: item.name, dataUrl, type: dataUrl.match(/^data:(image\/[^;]+);/)?.[1] || item.mimeType || "image/png",
                messageId: message.id || `image:${id}`, label: `图${catalog.length + 1}`, kind,
                ...(item.storageKey ? { storageKey: item.storageKey } : {}),
                ...(generated?.prompt ? { prompt: generated.prompt } : {}),
                ...(generated?.modelId ? { modelId: generated.modelId } : {}),
                ...(generated?.lineage ? { lineage: generated.lineage } : {}),
                ...(generated?.parentId || generated?.lineage?.parentImageId ? { parentId: generated.parentId || generated.lineage?.parentImageId } : {}),
                ...(generated?.workId ? { workId: generated.workId } : {}),
                ...(generated?.workNote ? { note: generated.workNote } : {}),
                ...(unavailableImageReason(dataUrl, item.storageKey) ? { unavailableReason: unavailableImageReason(dataUrl, item.storageKey) } : {}),
            };
            catalog.push(entry); byId.set(id, entry);
        }
    }
    return catalog;
}

function originalReference(entry: CreativeImageCatalogEntry): ReferenceImage {
    if (entry.unavailableReason) throw new Error(`${entry.label}（${entry.name}）：${entry.unavailableReason}`);
    const { id, name, type, dataUrl, storageKey } = entry;
    return { id, name, type, dataUrl, ...(storageKey ? { storageKey } : {}) };
}

export function resolveCreativeChatTarget(catalog: CreativeImageCatalogEntry[], current: CreativeChatMessage, selectedImageId?: string) {
    return resolveImageAgentFocus(catalog, { focusId: selectedImageId || current.focusImageId || current.editTargetImageId, newCreation: current.newCreation });
}

export function resolveCreativeChatReferences(history: CreativeChatMessage[], current: CreativeChatMessage, selectedImageId?: string, catalog = buildCreativeImageCatalog(history, current), options: CreativeChatContextOptions = {}): ReferenceImage[] {
    if ((current.attachments || []).some(item => isImage(item) && !item.id && !current.id)) throw new Error("当前图片缺少持久标识，请重新添加图片");
    return selectImageAgentWorkingSet(catalog, {
        focusId: selectedImageId || current.focusImageId || current.editTargetImageId,
        explicitIds: options.referenceImageIds,
        uploadIds: buildCreativeImageCatalog([], current).map(item => item.id), newCreation: options.newCreation ?? current.newCreation,
    }).map(originalReference);
}

/** Composer choices live in structured context; never rewrite the user's message. */
export function withCreativeChatImageSelection(current: CreativeChatMessage, catalog: CreativeImageCatalogEntry[], selection: CreativeChatImageSelection): CreativeChatMessage {
    for (const id of [selection.explicitTargetImageId, ...(selection.referenceImageIds || [])].filter((id): id is string => Boolean(id))) {
        if (!catalog.some(item => item.id === id && !item.unavailableReason)) throw new Error("选中的图片原件不可用，请重新选择");
    }
    if (!selection.explicitTargetImageId && !selection.newCreation) return current;
    return { ...current, ...(selection.explicitTargetImageId ? { focusImageId: selection.explicitTargetImageId, focusLocked: true } : {}), newCreation: selection.newCreation };
}

export function assertCreativeChatImageSelection(plan: CreativeChatPlan, selection: CreativeChatImageSelection) {
    if (plan.kind === "discussion") return;
    if (selection.newCreation && plan.parentId) throw new Error("新创作不应沿用旧底图，图片任务尚未提交。");
    if (selection.explicitTargetImageId && !selection.newCreation && (plan.parentId !== selection.explicitTargetImageId || plan.references[0]?.id !== selection.explicitTargetImageId)) throw new Error("图片任务未使用选中的当前图，尚未提交。");
    if ((selection.referenceImageIds || []).some(id => !plan.references.some(image => image.id === id))) throw new Error("图片任务缺少已选参考图，尚未提交。");
}

function historyItem(message: CreativeChatMessage): ImageAgentHistoryMessage {
    const text = [message.content, ...(message.attachments || []).filter(item => item.textContent).map(item => `[附件：${item.name}]\n${item.textContent}`)].join("\n\n");
    return { id: message.id, role: message.role, text, generatedImageIds: message.generatedImages?.map(item => item.id), inputImageIds: message.attachments?.filter(isImage).map(item => item.id).filter((id): id is string => Boolean(id)) };
}

/** Both surfaces use the same working-set, history and last-user-message rules. */
export async function buildCreativeChatRequest(history: CreativeChatMessage[], current: CreativeChatMessage, previewReferences?: ReferenceImage[], options: CreativeChatContextOptions = {}) {
    const catalog = options.catalog || buildCreativeImageCatalog(history, current);
    const newCreation = options.newCreation ?? current.newCreation;
    const focus = resolveImageAgentFocus(catalog, { focusId: options.selectedImageId || current.focusImageId || current.editTargetImageId, newCreation });
    const lockedImageId = options.lockedImageId || (current.focusLocked ? focus?.id : undefined);
    const contextHistory = history.map(historyItem);
    const documents = (current.attachments || []).filter(item => item.textContent);
    if (documents.length) contextHistory.push({ role: "user", text: documents.map(item => `[本轮附件：${item.name}]\n${item.textContent}`).join("\n\n") });
    return buildImageAgentContext({
        images: catalog, history: contextHistory, currentText: current.content,
        focusId: focus?.id, lockedImageId, newCreation, note: focus?.note,
        explicitIds: [...new Set([...(options.referenceImageIds || []), ...(options.inspectionImageIds || [])])],
        uploadIds: options.inspectionImageIds ? [] : buildCreativeImageCatalog([], current).map(item => item.id),
        readImage: async item => {
            const reference = previewReferences?.find(preview => preview.id === item.id) || (!previewReferences ? item : undefined);
            if (!reference) throw new Error(`${item.label}尚未完成图片预览，请重新读取后发送。`);
            return reference.dataUrl;
        },
    });
}

export async function buildCreativeChatRequestMessages(history: CreativeChatMessage[], current: CreativeChatMessage, previews?: ReferenceImage[], options: CreativeChatContextOptions = {}): Promise<AiTextMessage[]> {
    return (await buildCreativeChatRequest(history, current, previews, options)).messages;
}

function validatedCall(result: ToolResponseResult) {
    if (!result || typeof result.content !== "string" || !Array.isArray(result.toolCalls)) throw new Error("创作规划响应格式不正确，未提交图片任务");
    if (["max_tokens", "length", "incomplete", "error", "content_filter"].includes(result.stopReason || "")) throw new Error("创作规划未完整返回，未提交图片任务");
    if (result.toolCalls.length > 1) throw new Error("一轮只能执行一次图片操作，未提交任何图片任务");
    if (!result.toolCalls.length) return null;
    const call = result.toolCalls[0]!;
    if (call.type !== "function" || !call.id || typeof call.function?.arguments !== "string") throw new Error("模型返回了未授权工具，未提交图片任务");
    let parsed: unknown;
    try { parsed = parseStrictJson(call.function.arguments); } catch (error) {
        if (error instanceof DuplicateJsonKeyError) throw error;
        throw new Error("图片工具参数不是有效 JSON，未提交图片任务");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("图片工具参数格式不正确，未提交图片任务");
    return { call, args: parsed as Record<string, unknown> };
}

function imageIds(value: unknown, catalog: CreativeImageCatalogEntry[]): string[] {
    if (!Array.isArray(value) || value.length > MAX_CREATIVE_CHAT_REFERENCES || value.some(item => typeof item !== "string" || !item.trim() || item.length > 300)) throw new Error("图片标识列表无效，未提交图片任务");
    const ids = value.map(value => {
        const image = catalog.find(item => item.id === value || item.label === value);
        if (!image) throw new Error("图片工具引用了目录外图片，未提交图片任务");
        originalReference(image); return image.id;
    });
    if (new Set(ids).size !== ids.length) throw new Error("图片标识重复，未提交图片任务");
    return ids;
}

export function parseCreativeChatInspection(result: ToolResponseResult, catalog: CreativeImageCatalogEntry[]): string[] | null {
    const value = validatedCall(result);
    if (!value || value.call.function.name === "edit_image") return null;
    if (value.call.function.name !== "look_at_images") throw new Error("模型返回了未授权工具，未提交图片任务");
    if (Object.keys(value.args).some(key => key !== "image_ids")) throw new Error("查看图片工具包含未授权参数");
    const ids = imageIds(value.args.image_ids, catalog);
    if (!ids.length) throw new Error("查看图片至少需要一张图片");
    return ids;
}

/** Only offer real images actually named in the clarification, never invented candidates. */
export function creativeChatCandidateImages(content: string, catalog: CreativeImageCatalogEntry[], options: Pick<CreativeChatContextOptions, "selectedImageId" | "newCreation"> = {}): string[] {
    return imageAgentCandidateIds(content, catalog, { focusId: options.selectedImageId, newCreation: options.newCreation });
}

export function parseCreativeChatPlan(result: ToolResponseResult, references: ReferenceImage[], options: CreativeChatContextOptions & { previewedImageIds?: string[]; allowImageCreation?: boolean } = {}): CreativeChatPlan {
    const value = validatedCall(result);
    const catalog = options.catalog || references.map((reference, index) => ({ ...reference, messageId: reference.id, label: `图${index + 1}`, kind: "upload" as const }));
    if (!value) {
        if (!result.content.trim()) throw new Error("模型没有返回创作建议，未提交图片任务");
        const candidateImageIds = creativeChatCandidateImages(result.content, catalog, options);
        return { kind: "discussion", content: result.content, ...(candidateImageIds.length ? { candidateImageIds } : {}) };
    }
    if (value.call.function.name !== "edit_image") throw new Error("模型返回了未授权工具，未提交图片任务");
    if (options.allowImageCreation === false) return { kind: "discussion", content: "已收到你上传的内容。你希望我怎么处理？" };
    const { args } = value;
    if (Object.keys(args).some(key => !["base", "references", "prompt", "keep", "note_update"].includes(key))) throw new Error("图片工具包含未授权参数，未提交图片任务");
    if (args.base !== undefined && (typeof args.base !== "string" || !args.base.trim() || args.base.length > 300)) throw new Error("图片底图方向无效，未提交图片任务");
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 20_000) throw new Error("图片提示词必须为 1 至 20000 个字符，未提交图片任务");
    const keep = args.keep as string[] | undefined;
    if (keep !== undefined && (!Array.isArray(keep) || keep.length > 20 || keep.some(item => typeof item !== "string" || !item.trim() || item.length > 400))) throw new Error("需保持的要求必须为简短文字列表，未提交图片任务");
    if (args.note_update !== undefined && (typeof args.note_update !== "string" || args.note_update.length > 800)) throw new Error("作品说明应不超过 800 字，未提交图片任务");
    const base = resolveImageAgentBase(catalog, { focusId: options.selectedImageId, lockedImageId: options.lockedImageId, newCreation: options.newCreation }, args.base as string | undefined);
    const auxiliaryIds = args.references === undefined ? [] : imageIds(args.references, catalog);
    const sourceIds = [...new Set([...(base ? [base.id] : []), ...auxiliaryIds, ...(options.referenceImageIds || [])])];
    if (sourceIds.length > 5) throw new Error("底图与参考图合计最多 5 张，未提交图片任务");
    const seen = new Set(options.previewedImageIds || references.map(item => item.id));
    const selected = sourceIds.map(id => {
        const entry = catalog.find(item => item.id === id);
        if (!entry) throw new Error("图片工具引用了目录外图片，未提交图片任务");
        if (!seen.has(id)) throw new Error("需要先查看这张较早图片，未提交图片任务");
        const reference = references.find(item => item.id === id);
        if (!reference) throw new Error("参考图片原件不可用，未提交图片任务");
        originalReference(entry); return { ...reference };
    });
    const workNote = mergeImageAgentWorkNote(base?.note, args.note_update as string | undefined, keep);
    const order = selected.map((reference, index) => `输入图${index + 1}对应${catalog.find(image => image.id === reference.id)!.label}${reference.id === base?.id ? "（修改底图）" : "（参考图）"}`).join("；");
    const prompt = [order ? `本次提供的图片顺序：${order}。` : "", args.prompt.trim(), workNote.keep.length ? `需要保持：${workNote.keep.join("；")}。` : ""].filter(Boolean).join("\n\n");
    if (prompt.length > 20_000) throw new Error("完整图片要求超过 20000 字，请精简后再发送。");
    return { kind: "image", content: result.content, action: selected.length ? "edit" : "generate", prompt, references: selected,
        ...(base ? { parentId: base.id, workId: imageAgentWorkId(catalog, base) } : {}), workNote, keep: workNote.keep };
}
