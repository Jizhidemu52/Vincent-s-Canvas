import { buildChatRequestMessages, type ChatHistoryMessage } from "@/lib/chat-context";
import { compileCreativeChatExecutionPrompt } from "@/lib/creative-chat-execution";
import { DuplicateJsonKeyError, parseStrictJson } from "@/lib/strict-json";
import type { AiTextMessage, ToolResponseResult } from "@/services/api/image";
import type { ReferenceImage } from "@/types/image";

type CreativeChatAttachment = { id?: string; name: string; kind?: "image" | "text"; mimeType?: string; dataUrl?: string; textContent?: string; storageKey?: string };

export type CreativeImageLineage = { parentImageId?: string; sourceImageIds: string[]; preservedConstraints: string[] };

export type CreativeChatMessage = Omit<ChatHistoryMessage, "attachments"> & {
    id?: string;
    parentMessageId?: string;
    editTargetImageId?: string;
    attachments?: CreativeChatAttachment[];
    generatedImages?: Array<{ id: string; dataUrl: string; name?: string; mimeType?: string; storageKey?: string; prompt?: string; modelId?: string; lineage?: CreativeImageLineage }>;
};

export type CreativeImageCatalogEntry = ReferenceImage & {
    messageId: string; label: string; kind: "upload" | "generated";
    prompt?: string; modelId?: string; lineage?: CreativeImageLineage; unavailableReason?: string;
};

export type CreativeChatPlan =
    | { kind: "discussion"; content: string }
    | { kind: "image"; content: string; action: "generate" | "edit"; prompt: string; references: ReferenceImage[]; lineage: CreativeImageLineage };

/** These are explicit composer choices, not the automatically remembered candidate. */
export type CreativeChatImageSelection = { explicitTargetImageId?: string; referenceImageIds?: string[] };

export function withCreativeChatImageSelection(current: CreativeChatMessage, catalog: CreativeImageCatalogEntry[], selection: CreativeChatImageSelection): CreativeChatMessage {
    // Choosing a picture alone never authorizes a paid image operation.
    if (!current.content.trim()) return current;
    const selected = (id: string) => {
        const image = catalog.find((item) => item.id === id);
        if (!image || image.unavailableReason) throw new Error("选中的图片原件不可用，请重新选择或取消选择");
        return image.label;
    };
    const target = selection.explicitTargetImageId ? selected(selection.explicitTargetImageId) : "";
    const references = [...new Set(selection.referenceImageIds || [])].filter((id) => id !== selection.explicitTargetImageId).map(selected);
    if (!target && !references.length) return current;
    const choices = [
        target ? `本轮在界面中明确选择 ${target} 作为编辑目标；如果执行图片任务，必须以这张图为底图，不能换成其他版本或独立新生成。` : "",
        references.length ? `本轮选择的参考图：${references.join("、")}；执行图片任务时必须实际使用这些参考图${target ? "作为辅助，不替换编辑目标" : ""}。` : "",
        "是否执行仍由本轮文字要求决定；只讨论、分析或写提示词时请正常文字回答。",
    ].filter(Boolean).join("\n");
    return { ...current, content: `${current.content}\n\n[本轮界面图片选择]\n${choices}` };
}

/** Fail before task submission; never silently rewrite a model's image parameters. */
export function assertCreativeChatImageSelection(plan: CreativeChatPlan, selection: CreativeChatImageSelection) {
    if (plan.kind === "discussion") return;
    const target = selection.explicitTargetImageId;
    if (target && (plan.action !== "edit" || plan.lineage.parentImageId !== target || plan.references[0]?.id !== target)) {
        throw new Error("模型未使用你选中的编辑目标，图片任务尚未提交。请明确修改要求后重试，或取消选图恢复自动判断。");
    }
    const referenceIds = new Set(plan.references.map((image) => image.id));
    if ((selection.referenceImageIds || []).some((id) => !referenceIds.has(id))) {
        throw new Error("模型未使用全部已选参考图，图片任务尚未提交。请明确参考用途后重试，或移除不需要的参考图。");
    }
}

