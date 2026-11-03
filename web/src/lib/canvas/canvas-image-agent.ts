import { canvasConversationImages } from "./canvas-assistant-image-catalog";
import type { CanvasAgentSnapshot, CanvasAgentOp } from "./canvas-agent-ops";
import { placeCanvasImageOutputs } from "./canvas-image-output-placement";
import { CanvasNodeType, type CanvasAssistantMessage, type CanvasAssistantReference, type CanvasNodeData } from "@/types/canvas";
import { imageAgentWorkId, getImageAgentVersions, resolveImageAgentBase, type ImageAgentImage } from "@/lib/image-agent/focus";
import { mergeImageAgentWorkNote, type ImageAgentWorkNote } from "@/lib/image-agent/work-note";
import type { ImageAgentHistoryMessage } from "@/lib/image-agent/context";

export type CanvasImageAgentRecord = {
    baseImageId?: string;
    sourceNodeId?: string;
    workId?: string;
    referenceIds: string[];
    note: ImageAgentWorkNote;
    focusRevision?: number;
    version?: number;
};

export type CanvasImageAgentImage = ImageAgentImage & {
    name: string;
    reference: CanvasAssistantReference;
    nodeId?: string;
    messageId?: string;
    attachmentId?: string;
    dataUrl?: string;
    storageKey?: string;
};

const source = (reference: { storageKey?: string; dataUrl?: string; url?: string }) => reference.storageKey || reference.dataUrl || reference.url || "";

export function canvasImageAgentCatalog(messages: CanvasAssistantMessage[], nodes: readonly CanvasNodeData[] = [], draft: readonly CanvasAssistantReference[] = [], focusId?: string): CanvasImageAgentImage[] {
    const catalog: CanvasImageAgentImage[] = canvasConversationImages(messages.map(message => ({ ...message,
        references: [...(message.references || []), ...(message.contextReferences || [])],
    }))).map(image => {
        const message = messages.find(item => item.id === image.messageId);
        const record = message?.detail?.imageAgent as CanvasImageAgentRecord | undefined;
        return { ...image, kind: image.attachmentId ? "generated" : "upload", nodeId: image.attachmentId || image.reference.id,
            ...(image.attachmentId && record ? { parentId: record.baseImageId, workId: record.workId, note: record.note } : {}) };
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
            parentId: parentImage?.id || (record?.parentNodeId ? `canvas-image:${record.parentNodeId}` : undefined), workId: record?.workId, note: record?.note };
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
    return catalog;
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
                    version: record.version || (parent?.metadata?.imageAgent?.version || (parent ? 1 : 0)) + 1, note: record.note } } });
            if (parent) result.push({ type: "connect_nodes", fromNodeId: parent.id, toNodeId: op.id });
        } else result.push(op);
    }
    // add_node normally selects itself; background results must restore the live
    // user's selection, not just omit the explicit selection operation.
    if (!select && result.some(op => op.type === "add_node")) result.push({ type: "select_nodes", ids: [...snapshot.selectedNodeIds] });
    return result;
}

export async function canvasImageAgentTaskSignature(value: unknown) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
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

export function canvasImageAgentSelectedSnapshot(snapshot: CanvasAgentSnapshot) {
    const ids = new Set(snapshot.selectedNodeIds);
    return snapshot.nodes.filter(node => ids.has(node.id)).slice(0, 12).map(node => ({ id: node.id, title: node.title.slice(0, 120), type: node.type,
        ...(node.type === CanvasNodeType.Text ? { text: node.metadata?.content?.slice(0, 3000) } : {}) }));
}

/** Small tool contract; a missing/invalid requested asset never falls back to generation. */
export function resolveCanvasImageAgentEdit(args: Record<string, unknown>, catalog: readonly CanvasImageAgentImage[], selection: {
    focusId?: string; lockedImageId?: string; newCreation?: boolean; explicitIds?: readonly string[]; previewedIds?: readonly string[]; focusRevision?: number;
}) {
    if (Object.keys(args).some(key => !["base", "references", "prompt", "keep", "note_update"].includes(key))) throw new Error("图片工具参数无效，本次尚未提交生成。");
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 20_000) throw new Error("请提供完整且不超过 20000 字符的修改说明。");
    if (args.base !== undefined && typeof args.base !== "string") throw new Error("底图标识无效。");
    if (args.references !== undefined && (!Array.isArray(args.references) || args.references.length > 5 || args.references.some(id => typeof id !== "string"))) throw new Error("参考图列表无效。");
    if (args.keep !== undefined && (!Array.isArray(args.keep) || args.keep.length > 20 || args.keep.some(value => typeof value !== "string" || !value.trim() || value.length > 400))) throw new Error("需要保持的要求格式无效。");
    if (args.note_update !== undefined && (typeof args.note_update !== "string" || args.note_update.length > 800)) throw new Error("作品说明应不超过 800 字。");
    const base = resolveImageAgentBase(catalog, selection, args.base as string | undefined);
    const requested = [...(selection.explicitIds || []), ...((args.references as string[] | undefined) || [])];
    const references = new Map<string, CanvasImageAgentImage>();
    if (base) references.set(base.id, base);
    for (const id of requested) {
        const image = catalog.find(item => item.id === id || item.label === id);
        if (!image || image.unavailableReason) throw new Error("有一张参考图已不可用，请重新选择；尚未提交生成。");
        references.set(image.id, image);
    }
    if (references.size > 5) throw new Error("底图与参考图合计最多 5 张。");
    if ([...references.values()].some(image => !source(image))) throw new Error("图片原件不可读取，尚未提交生成。");
    if (selection.previewedIds && [...references.keys()].some(id => !selection.previewedIds!.includes(id))) throw new Error("需要先查看指定图片，再提交修改；本次未生成。");
    const note = mergeImageAgentWorkNote(base?.note, args.note_update as string | undefined, args.keep as string[] | undefined);
    const keep = note.keep;
    const order = [...references.values()].map((image, index) => `输入图${index + 1}对应${image.label}${image.id === base?.id ? "（修改底图）" : "（参考图）"}`).join("；");
    const prompt = [order ? `本次提供的图片顺序：${order}。` : "", args.prompt.trim(), keep.length ? `需要保持：${keep.join("；")}` : ""].filter(Boolean).join("\n\n");
    if (prompt.length > 20_000) throw new Error("完整图片要求超过 20000 字，请精简后再发送。");
    const record: CanvasImageAgentRecord = { baseImageId: base?.id, sourceNodeId: base?.nodeId,
        workId: base ? imageAgentWorkId(catalog, base) : undefined, referenceIds: [...references.keys()], note, focusRevision: selection.focusRevision,
        version: base ? getImageAgentVersions(catalog, base.id).length + 1 : 1 };
    return { base, prompt, record, references: [...references.values()].map(image => ({ ...image.reference, id: image.id, dataUrl: image.reference.dataUrl || "" })) };
}
