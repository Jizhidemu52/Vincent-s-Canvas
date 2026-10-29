import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";
import { CanvasEditContractError, compileCanvasEditContract, readCanvasEditContract, type CanvasEditContract } from "./canvas-image-edit-contract";
import { transformImagePromptInstructions } from "./canvas-assistant-output";

export const IMAGE_EDIT_INTENTS = ["new", "correct_original", "refine_latest", "explicit"] as const;
export type ImageEditIntent = typeof IMAGE_EDIT_INTENTS[number];


export type CanvasImageEditLineage = {
    intent: ImageEditIntent;
    originalReferences: CanvasAssistantReference[];
    originalPrompt: string;
    editPrompt: string;
    baseReferences: CanvasAssistantReference[];
    contract?: CanvasEditContract;
};

/** An explicit UI choice is frozen with the turn; planner arguments cannot replace it. */
export type CanvasImageEditTarget = {
    mode: "edit" | "original";
    reference: CanvasAssistantReference;
    resultImageId?: string;
    additionalReferences?: CanvasAssistantReference[];
};

const isCompletedImage = (message: CanvasAssistantMessage) => message.role === "assistant" && message.detail?.status === "completed" && message.attachments?.some(item => item.mediaType === "image");

/** Historical source text belongs to this result's task, not to the whole conversation. */
function legacyTaskUserSources(history: CanvasAssistantMessage[], latestIndex: number, lineage?: CanvasImageEditLineage) {
    if (!lineage?.originalPrompt) return [];
    const assetKeys = (lineage.originalReferences || []).map(ref => ref.storageKey || ref.dataUrl);
    let firstResultIndex = latestIndex, previousTaskIndex = -1, firstLineage = lineage;
    for (let i = latestIndex - 1; i >= 0; i--) {
        if (!isCompletedImage(history[i]!)) continue;
        const candidate = history[i]!.detail?.imageEdit as CanvasImageEditLineage | undefined;
        const candidateKeys = (candidate?.originalReferences || []).map(ref => ref.storageKey || ref.dataUrl);
        const sameRoot = candidate?.originalPrompt === lineage.originalPrompt && candidateKeys.length === assetKeys.length && candidateKeys.every((key, index) => Boolean(key) && key === assetKeys[index]);
        if (firstLineage.intent === "new" || !candidate || !sameRoot) { previousTaskIndex = i; break; }
        firstResultIndex = i;
        firstLineage = candidate;
    }
    const start = history.findLastIndex((message, index) => index > previousTaskIndex && index < firstResultIndex && message.role === "user" && message.text === lineage.originalPrompt);
    // Missing task origin is not permission to borrow arbitrary previous user messages.
    if (start < 0) return [lineage.originalPrompt];
    return history.slice(start, latestIndex + 1).filter(message => message.role === "user").map(message => message.text);
}

export function canvasImageEditContext(history: CanvasAssistantMessage[]) {
    const latestIndex = history.findLastIndex(isCompletedImage);
    const latest = history[latestIndex];
    const lineage = latest?.detail?.imageEdit as CanvasImageEditLineage | undefined;
    const originals = (lineage?.originalReferences || []).map((ref, i) => ({ ...ref, id: `edit-original-${i}` }));
    const results = (latest?.attachments || []).filter(item => item.mediaType === "image").map(item => ({
        id: item.id, type: CanvasNodeType.Image, title: `最新生成结果：${item.name}`, dataUrl: item.url, storageKey: item.storageKey,
    }));
    const contract = readCanvasEditContract(lineage?.contract);
    // Reloaded original assets get stable aliases; keep clause placeholders attached to the same bytes.
    const aliases = new Map((lineage?.originalReferences || []).map((ref, index) => [ref.id, `edit-original-${index}`]));
    if (contract) for (const group of ["changes", "preserve", "forbid"] as const) for (const clause of contract[group]) clause.text = transformImagePromptInstructions(clause.text, text => text.replace(/\[\[ref:([^\]\r\n]+)\]\]/gu, (match, id: string) => aliases.has(id) ? `[[ref:${aliases.get(id)}]]` : match));
    const legacyUserSources = legacyTaskUserSources(history, latestIndex, lineage);
    return { originals, results, contract, legacyUserSources, originalPrompt: lineage?.originalPrompt || "", lastPrompt: lineage?.editPrompt || (typeof latest?.detail?.prompt === "string" ? latest.detail.prompt : "") };
}

export type CanvasImageEditContext = ReturnType<typeof canvasImageEditContext>;

export function canvasImageTargetReferences(target: CanvasImageEditTarget, context: CanvasImageEditContext) {
    const base = target.mode === "original" ? context.originals : target.resultImageId
        ? context.results.filter(reference => reference.id === target.resultImageId) : [target.reference];
    if (!base.length || (target.mode === "edit" && base.length !== 1)) throw new Error("编辑目标已不可用，请重新选择图片");
    const references: CanvasAssistantReference[] = [];
    for (const reference of [...base, ...(target.additionalReferences || [])]) {
        if (!reference.dataUrl && !reference.storageKey) throw new Error("改图底图不可读取，请重新提供图片；不会退回文生图。");
        const key = reference.storageKey || reference.dataUrl;
        if (!references.some(item => (item.storageKey || item.dataUrl) === key)) references.push({ ...reference });
    }
    return references;
}

