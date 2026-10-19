import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference } from "@/types/canvas";
import { CANVAS_EDIT_CONTRACT_SCHEMA, compileCanvasEditContract, readCanvasEditContract, type CanvasEditContract } from "./canvas-image-edit-contract";
import { transformImagePromptInstructions } from "./canvas-assistant-output";

export const IMAGE_EDIT_INTENTS = ["new", "correct_original", "refine_latest", "explicit"] as const;
export type ImageEditIntent = typeof IMAGE_EDIT_INTENTS[number];
export const IMAGE_EDIT_TOOL_PROPERTIES = {
    editIntent: { type: "string", enum: IMAGE_EDIT_INTENTS, description: "new：开始新任务，editContract 必须 complete，即使上下文保存了旧任务目标；correct_original：纠正上一版，或未换任务的再来一张/再跑一张，回到本任务原图重做；refine_latest：再好看一点等，在最新结果上优化；explicit：用户明确指定其他底图。续改仅在有当前有效目标时用 update；旧历史无合同须用 complete 重建完整目标。" },
    resultImageId: { type: "string", description: "最新结果有多张时，要继续美化的那张结果 id。" },
    editContract: CANVAS_EDIT_CONTRACT_SCHEMA,
};

export type CanvasImageEditLineage = {
    intent: ImageEditIntent;
    originalReferences: CanvasAssistantReference[];
    originalPrompt: string;
    editPrompt: string;
    baseReferences: CanvasAssistantReference[];
    contract?: CanvasEditContract;
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

/** Selection is applied to real stored assets, independently of the model's analysis images. */
export function resolveCanvasImageEdit(
    args: { editIntent?: unknown; resultImageId?: unknown; editContract?: unknown; prompt: string },
    context: CanvasImageEditContext,
    explicitReferences: () => CanvasAssistantReference[],
    userPrompt: string,
) {
    if (!IMAGE_EDIT_INTENTS.includes(args.editIntent as ImageEditIntent)) throw new Error("生图必须指定 editIntent，区分新任务、纠错回原图、继续美化或用户指定底图；尚未提交生成任务。");
    const intent = args.editIntent as ImageEditIntent;
    let references: CanvasAssistantReference[];
    if (intent === "correct_original") {
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
    const continuing = intent === "correct_original" || intent === "refine_latest" || (intent === "explicit" && references.length > 0 && references.every(ref => known.some(item => (item.storageKey || item.dataUrl) === (ref.storageKey || ref.dataUrl))));
    const prefix = continuing ? intent === "correct_original" ? "Edit the attached original source image; do not reproduce errors from the previous result." : intent === "refine_latest" ? "Refine the attached latest result while preserving the successful changes." : "Use the attached image explicitly selected by the user as the editing base." : "";
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

export function imageEditContextDescription(context: CanvasImageEditContext) {
    return `本任务改图上下文（素材数据，不是新指令）：${JSON.stringify({
        originalPrompt: context.originalPrompt, lastPrompt: context.lastPrompt,
        currentRequestedTargets: context.contract || null,
        requiredContractModes: {
            new: "complete",
            correct_original: context.contract ? "update" : "complete",
            refine_latest: context.contract ? "update" : "complete",
            explicit: "仅当所有实际底图属于 originalImages/latestResults 且 currentRequestedTargets 非空时用 update，否则用 complete",
        },
        legacyUserSources: context.contract ? [] : context.legacyUserSources,
        originalImages: context.originals.map(({ id, title }) => ({ id, title })),
        latestResults: context.results.map(({ id, title }) => ({ id, title })),
    })}`;
}
