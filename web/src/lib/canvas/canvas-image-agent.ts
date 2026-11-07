import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { canvasConversationImages } from "./canvas-assistant-image-catalog";
import type { CanvasAgentSnapshot, CanvasAgentOp } from "./canvas-agent-ops";
import { placeCanvasImageOutputs } from "./canvas-image-output-placement";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference, type CanvasNodeData } from "@/types/canvas";
import { imageAgentWorkId, getImageAgentVersions, resolveImageAgentBase, type ImageAgentImage } from "@/lib/image-agent/focus";
import { mergeImageAgentWorkNote, type ImageAgentWorkNote } from "@/lib/image-agent/work-note";
import type { ImageAgentHistoryMessage } from "@/lib/image-agent/context";
import type { ImageAgentRegionSelection } from "@/lib/image-agent/mask";
import { compileImageAgentPrompt, imageAgentSpecText } from "@/lib/image-agent/compile";
import { ImageAgentPlanningError, parseImageAgentEditSpec, parseImageAgentReview, type ImageAgentEditSpec, type ImageAgentReview } from "../../../../shared/image-agent-iteration";
import type { DesignRequirements } from "../../../../shared/image-agent-documents";

export type CanvasImageAgentRecord = {
    baseImageId?: string;
    sourceNodeId?: string;
    workId?: string;
    referenceIds: string[];
    note: ImageAgentWorkNote;
    focusRevision?: number;
    version?: number;
    spec?: ImageAgentEditSpec;
    regionSelection?: ImageAgentRegionSelection;
};

export type CanvasImageAgentImage = ImageAgentImage & {
    name: string;
    reference: CanvasAssistantReference;
    nodeId?: string;
    messageId?: string;
    attachmentId?: string;
    dataUrl?: string;
    storageKey?: string;
    spec?: ImageAgentEditSpec;
    prompt?: string;
};

const source = (reference: { storageKey?: string; dataUrl?: string; url?: string }) => reference.storageKey || reference.dataUrl || reference.url || "";

