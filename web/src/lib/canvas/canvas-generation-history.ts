import type { CanvasHistorySnapshot } from "@/stores/canvas/use-canvas-store";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

type History = { past: CanvasHistorySnapshot[]; future: CanvasHistorySnapshot[] };

// Result delivery owns these fields. Drafts, generation settings, title,
// references and batch/group structure remain ordinary user-editable history.
const runtimeKeys = [
    "status", "errorDetails", "imageTask", "sourceTaskId", "generationSubmissionUncertain",
    "optimizingPrompt", "optimized", "prompt", "userInput", "content", "storageKey",
    "naturalWidth", "naturalHeight", "bytes", "mimeType", "originalFileName", "imageName", "imageVersion", "primaryImageId",
] as const satisfies readonly (keyof CanvasNodeMetadata)[];

function sameFields(left: object | undefined, right: object | undefined) {
    if (left === right) return true;
    const a = (left || {}) as Record<string, unknown>, b = (right || {}) as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].every(key => Object.is(a[key], b[key]));
}

function sameNode(left: CanvasNodeData, right: CanvasNodeData) {
    return left.id === right.id && left.type === right.type && left.title === right.title && left.width === right.width && left.height === right.height
        && left.position.x === right.position.x && left.position.y === right.position.y
        && sameFields({ ...left.metadata, generationRecord: undefined }, { ...right.metadata, generationRecord: undefined })
        && sameFields(left.metadata?.generationRecord, right.metadata?.generationRecord);
}

/** Fold only delivery patches into versions of an already-created result.
 * Never insert absent nodes or rewrite a different generation of the same node.
 */
export function mergeCanvasGenerationHistory(history: History, previous: CanvasHistorySnapshot, current: CanvasHistorySnapshot) {
    if (previous.nodes === current.nodes) return { history, previous };
    const beforeById = new Map(previous.nodes.map(node => [node.id, node]));
    const patches = new Map<string, { before: CanvasNodeData; after: CanvasNodeData; resize: boolean; shift: { x: number; y: number } }>();
    for (const after of current.nodes) {
        const before = beforeById.get(after.id), a = before?.metadata, b = after.metadata;
        if (!before || before === after || !a?.generationRecord?.id || a.generationRecord.id !== b?.generationRecord?.id) continue;
        const compiled = a.generationRecord.prompt !== b.generationRecord.prompt;
        const inFlight = a.status === "loading" || b.status === "loading" || a.imageTask || b.imageTask || a.optimizingPrompt || b.optimizingPrompt;
        if (!inFlight && !compiled) continue;
        if (!compiled && !runtimeKeys.some(key => !Object.is(a[key], b[key]))) continue;
        const resize = b.status === "success" && Boolean(b.naturalWidth && b.naturalHeight)
            && (before.width !== after.width || before.height !== after.height)
            && (a.status !== "success" || a.content !== b.content || a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight);
        // Normal delivery keeps the placeholder center; task recovery may retain
        // its top-left. Any remaining displacement belongs to the user's move.
        const shifted = before.position.x !== after.position.x || before.position.y !== after.position.y;
        patches.set(after.id, { before, after, resize, shift: resize && shifted
            ? { x: (before.width - after.width) / 2, y: (before.height - after.height) / 2 } : { x: 0, y: 0 } });
    }
    if (!patches.size) return { history, previous };

    const nodeCache = new WeakMap<CanvasNodeData, CanvasNodeData>();
    const arrayCache = new WeakMap<CanvasNodeData[], CanvasNodeData[]>();
    const patchNode = (node: CanvasNodeData) => {
        const cached = nodeCache.get(node);
        if (cached) return cached;
        const patch = patches.get(node.id);
        if (!patch || node.metadata?.generationRecord?.id !== patch.after.metadata!.generationRecord!.id) return node;
        const metadata = { ...node.metadata };
        for (const key of runtimeKeys) {
            // Assignment through a common value map keeps optional deletions
            // precise without erasing unrelated draft/settings properties.
            const fields = metadata as Record<string, unknown>;
            if (Object.hasOwn(patch.after.metadata!, key)) fields[key] = patch.after.metadata![key];
            else delete fields[key];
        }
        metadata.generationRecord = node.metadata.generationRecord!.prompt === patch.after.metadata!.generationRecord!.prompt
            ? node.metadata.generationRecord : { ...node.metadata.generationRecord!, prompt: patch.after.metadata!.generationRecord!.prompt };
        // A historical explicit resize has its own dimensions; do not overwrite
        // it with another version's result-fit geometry.
        const resize = patch.resize && node.width === patch.before.width && node.height === patch.before.height;
        const updated: CanvasNodeData = { ...node, metadata, ...(resize ? {
            width: patch.after.width, height: patch.after.height,
            position: { x: node.position.x + patch.shift.x, y: node.position.y + patch.shift.y },
        } : {}) };
        const result = sameNode(updated, node) ? node : sameNode(updated, patch.after) ? patch.after : updated;
        nodeCache.set(node, result);
        return result;
    };
    const patchSnapshot = (entry: CanvasHistorySnapshot) => {
        let nodes = arrayCache.get(entry.nodes);
        if (!nodes) {
            const mapped = entry.nodes.map(patchNode);
            nodes = mapped.every((node, index) => node === entry.nodes[index]) ? entry.nodes
                : mapped.length === current.nodes.length && mapped.every((node, index) => node === current.nodes[index]) ? current.nodes : mapped;
            arrayCache.set(entry.nodes, nodes);
        }
        return nodes === entry.nodes ? entry : { ...entry, nodes };
    };
    const patchStack = (stack: CanvasHistorySnapshot[]) => {
        const updated = stack.map(patchSnapshot);
        return updated.every((entry, index) => entry === stack[index]) ? stack : updated;
    };
    return { history: { past: patchStack(history.past), future: patchStack(history.future) }, previous: patchSnapshot(previous) };
}