const MAX_CREATIVE_PROMPT_LENGTH = 20_000;
const MAX_CATALOG_CONTEXT_ENTRIES = 40;
const MAX_WORKING_IMAGE_CONTEXT_CHARACTERS = 28_000;
const MAX_PRESERVED_CONSTRAINTS = 20;
const MAX_CONSTRAINT_LENGTH = 400;
export const MAX_CREATIVE_CHAT_REFERENCES = 5;
export const MAX_CREATIVE_CHAT_PREVIEW_BYTES = 8 * 1024 * 1024;

function isImage(item: CreativeChatAttachment) {
    return item.kind !== "text" && (!item.mimeType || item.mimeType.startsWith("image/"))
        && (item.kind === "image" || item.mimeType?.startsWith("image/") || item.dataUrl?.startsWith("data:image/"));
}

function unavailableImageReason(dataUrl: string) {
    return !dataUrl || (dataUrl.startsWith("data:") && !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(dataUrl))
        ? "图片原件缺失或无效，请重新添加" : undefined;
}

/** Identity is persisted, never inferred from equal bytes, names, or position in a text window. */
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
            // Legacy images without either persistent identity cannot receive a moving ID.
            if (!id) continue;
            const dataUrl = item.dataUrl || "";
            const previous = byId.get(id);
            if (previous) {
                if (previous.dataUrl !== dataUrl) previous.unavailableReason = "图片标识重复且原件不一致，请重新添加";
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
                ...(unavailableImageReason(dataUrl) ? { unavailableReason: unavailableImageReason(dataUrl) } : {}),
            };
            catalog.push(entry);
            byId.set(id, entry);
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
    const explicit = selectedImageId || current.editTargetImageId;
    if (explicit) {
        const selected = catalog.find((item) => item.id === explicit);
        // This is an automatically remembered candidate, not a user-selected prerequisite.
        // Do not silently replace an unavailable candidate with a different image.
        return selected && !selected.unavailableReason ? selected : undefined;
    }
    return [...catalog].reverse().find((item) => item.kind === "generated" && !item.unavailableReason)
        || [...catalog].reverse().find((item) => !item.unavailableReason);
}

/** Previews are a small working set; a new palette does not erase the edit target. */
export function resolveCreativeChatReferences(history: CreativeChatMessage[], current: CreativeChatMessage, selectedImageId?: string, catalog = buildCreativeImageCatalog(history, current)): ReferenceImage[] {
    const currentImages = buildCreativeImageCatalog([], current);
    if ((current.attachments || []).some((item) => isImage(item) && !item.id && !current.id)) throw new Error("当前图片缺少持久标识，请重新添加图片");
    currentImages.forEach((item) => originalReference(catalog.find((entry) => entry.id === item.id)!));
    const target = resolveCreativeChatTarget(catalog, current, selectedImageId);
    const selected = new Map<string, CreativeImageCatalogEntry>();
    const add = (item: CreativeImageCatalogEntry | undefined) => { if (item && !item.unavailableReason && selected.size < MAX_CREATIVE_CHAT_REFERENCES) selected.set(item.id, item); };
    if (currentImages.length > MAX_CREATIVE_CHAT_REFERENCES) throw new Error("本轮最多上传 5 张图片，请减少图片后重试");
    // A full new batch is valid on its own; the soft prior target remains in the catalog for inspection.
    if (currentImages.length < MAX_CREATIVE_CHAT_REFERENCES) add(target);
    currentImages.forEach(add);
    // Follow only explicit stored parent links, including a selected older branch's original.
    let ancestor = target;
    const visited = new Set<string>();
    while (ancestor?.lineage?.parentImageId && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        const parent = catalog.find((item) => item.id === ancestor!.lineage!.parentImageId);
        if (!parent) break;
        ancestor = parent;
    }
    add(ancestor);
    [...catalog].reverse().forEach(add);
    return [...selected.values()].map(originalReference);
}



export type CreativeChatContextOptions = { catalog?: CreativeImageCatalogEntry[]; selectedImageId?: string };