export function canvasImageAgentCatalog(messages: CanvasAssistantMessage[], nodes: readonly CanvasNodeData[] = [], draft: readonly CanvasAssistantReference[] = [], focusId?: string): CanvasImageAgentImage[] {
    const catalog: CanvasImageAgentImage[] = canvasConversationImages(messages.map(message => ({ ...message,
        references: [...(message.references || []), ...(message.contextReferences || [])],
    }))).map(image => {
        const message = messages.find(item => item.id === image.messageId);
        const record = message?.detail?.imageAgent as CanvasImageAgentRecord | undefined;
        return { ...image, kind: image.attachmentId ? "generated" : "upload", nodeId: image.attachmentId || image.reference.id,
            ...(image.attachmentId && typeof message?.detail?.prompt === "string" ? { prompt: message.detail.prompt } : {}),
            ...(image.attachmentId && record ? { parentId: record.baseImageId, workId: record.workId, note: record.note, spec: record.spec } : {}) };
    });
    const findNodeImage = (node: CanvasNodeData) => catalog.find(image => image.nodeId === node.id && source(image) === (node.metadata?.storageKey || node.metadata?.content || ""));
    const ancestors = new Set<string>();
    const addNode = (node: CanvasNodeData): CanvasImageAgentImage | undefined => {
        const existing = findNodeImage(node);
        if (existing) return existing;
        if (ancestors.has(node.id) || node.type !== CanvasNodeType.Image || (!node.metadata?.content && !node.metadata?.storageKey)) return;
        ancestors.add(node.id);
        const record = node.metadata?.imageAgent;
        const parent = record?.parentNodeId ? nodes.find(item => item.id === record.parentNodeId) : undefined;
        const parentImage = parent && addNode(parent);
        const reference = { id: node.id, type: CanvasNodeType.Image, title: node.title, dataUrl: node.metadata?.content, storageKey: node.metadata?.storageKey };
        const image: CanvasImageAgentImage = { id: `canvas-image:${node.id}`, label: `图${catalog.length + 1}`, name: node.title,
            kind: record ? "generated" : "upload", nodeId: node.id, reference, dataUrl: reference.dataUrl, storageKey: reference.storageKey,
            // Keep a missing ancestor's identity so original/previous cannot
            // silently treat this result as an original in a different chat.
            parentId: parentImage?.id || (record?.parentNodeId ? `canvas-image:${record.parentNodeId}` : undefined), workId: record?.workId, note: record?.note, spec: record?.spec,
            prompt: node.metadata?.generationRecord?.submittedPrompt || node.metadata?.generationRecord?.prompt || (record ? node.metadata?.prompt : undefined) };
        catalog.push(image);
        return image;
    };
    // Only follow parents of actual conversation/selected references, never all
    // viewport media. This also supports selecting an old node in another chat.
    for (const image of [...catalog]) {
        if (image.attachmentId && !image.parentId) {
            const legacy = messages.find(message => message.id === image.messageId)?.detail?.imageEdit as { baseReferences?: CanvasAssistantReference[]; originalReferences?: CanvasAssistantReference[] } | undefined;
            const base = legacy?.baseReferences?.[0] || legacy?.originalReferences?.[0];
            const parent = base && catalog.find(item => item.id !== image.id && source(item) && source(item) === source(base));
            if (parent) image.parentId = parent.id;
        }
        const node = nodes.find(item => item.id === image.nodeId);
        if (node?.metadata?.imageAgent) {
            image.note ||= node.metadata.imageAgent.note;
            image.workId ||= node.metadata.imageAgent.workId;
            image.spec ||= node.metadata.imageAgent.spec;
            image.prompt ||= node.metadata.generationRecord?.submittedPrompt || node.metadata.generationRecord?.prompt || node.metadata.prompt;
            const parent = nodes.find(item => item.id === node.metadata!.imageAgent!.parentNodeId);
            if (!image.parentId && node.metadata.imageAgent.parentNodeId) image.parentId = (parent && addNode(parent)?.id) || `canvas-image:${node.metadata.imageAgent.parentNodeId}`;
        }
    }
    for (const reference of draft) {
        if (reference.type !== CanvasNodeType.Image || catalog.some(image => source(image) && source(image) === source(reference))) continue;
        const node = nodes.find(item => item.id === reference.id);
        if (node) { addNode(node); continue; }
        catalog.push({ id: `draft-image:${reference.id}`, label: `图${catalog.length + 1}`, kind: "upload", name: reference.title,
            reference, nodeId: reference.id, dataUrl: reference.dataUrl, storageKey: reference.storageKey });
    }
    // A persistent node focus survives clearing the visual selection (for
    // example after saving a mask), even before its first conversation turn.
    if (focusId?.startsWith("canvas-image:")) {
        const focusedNode = nodes.find(node => node.id === focusId.slice("canvas-image:".length));
        if (focusedNode) addNode(focusedNode);
    }
    return catalog.map(image => ({ ...image, ...(image.spec || image.prompt ? { designBrief: canvasImageAgentDesignBrief(image.spec, image.prompt) } : {}) }));
}

/** Reconnect an explicit draft choice to its persisted conversation identity. */
export function canvasImageAgentFocusId(catalog: readonly CanvasImageAgentImage[], id?: string) {
    if (!id) return undefined;
    return catalog.find(image => image.id === id)?.id
        || catalog.find(image => image.nodeId === id.replace(/^(?:draft-image|canvas-image):/, ""))?.id;
}