export function canvasImageEditToolArgs<T extends Record<string, unknown>>(args: T, context: CanvasImageEditContext, target?: CanvasImageEditTarget): T & { editIntent?: unknown; resultImageId?: unknown } {
    if (!target) return args;
    return { ...args, editIntent: target.mode === "original" ? "correct_original" : target.resultImageId ? "refine_latest" : "explicit",
        resultImageId: target.mode === "edit" ? target.resultImageId : undefined,
        referenceNodeIds: canvasImageTargetReferences(target, context).map(reference => reference.id) };
}

/** Selection is applied to real stored assets, independently of the model's analysis images. */
export function resolveCanvasImageEdit(
    args: { editIntent?: unknown; resultImageId?: unknown; editContract?: unknown; prompt: string },
    context: CanvasImageEditContext,
    explicitReferences: () => CanvasAssistantReference[],
    userPrompt: string,
    target?: CanvasImageEditTarget,
) {
    args = canvasImageEditToolArgs(args, context, target);
    if (!IMAGE_EDIT_INTENTS.includes(args.editIntent as ImageEditIntent)) throw new Error("生图必须指定 editIntent，区分新任务、纠错回原图、继续美化或用户指定底图；尚未提交生成任务。");
    const intent = args.editIntent as ImageEditIntent;
    let references: CanvasAssistantReference[];
    if (target) {
        references = canvasImageTargetReferences(target, context);
        const raw = args.editContract && typeof args.editContract === "object" ? args.editContract as Record<string, unknown> : undefined;
        const roles = Array.isArray(raw?.referenceRoles) ? raw.referenceRoles as Array<{ id?: unknown; role?: unknown }> : [];
        const baseIds = target.mode === "original" ? context.originals.map(item => item.id) : [target.reference.id];
        if (!roles.some(item => baseIds.includes(String(item.id)) && item.role === "base") || roles.some(item => item.role === "base" && !baseIds.includes(String(item.id)))) {
            throw new CanvasEditContractError("已选编辑目标必须作为底图，补充参考图不能替换编辑目标", context.contract ? "update" : "complete");
        }
    } else if (intent === "correct_original") {
        references = context.originals;
        if (!references.length) throw new Error("本任务没有保存可用原图，请补充原图后重做；不会把不满意的结果当成原图。");
    } else if (intent === "refine_latest") {
        references = args.resultImageId === undefined ? context.results : context.results.filter(ref => ref.id === args.resultImageId);
        if (references.length !== 1) throw new Error("请明确选择一张最新生成结果继续美化；尚未提交生成任务。");
    } else {
        references = explicitReferences();
        if (intent === "explicit" && !references.length) throw new Error("用户指定底图时必须提供有效 referenceNodeIds；尚未提交生成任务。");
    }
    if (references.some(ref => !ref.dataUrl && !ref.storageKey)) throw new Error("改图底图不可读取，请重新提供图片；不会退回文生图。");
    const known = [...context.originals, ...context.results];
    const continuing = target ? target.mode === "original" || Boolean(target.resultImageId) : intent === "correct_original" || intent === "refine_latest" || (intent === "explicit" && references.length > 0 && references.every(ref => known.some(item => (item.storageKey || item.dataUrl) === (ref.storageKey || ref.dataUrl))));
    const prefix = target && target.mode === "edit" ? "Use the attached image explicitly selected by the user as the editing base; preserve the successful changes." : continuing ? intent === "correct_original" ? "Edit the attached original source image; do not reproduce errors from the previous result." : intent === "refine_latest" ? "Refine the attached latest result while preserving the successful changes." : "Use the attached image explicitly selected by the user as the editing base." : "";
    const compiled = compileCanvasEditContract({ contract: args.editContract, previous: context.contract, continuing, userPrompt, legacySources: [context.originalPrompt, ...(context.legacyUserSources || [])], draftPrompt: args.prompt, references, prefix });
    const lineage: CanvasImageEditLineage = {
        intent,
        originalReferences: (continuing ? context.originals : references).map(ref => ({ ...ref })),
        originalPrompt: continuing ? context.originalPrompt : userPrompt,
        editPrompt: compiled.prompt,
        baseReferences: references.map(ref => ({ ...ref })),
        contract: compiled.contract,
    };
    // The saved contract records requested targets, not a visual acceptance decision.
    const prompt = [prefix, compiled.prompt].filter(Boolean).join("\n\n");
    return { references: references.map(ref => ({ ...ref, dataUrl: ref.dataUrl || "" })), prompt, lineage };
}

/** Plain task evidence only. Contract-mode instructions are added by the server. */
export function imageEditContextData(context: CanvasImageEditContext) {
    return {
        originalPrompt: context.originalPrompt, lastPrompt: context.lastPrompt,
        currentRequestedTargets: context.contract || null,
        legacyUserSources: context.contract ? [] : context.legacyUserSources,
        originalImages: context.originals.map(({ id, title }) => ({ id, title })),
        latestResults: context.results.map(({ id, title }) => ({ id, title })),
    };
}