/** Full history stays in the application; only this explicitly bounded index reaches the model. */
export function buildCreativeChatRequest(history: CreativeChatMessage[], current: CreativeChatMessage, previewReferences?: ReferenceImage[], options: CreativeChatContextOptions = {}) {
    const catalog = options.catalog || buildCreativeImageCatalog(history, current);
    const currentImageIds = new Set(buildCreativeImageCatalog([], current).map((item) => item.id));
    previewReferences ??= resolveCreativeChatReferences(history, current, options.selectedImageId, catalog).filter(item => currentImageIds.has(item.id));
    let previewBytes = 0;
    for (const reference of previewReferences) {
        if (!/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(reference.dataUrl)) throw new Error("规划参考图必须先转换为内联预览，不能把本地素材地址直接发送给模型");
        previewBytes += Math.ceil((reference.dataUrl.length - reference.dataUrl.indexOf(",") - 1) * 0.75);
    }
    if (previewReferences.length > MAX_CREATIVE_CHAT_REFERENCES || previewBytes > MAX_CREATIVE_CHAT_PREVIEW_BYTES) throw new Error("规划参考图超过 5 张或 8MB，请减少图片后重试");
    const target = resolveCreativeChatTarget(catalog, current, options.selectedImageId);
    const preferredId = options.selectedImageId || current.editTargetImageId;
    const preferred = preferredId ? catalog.find((item) => item.id === preferredId) : undefined;
    const unavailableCandidate = preferredId && (!preferred || preferred.unavailableReason)
        ? { image_id: preferredId, unavailable: true, reason: preferred?.unavailableReason || "该图片已不在当前对话目录中" } : undefined;
    const previewIds = new Set(previewReferences.map((item) => item.id));
    if (previewReferences.some((item) => !catalog.some((entry) => entry.id === item.id))) throw new Error("预览图片不在当前对话目录中");
    const priority = new Set([...previewIds, ...(preferred ? [preferred.id] : target ? [target.id] : [])]);
    const chosen = new Set([...new Set([...priority, ...[...catalog].reverse().map((item) => item.id)])].slice(0, MAX_CATALOG_CONTEXT_ENTRIES));
    const index = catalog.filter((item) => chosen.has(item.id)).map((item) => ({
        image_id: item.id, message_id: item.messageId, label: item.label, name: item.name.slice(0, 200), kind: item.kind,
        previewed: previewIds.has(item.id), provided_this_turn: currentImageIds.has(item.id), ...(item.unavailableReason ? { unavailable: item.unavailableReason } : {}),
        ...(item.lineage ? { parent_image_id: item.lineage.parentImageId, source_image_ids: item.lineage.sourceImageIds.slice(0, MAX_CREATIVE_CHAT_REFERENCES) } : {}),
        has_actual_execution_prompt: !!item.prompt,
    }));
    let remainingDetailCharacters = MAX_WORKING_IMAGE_CONTEXT_CHARACTERS;
    // Saved execution text does not require loading the original pixels. Requested
    // previews retain priority; the soft current candidate is separate keyed data.
    const detailIds = [...new Set([...previewIds, ...((preferred || target) ? [(preferred || target)!.id] : [])])];
    const workingDetails = detailIds.map((id) => {
        const item = catalog.find((entry) => entry.id === id)!;
        const prompt = (item.prompt || "").slice(0, Math.min(MAX_CREATIVE_PROMPT_LENGTH, remainingDetailCharacters));
        remainingDetailCharacters -= prompt.length;
        const constraints: string[] = [];
        for (const value of item.lineage?.preservedConstraints.slice(0, MAX_PRESERVED_CONSTRAINTS) || []) {
            const bounded = value.slice(0, Math.min(MAX_CONSTRAINT_LENGTH, remainingDetailCharacters));
            if (bounded) constraints.push(bounded);
            remainingDetailCharacters -= bounded.length;
        }
        return { image_id: item.id, actual_execution_prompt: prompt, prompt_truncated: prompt.length < (item.prompt?.length || 0), preserved_constraints: constraints, constraints_truncated: constraints.join("").length < (item.lineage?.preservedConstraints.join("").length || 0) };
    });
    const withoutImages = (message: CreativeChatMessage): ChatHistoryMessage => ({
        role: message.role,
        content: `${message.id ? `[message_id=${message.id}${message.parentMessageId ? `; parent_message_id=${message.parentMessageId}` : ""}]\n` : ""}${message.content}`,
        attachments: (message.attachments || []).filter((item) => item.textContent).map((item) => ({ name: item.name, textContent: item.textContent })),
    });
    const messages = buildChatRequestMessages(history.map(withoutImages), withoutImages(current));
    const last = messages[messages.length - 1]!;
    last.content = [
        { type: "text", text: typeof last.content === "string" ? last.content : JSON.stringify(last.content) },
        ...previewReferences.flatMap((reference) => [
            { type: "text" as const, text: `[图片预览 image_id=${reference.id}; ${catalog.find((item) => item.id === reference.id)!.label}; name=${reference.name.slice(0, 200)}]` },
            { type: "image_url" as const, image_url: { url: reference.dataUrl } },
        ]),
    ];
    return { messages, profileContext: {
        phase: "plan" as "plan" | "after-inspection", currentUserText: current.content, catalogTotal: catalog.length,
        ...(target ? { recentImageId: target.id } : {}), ...(unavailableCandidate ? { unavailableCandidate } : {}),
        imageCatalog: index, workingImageDetails: workingDetails, previewImageIds: previewReferences.map(item => item.id),
    } };
}