export function canvasImageAgentResultOps(ops: CanvasAgentOp[], snapshot: CanvasAgentSnapshot, record: CanvasImageAgentRecord, select = true) {
    const parent = snapshot.nodes.find(node => node.id === record.sourceNodeId);
    const existing = new Set(snapshot.nodes.map(node => node.id));
    const result: CanvasAgentOp[] = [];
    for (const op of ops) {
        if (op.type === "select_nodes" && !select) continue;
        if (op.type === "add_node" && op.nodeType === CanvasNodeType.Image && op.id) {
            if (existing.has(op.id)) continue;
            result.push({ ...op, position: parent ? placeCanvasImageOutputs(snapshot.nodes, [parent], { width: op.width || 340, height: op.height || 340 }, op.position || { x: 0, y: 0 }) : op.position,
                metadata: { ...op.metadata, imageAgent: { parentNodeId: parent?.id, workId: record.workId || op.id,
                    version: record.version || (parent?.metadata?.imageAgent?.version || (parent ? 1 : 0)) + 1, note: record.note, ...(record.spec ? { spec: record.spec } : {}) } } });
            if (parent) result.push({ type: "connect_nodes", fromNodeId: parent.id, toNodeId: op.id });
        } else result.push(op);
    }
    // add_node normally selects itself; background results must restore the live
    // user's selection, not just omit the explicit selection operation.
    if (!select && result.some(op => op.type === "add_node")) result.push({ type: "select_nodes", ids: [...snapshot.selectedNodeIds] });
    return result;
}

export async function canvasImageAgentTaskSignature(value: unknown) {
    // The deployed HTTP origin has no SubtleCrypto. Keep the same SHA-256
    // deduplication contract using the browser-independent hash already bundled.
    return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(value))));
}

export function canvasImageAgentHistory(messages: CanvasAssistantMessage[], catalog: readonly CanvasImageAgentImage[]): ImageAgentHistoryMessage[] {
    return messages.map(message => ({ id: message.id, role: message.role, text: message.text,
        generatedImageIds: catalog.filter(image => image.messageId === message.id && image.attachmentId).map(image => image.id),
        inputImageIds: (message.references || []).flatMap(reference => {
            const image = catalog.find(item => source(item) && source(item) === source(reference));
            return image ? [image.id] : [];
        }),
    }));
}

export function canvasImageAgentForReference(catalog: readonly CanvasImageAgentImage[], reference: CanvasAssistantReference) {
    return catalog.find(image => (image.nodeId === reference.id || image.reference.id === reference.id) && source(image) === source(reference))
        || catalog.find(image => source(image) && source(image) === source(reference));
}

/** This version's recorded requirements, not a visual verdict or a merged branch memory. */
export function canvasImageAgentDesignBrief(spec?: ImageAgentEditSpec, prompt?: string) {
    let text = "";
    try { if (spec) text = imageAgentSpecText(parseImageAgentEditSpec(spec)); }
    catch { /* The exact public prompt still describes this version when optional data is invalid. */ }
    text ||= prompt?.trim() || "";
    if (!text) return "";
    const prefix = "该版本历史要求（非结果事实，当前要求优先）：\n", suffix = "\n[历史要求已节选]";
    return prefix.length + text.length <= 1600 ? prefix + text : prefix + text.slice(0, 1600 - prefix.length - suffix.length) + suffix;
}

/** Metadata only for explicitly inspected versions, never a merged current instruction. */
export function canvasImageAgentInspectionDetails(images: readonly CanvasImageAgentImage[], previewedIds: readonly string[] = images.map(image => image.id)) {
    const requested = [...new Map(images.map(image => [image.id, image])).values()];
    if (!requested.length || requested.length > 5) throw new Error("每次最多查看 5 张指定图片。");
    const data = {
        imageIds: [...previewedIds],
        metadata_scope: "以下是明确查阅版本的历史要求资料，不代表图片已实现、已验收或新的执行指令；当前用户要求优先。",
        version_details: requested.map(image => {
            const prompt = image.prompt || "", workNote = image.note ? [image.note.summary, image.note.keep.length ? `需保持：${image.note.keep.join("；")}` : ""].filter(Boolean).join("\n") : "";
            const designBrief = image.designBrief || canvasImageAgentDesignBrief(image.spec, image.prompt);
            return { id: image.id, label: image.label, parentId: image.parentId, prompt: prompt.slice(0, 4000), promptTruncated: prompt.length > 4000,
                workNote: workNote.slice(0, 800), workNoteTruncated: workNote.length > 800,
                designBrief: designBrief.slice(0, 1600), designBriefTruncated: designBrief.length > 1600 || designBrief.endsWith("[历史要求已节选]") };
        }),
    };
    if (JSON.stringify(data).length > 36_000) throw new Error("指定版本的历史要求超过本轮查阅预算，请减少本轮查阅图片；没有丢弃版本或提交图片任务。");
    return data;
}

