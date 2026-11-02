import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import { placeCanvasImageOutputs } from "./canvas-image-output-placement";

function signature(node: CanvasNodeData): string | undefined {
    const record = node.metadata?.generationRecord;
    if (!record || record.configNodeId || record.parameters.count !== 1 || record.promptInput?.scene === "workflow-step") return;
    return JSON.stringify([node.metadata?.generationStackSourceId || record.sourceNodeId, record.prompt, record.submittedPrompt || record.prompt,
        record.parameters.model, record.parameters.size, record.parameters.quality, record.parameters.imageOptions, record.parameters.systemPrompt, record.parameters.generationType,
        record.references.map(reference => reference.storageKey ? ["stored", reference.storageKey] : ["inline", reference.content])]);
}

const coverKeys = ["content", "storageKey", "serverAssetId", "sourceTaskId", "naturalWidth", "naturalHeight", "mimeType", "bytes", "originalFileName", "imageName", "imageVersion", "freeResize",
    "prompt", "submittedPrompt", "userInput", "optimized", "generationRecord", "generationType", "model", "size", "quality", "imageOptions", "systemPrompt", "references", "compareSources"] as const satisfies readonly (keyof CanvasNodeMetadata)[];

/** Copies only the representative's display/replay snapshot; never writes to a child or copies a live task binding. */
export function canvasGenerationStackCover(root: CanvasNodeData, child: CanvasNodeData): CanvasNodeData {
    const metadata: CanvasNodeMetadata = { ...root.metadata, primaryImageId: child.id, status: child.metadata?.status, errorDetails: child.metadata?.errorDetails,
        imageTask: undefined, mediaTask: undefined, generationOrigin: undefined, generationSubmissionUncertain: undefined, count: 1 };
    for (const key of coverKeys) (metadata as Record<string, unknown>)[key] = child.metadata?.[key];
    return { ...root, width: child.width, height: child.height, metadata };
}

/** Called only after a newly submitted run succeeds. It never dispatches, restores, or mutates task records. */
export function appendCanvasGenerationResultStack(nodes: CanvasNodeData[], resultId: string, makeId: () => string, excluded: ReadonlySet<string> = new Set()): { nodes: CanvasNodeData[]; addedConnections: CanvasConnection[]; rootId?: string } {
    const result = nodes.find(node => node.id === resultId);
    if (!result?.metadata?.generationStackSourceId || result.metadata.batchRootId || result.metadata.isBatchRoot || result.metadata.locked || excluded.has(result.id) || result.metadata.status !== "success" || !result.metadata.storageKey && !result.metadata.content) return { nodes, addedConnections: [] };
    const key = signature(result);
    if (!key) return { nodes, addedConnections: [] };
    const byId = new Map(nodes.map(node => [node.id, node]));
    const eligible = (node: CanvasNodeData) => node.id !== resultId && node.type === CanvasNodeType.Image && node.metadata?.status === "success" && !node.metadata.imageTask
        && !node.metadata.isBatchRoot && !node.metadata.locked && !excluded.has(node.id) && Boolean(node.metadata.storageKey || node.metadata.content)
        && signature(node) === key && (!node.metadata.batchRootId || Boolean(byId.get(node.metadata.batchRootId)?.metadata?.generationResultStack));
    const prior = nodes.find(node => eligible(node) && (!node.metadata?.batchRootId || !excluded.has(node.metadata.batchRootId) && !byId.get(node.metadata.batchRootId)?.metadata?.locked));
    if (!prior) return { nodes, addedConnections: [] };
    const oldRoot = prior.metadata?.batchRootId ? byId.get(prior.metadata.batchRootId) : undefined;
    const rootId = oldRoot?.id || makeId();
    const childIds = oldRoot ? [...new Set([...(oldRoot.metadata?.batchChildIds || []), result.id])] : [prior.id, result.id];
    const root = oldRoot ? { ...oldRoot, metadata: { ...oldRoot.metadata, batchChildIds: childIds } }
        : canvasGenerationStackCover({ id: rootId, title: "同参数生成结果", type: CanvasNodeType.Image, position: { ...prior.position }, width: prior.width, height: prior.height,
            metadata: { isBatchRoot: true, generationResultStack: true, generationStackSourceId: result.metadata.generationStackSourceId, batchChildIds: childIds, imageBatchExpanded: false, batchUsesReferenceImages: Boolean(result.metadata.generationRecord?.references.length) } }, prior);
    const moveIds = new Set(oldRoot ? [result.id] : childIds);
    const occupied = nodes.filter(node => !moveIds.has(node.id) && node.id !== rootId).concat(root);
    const changes = new Map<string, CanvasNodeData>();
    for (const id of moveIds) {
        const node = byId.get(id)!;
        const position = placeCanvasImageOutputs(occupied, [root], { width: node.width, height: node.height }, root.position, 36);
        const child = { ...node, position, metadata: { ...node.metadata, batchRootId: rootId } };
        changes.set(id, child); occupied.push(child);
    }
    const next = nodes.map(node => node.id === rootId ? root : changes.get(node.id) || node);
    if (!oldRoot) next.push(root);
    const addedConnections: CanvasConnection[] = [...moveIds].map(id => ({ id: `${rootId}:result:${id}`, fromNodeId: rootId, toNodeId: id, kind: "generation-output" }));
    const sourceId = result.metadata.generationStackSourceId;
    if (!oldRoot && byId.has(sourceId) && !childIds.includes(sourceId)) addedConnections.unshift({ id: `${rootId}:source`, fromNodeId: sourceId, toNodeId: rootId, kind: "generation-output" });
    return { nodes: next, addedConnections, rootId };
}

/** Deleting a representative cannot lose the remaining originals; one-result stacks dissolve into that real image. */
export function reconcileCanvasGenerationStackNodes(nodes: CanvasNodeData[]): CanvasNodeData[] {
    const byId = new Map(nodes.map(node => [node.id, node])), replacements = new Map<string, CanvasNodeData>(), removed = new Set<string>();
    for (const root of nodes) {
        if (!root.metadata?.generationResultStack) continue;
        const children = [...new Set(root.metadata.batchChildIds || [])].map(id => byId.get(id)).filter((node): node is CanvasNodeData => Boolean(node && node.metadata?.batchRootId === root.id));
        if (children.length < 2) {
            removed.add(root.id);
            if (children[0]) { const { batchRootId: _root, ...metadata } = children[0].metadata!; replacements.set(children[0].id, { ...children[0], position: { ...root.position }, metadata }); }
            continue;
        }
        const primary = children.find(node => node.id === root.metadata?.primaryImageId) || children[0];
        const childIds = children.map(node => node.id);
        if (primary.id !== root.metadata.primaryImageId || childIds.length !== root.metadata.batchChildIds?.length) {
            const next = canvasGenerationStackCover(root, primary);
            replacements.set(root.id, { ...next, metadata: { ...next.metadata, batchChildIds: childIds } });
        }
    }
    return removed.size || replacements.size ? nodes.filter(node => !removed.has(node.id)).map(node => replacements.get(node.id) || node) : nodes;
}