/** User messages and previews only; server-owned rules travel by profile discriminator. */
export function buildCreativeChatRequestMessages(history: CreativeChatMessage[], current: CreativeChatMessage, previewReferences?: ReferenceImage[], options: CreativeChatContextOptions = {}): AiTextMessage[] {
    return buildCreativeChatRequest(history, current, previewReferences, options).messages;
}

function validatedCall(result: ToolResponseResult) {
    if (!result || typeof result.content !== "string" || !Array.isArray(result.toolCalls)) throw new Error("创作规划响应格式不正确，未提交图片任务");
    if (["max_tokens", "length", "incomplete", "error", "content_filter"].includes(result.stopReason || "")) throw new Error("创作规划未完整返回，未提交图片任务");
    if (result.toolCalls.length > 1) throw new Error("一轮规划只能调用一个工具，未提交任何图片任务");
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

function imageIds(value: unknown, max: number): string[] {
    if (!Array.isArray(value) || value.length > max || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 300) || new Set(value).size !== value.length) throw new Error("图片标识列表无效或重复，未提交图片任务");
    return value as string[];
}

/** Repair representation only: never split, truncate, invent, or drop a constraint. */
function preservedConstraints(value: unknown): string[] {
    const invalid = (detail: string) => new Error(`模型返回的保留约束${detail}，未提交图片任务`);
    let normalized = value;
    if (typeof normalized === "string") {
        const text = normalized.trim();
        if (!text) throw invalid("为空文本（没有保留项应返回 []）");
        if (/^[\[{"]/.test(text)) {
            try { normalized = parseStrictJson(text); }
            catch { throw invalid("不是有效的字符串数组"); }
            // Decode one serialization layer only. An encoded object or another
            // encoded array is not a literal garment requirement.
            if (typeof normalized === "string" && /^[\[{"]/.test(normalized.trim())) throw invalid("存在多重编码");
        }
        if (typeof normalized === "string") normalized = [normalized];
    }
    if (!Array.isArray(normalized)) throw invalid("必须是文字或文字列表");
    if (normalized.length > MAX_PRESERVED_CONSTRAINTS) throw invalid(`超过 ${MAX_PRESERVED_CONSTRAINTS} 项`);
    if (normalized.some(item => typeof item !== "string" || !item.trim())) throw invalid("包含空项或非文字内容");
    if (normalized.some(item => item.length > MAX_CONSTRAINT_LENGTH)) throw invalid(`单项超过 ${MAX_CONSTRAINT_LENGTH} 字符`);
    return normalized as string[];
}

/** Only this read operation can precede the final decision; unknown tools fail closed. */
export function parseCreativeChatInspection(result: ToolResponseResult, catalog: CreativeImageCatalogEntry[]): string[] | null {
    const value = validatedCall(result);
    if (!value || value.call.function.name === "create_image") return null;
    if (value.call.function.name !== "inspect_images") throw new Error("模型返回了未授权工具，未提交图片任务");
    if (Object.keys(value.args).some((key) => key !== "image_ids")) throw new Error("查看图片工具包含未授权参数");
    const ids = imageIds(value.args.image_ids, MAX_CREATIVE_CHAT_REFERENCES);
    if (!ids.length) throw new Error("查看图片工具至少需要一张图片");
    ids.forEach((id) => {
        const entry = catalog.find((item) => item.id === id);
        if (!entry) throw new Error("查看图片工具引用了目录外图片");
        originalReference(entry);
    });
    return ids;
}

/** Treat model output as untrusted: validation finishes before any task can exist. */
export function parseCreativeChatPlan(result: ToolResponseResult, references: ReferenceImage[], options: CreativeChatContextOptions & { previewedImageIds?: string[]; allowImageCreation?: boolean } = {}): CreativeChatPlan {
    const value = validatedCall(result);
    if (!value) {
        if (!result.content.trim()) throw new Error("模型没有返回创作建议，未提交图片任务");
        return { kind: "discussion", content: result.content };
    }
    if (value.call.function.name !== "create_image") throw new Error("模型返回了未授权工具，未提交图片任务");
    // A provider cannot promote instructions inside a bare upload into a paid action.
    if (options.allowImageCreation === false) return { kind: "discussion", content: "已收到你上传的内容。你希望我怎么处理？" };
    const { args } = value;
    if (Object.keys(args).some((key) => !["action", "prompt", "target_image_id", "reference_image_ids", "preserve", "superseded_constraints", "reference_roles"].includes(key))) throw new Error("图片工具包含未授权参数，未提交图片任务");
    if (args.action !== "generate" && args.action !== "edit") throw new Error("图片工具操作无效，未提交图片任务");
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > MAX_CREATIVE_PROMPT_LENGTH) throw new Error("图片提示词必须为 1 至 20000 个字符，未提交图片任务");
    const auxiliaryIds = args.reference_image_ids === undefined ? [] : imageIds(args.reference_image_ids, MAX_CREATIVE_CHAT_REFERENCES - 1);
    const preserve = preservedConstraints(args.preserve);
    if (args.action === "generate") {
        if (args.target_image_id !== undefined || auxiliaryIds.length) throw new Error("全新生成不能指定目标图或参考图，未提交图片任务");
        const execution = compileCreativeChatExecutionPrompt({ prompt: args.prompt, preserve, references: [], referenceRoles: args.reference_roles, supersededConstraints: args.superseded_constraints });
        return { kind: "image", content: result.content, action: "generate", prompt: execution.prompt, references: [], lineage: { sourceImageIds: [], preservedConstraints: execution.preservedConstraints } };
    }
    if (typeof args.target_image_id !== "string" || !args.target_image_id.trim() || args.target_image_id.length > 300) throw new Error("修改图片必须明确 target_image_id，未提交图片任务");
    const targetId = args.target_image_id;
    if (auxiliaryIds.includes(targetId)) throw new Error("辅助图不能重复目标图，未提交图片任务");
    const sourceImageIds = [targetId, ...auxiliaryIds];
    const seenIds = new Set(options.previewedImageIds || references.map((item) => item.id));
    const selectedReferences = sourceImageIds.map((id) => {
        const entry = options.catalog?.find((item) => item.id === id);
        if (options.catalog && !entry) throw new Error("图片工具引用了目录外图片，未提交图片任务");
        if (entry?.unavailableReason) throw new Error(`${entry.label}的原图暂时不可用，请重新发送需要修改的图片`);
        if (!seenIds.has(id)) throw new Error("图片工具引用了未经预览的图片，未提交图片任务");
        const reference = references.find((item) => item.id === id);
        if (!reference || unavailableImageReason(reference.dataUrl)) throw new Error("修改图片引用的原件不可用，未提交图片任务");
        return { ...reference };
    });
    const execution = compileCreativeChatExecutionPrompt({ prompt: args.prompt, preserve, references: selectedReferences, catalog: options.catalog, referenceRoles: args.reference_roles, supersededConstraints: args.superseded_constraints });
    return { kind: "image", content: result.content, action: "edit", prompt: execution.prompt, references: selectedReferences, lineage: { parentImageId: targetId, sourceImageIds, preservedConstraints: execution.preservedConstraints } };
}