export function canvasImageAgentSelectedSnapshot(snapshot: CanvasAgentSnapshot) {
    const ids = new Set(snapshot.selectedNodeIds);
    return snapshot.nodes.filter(node => ids.has(node.id)).slice(0, 12).map(node => ({ id: node.id, title: node.title.slice(0, 120), type: node.type,
        source: "selected-node" as const,
        ...([CanvasNodeType.Image, CanvasNodeType.Config].includes(node.type) && typeof (node.metadata?.prompt || node.metadata?.composerContent) === "string"
            ? { prompt: String(node.metadata?.prompt || node.metadata?.composerContent).slice(0, 1000) } : {}),
        ...(node.metadata?.imageAgent?.spec ? { designBrief: canvasImageAgentDesignBrief(node.metadata.imageAgent.spec) } : {}),
        ...(node.type === CanvasNodeType.Text ? { text: node.metadata?.content?.slice(0, 3000) } : {}) }));
}

/** Small tool contract; a missing/invalid requested asset never falls back to generation. */
type CanvasImageAgentSelection = {
    focusId?: string; lockedImageId?: string; newCreation?: boolean; explicitIds?: readonly string[]; previewedIds?: readonly string[]; focusRevision?: number;
    requirements?: DesignRequirements;
};
export function resolveCanvasImageAgentEdit(args: Record<string, unknown>, catalog: readonly CanvasImageAgentImage[], selection: CanvasImageAgentSelection) {
    const invalid = (message: string) => new ImageAgentPlanningError("IMAGE_AGENT_ARGUMENTS_INVALID", message);
    if (Object.keys(args).some(key => !["base", "references", "prompt", "keep", "note_update", "edit_spec"].includes(key))) throw invalid("图片工具参数无效，本次尚未提交生成。");
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 20_000) throw invalid("请提供完整且不超过 20000 字符的修改说明。");
    if (args.base !== undefined && typeof args.base !== "string") throw invalid("底图标识无效。");
    if (args.references !== undefined && (!Array.isArray(args.references) || args.references.length > 5 || args.references.some(id => typeof id !== "string"))) throw invalid("参考图列表无效。");
    if (args.keep !== undefined && (!Array.isArray(args.keep) || args.keep.length > 20 || args.keep.some(value => typeof value !== "string" || !value.trim() || value.length > 400))) throw invalid("需要保持的要求格式无效。");
    if (args.note_update !== undefined && (typeof args.note_update !== "string" || args.note_update.length > 800)) throw invalid("作品说明应不超过 800 字。");
    const base = resolveImageAgentBase(catalog, selection, args.base as string | undefined);
    const requested = [...(selection.explicitIds || []), ...((args.references as string[] | undefined) || [])];
    const references = new Map<string, CanvasImageAgentImage>();
    if (base) references.set(base.id, base);
    for (const id of requested) {
        const image = catalog.find(item => item.id === id || item.label === id);
        if (!image || image.unavailableReason) throw new Error("有一张参考图已不可用，请重新选择；尚未提交生成。");
        references.set(image.id, image);
    }
    if (references.size > 5) throw new ImageAgentPlanningError("IMAGE_AGENT_REFERENCES_INVALID", "底图与参考图合计最多 5 张。");
    if ([...references.values()].some(image => !source(image))) throw new Error("图片原件不可读取，尚未提交生成。");
    if (selection.previewedIds && [...references.keys()].some(id => !selection.previewedIds!.includes(id))) throw new ImageAgentPlanningError("IMAGE_AGENT_UNPREVIEWED_IMAGE", "需要先查看指定图片，再提交修改；本次未生成。");
    const note = mergeImageAgentWorkNote(base?.note, args.note_update as string | undefined, args.keep as string[] | undefined);
    const keep = note.keep;
    const { prompt, spec } = compileImageAgentPrompt({ prompt: args.prompt, keep, images: [...references.values()], baseImageId: base?.id, spec: args.edit_spec, requirements: selection.requirements });
    const record: CanvasImageAgentRecord = { baseImageId: base?.id, sourceNodeId: base?.nodeId,
        workId: base ? imageAgentWorkId(catalog, base) : undefined, referenceIds: [...references.keys()], note, focusRevision: selection.focusRevision,
        version: base ? getImageAgentVersions(catalog, base.id).length + 1 : 1, ...(spec ? { spec } : {}) };
    return { base, prompt, record, references: [...references.values()].map(image => ({ ...image.reference, id: image.id, dataUrl: image.reference.dataUrl || "" })) };
}

/** Validate the image plan before any tool in its batch may mutate the canvas. */
export function validateCanvasImageAgentPlan<Result extends { toolCalls: Array<{ function: { name: string; arguments: string } }> }>(result: Result, catalog: readonly CanvasImageAgentImage[], selection: CanvasImageAgentSelection): Result {
    for (const call of result.toolCalls) {
        if (call.function.name !== "edit_image") continue;
        let args: unknown;
        try { args = JSON.parse(call.function.arguments); }
        catch { throw new ImageAgentPlanningError("IMAGE_AGENT_ARGUMENTS_INVALID", "图片工具参数不是合法 JSON 对象，尚未提交生成。"); }
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new ImageAgentPlanningError("IMAGE_AGENT_ARGUMENTS_INVALID", "图片工具参数必须是 JSON 对象，尚未提交生成。");
        resolveCanvasImageAgentEdit(args as Record<string, unknown>, catalog, selection);
    }
    return result;
}

/** Review and correction use the recorded parent of this result, never the latest UI focus. */
export function canvasImageAgentReviewTarget(messages: CanvasAssistantMessage[], nodes: readonly CanvasNodeData[], messageId: string, attachmentId: string) {
    const message = messages.find(item => item.id === messageId);
    if (!message || message.detail?.kind !== "agent_generation" || message.detail.status !== "completed"
        || !message.attachments?.some(item => item.id === attachmentId && item.mediaType === "image")
        || typeof message.detail.prompt !== "string" || !message.detail.prompt.trim()) throw new Error("这张结果没有完整的本轮记录，无法开始检查。");
    const catalog = canvasImageAgentCatalog(messages, nodes);
    const result = catalog.find(image => image.messageId === messageId && image.attachmentId === attachmentId);
    const record = message.detail.imageAgent as CanvasImageAgentRecord | undefined;
    const base = record?.baseImageId ? catalog.find(image => image.id === record.baseImageId) : undefined;
    if (!result || result.unavailableReason || !source(result)) throw new Error("本版结果原件暂不可用，未开始检查。");
    if (record?.baseImageId && (!base || base.unavailableReason || !source(base))) throw new Error("本次实际使用的底图已不可用，请重新提供；不会换成其他版本。");
    return { catalog, message, result, base, record, prompt: message.detail.prompt, spec: record?.spec };
}

/** Invalidate a pending or saved report if its exact version inputs are replaced. */
export function canvasImageAgentReviewFingerprint(target: ReturnType<typeof canvasImageAgentReviewTarget>) {
    const imageSource = (image?: CanvasImageAgentImage) => image ? [image.id, source(image.reference)] : null;
    const selection = target.record?.regionSelection;
    const record = target.record ? { ...target.record, regionSelection: selection ? { imageId: selection.imageId, mask: source(selection.mask), selection: source(selection.selection) } : undefined } : undefined;
    const data = [target.message.id, target.prompt, record, imageSource(target.base), imageSource(target.result),
        target.record?.referenceIds.map(id => imageSource(target.catalog.find(image => image.id === id)))];
    const serialized = JSON.stringify(data, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
    return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

/** Media fields travel through the same local-to-cloud conversion as the actual images. */
export function canvasImageAgentReviewInputs(target: ReturnType<typeof canvasImageAgentReviewTarget>) {
    const selection = target.record?.regionSelection;
    const record = target.record ? { ...target.record, regionSelection: selection ? { imageId: selection.imageId } : undefined } : undefined;
    const serialized = JSON.stringify([target.message.id, target.prompt, record], (_key, value) => value && typeof value === "object" && !Array.isArray(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
    const media = (id: string, reference?: { storageKey?: string; dataUrl?: string; url?: string }) => ({ id, ...(reference?.storageKey ? { storageKey: reference.storageKey } : {}), url: reference?.dataUrl || reference?.url || "" });
    return { revision: bytesToHex(sha256(new TextEncoder().encode(serialized))), sources: [
        ...(target.base ? [media(target.base.id, target.base.reference)] : []), media(target.result.id, target.result.reference),
        ...(target.record?.referenceIds || []).map(id => media(id, target.catalog.find(image => image.id === id)?.reference)),
        ...(selection ? [media(`${selection.imageId}:mask`, selection.mask), media(`${selection.imageId}:selection`, selection.selection)] : []),
    ] };
}

export function canvasImageAgentReviewMatches(target: ReturnType<typeof canvasImageAgentReviewTarget>, saved: { fingerprint: string; inputs?: ReturnType<typeof canvasImageAgentReviewInputs> }) {
    if (!saved.inputs) return saved.fingerprint === canvasImageAgentReviewFingerprint(target);
    const current = canvasImageAgentReviewInputs(target);
    return saved.inputs.revision === current.revision && saved.inputs.sources.length === current.sources.length
        && current.sources.every((item, index) => saved.inputs!.sources[index]?.id === item.id && source(saved.inputs!.sources[index]!) === source(item));
}

/** A visible editable draft only. Calling this helper never submits a task or changes image pixels. */
export function canvasImageAgentCorrectionDraft(target: ReturnType<typeof canvasImageAgentReviewTarget>, value: ImageAgentReview) {
    const review = parseImageAgentReview(value);
    if (!target.base || !target.record?.baseImageId) throw new Error("本版没有可锁定的实际底图，请先选择修改目标。");
    if (target.message.detail?.regionComposite && !target.record.regionSelection) throw new Error("本轮原选区记录不完整，请先重新圈选；不会自动变成整图纠正。");
    if (target.record.regionSelection && target.record.regionSelection.imageId !== target.base.id) throw new Error("本轮原选区与底图不匹配，请先重新圈选；没有修改草稿。");
    const warnings = review.checks.filter(check => check.result === "warning");
    if (!warnings.length) throw new Error("检查未指出明确偏差；无法确认的项目请先人工核对。");
    const references = [...new Set([target.base.id, ...target.record.referenceIds])].map(id => {
        const image = target.catalog.find(item => item.id === id);
        if (!image || image.unavailableReason || !source(image)) throw new Error("本次参考图已不可用，请重新选择；没有生成纠正任务。");
        return image;
    });
    const text = ["请以当前锁定的本轮底图重新完成下面的原要求。以下是模型检查建议，需核对，不是已经确认的事实：",
        ...warnings.map(check => `- ${check.criterion}：${check.evidence}`), "原修改要求：", target.prompt].join("\n");
    if (text.length > 20_000) throw new Error("原要求与检查建议合计过长，请先精简草稿；没有提交任务。");
    return { text, baseId: target.base.id, references, regionSelection: target.record.regionSelection };
}
