import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    text?: string;
    active: boolean;
};

/**
 * Keeps global resource ordering available without eagerly allocating a
 * reference object for every off-screen image, video, audio, or text node.
 */
export function createCanvasResourceReferenceIndex(nodes: CanvasNodeData[], nodeById: ReadonlyMap<string, CanvasNodeData> = new Map(nodes.map((node) => [node.id, node]))) {
    const resourcePositionByNodeId = new Map<string, { kind: CanvasResourceKind; index: number }>();
    const referenceByNodeId = new Map<string, CanvasResourceReference>();
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };

    nodes.forEach((node) => {
        const kind = resourceKind(node);
        if (!kind) return;
        resourcePositionByNodeId.set(node.id, { kind, index: counts[kind]++ });
    });

    return {
        get(nodeId: string) {
            const cached = referenceByNodeId.get(nodeId);
            const node = nodeById.get(nodeId);
            const position = resourcePositionByNodeId.get(nodeId);
            if (!node || !position) return undefined;
            const reference = createResourceReference(node, position.kind, position.index, false);
            if (cached && sameReference(cached, reference)) return cached;
            referenceByNodeId.set(nodeId, reference);
            return reference;
        },
    };
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], contextNodeId?: string | null) {
    const contextNodes = contextNodeId ? getMentionResourceNodes(contextNodeId, nodes, connections) : [];
    const globalReferenceIndex = createCanvasResourceReferenceIndex(nodes);
    const globalReferences = nodes.flatMap((node) => {
        const reference = globalReferenceIndex.get(node.id);
        return reference ? [reference] : [];
    });
    return mergeCanvasResourceReferences(globalReferences, labelResourceNodes(contextNodes, true));
}

export function mergeCanvasResourceReferences(globalReferences: CanvasResourceReference[], activeReferences: CanvasResourceReference[]) {
    const activeByNodeId = new Map(activeReferences.map((reference) => [reference.nodeId, reference]));
    return globalReferences.map((reference) => activeByNodeId.get(reference.nodeId) || reference);
}

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return labelResourceNodes(getMentionResourceNodes(node.id, nodes, connections), true);
}

/**
 * Builds the relationship index once, then creates labelled references only
 * for nodes that are actually rendered or opened. This avoids allocating a
 * mention list for every off-screen node after an unrelated canvas edit.
 */
export function createCanvasMentionReferenceIndex(nodes: CanvasNodeData[], connections: CanvasConnection[], nodeById: ReadonlyMap<string, CanvasNodeData> = new Map(nodes.map((node) => [node.id, node]))) {
    const resourceInputIdsByTargetId = new Map<string, string[]>();
    const firstConfigTargetBySourceId = new Map<string, string>();
    const referencesByNodeId = new Map<string, CanvasResourceReference[]>();

    connections.forEach((connection) => {
        const source = nodeById.get(connection.fromNodeId);
        const target = nodeById.get(connection.toNodeId);
        if (!source || !target) return;
        if (isResourceNode(source)) {
            const inputIds = resourceInputIdsByTargetId.get(target.id) || [];
            inputIds.push(source.id);
            resourceInputIdsByTargetId.set(target.id, inputIds);
        }
        if (target.type === CanvasNodeType.Config && !firstConfigTargetBySourceId.has(source.id)) {
            firstConfigTargetBySourceId.set(source.id, target.id);
        }
    });

    return {
        get(nodeId: string) {
            const cached = referencesByNodeId.get(nodeId);
            const node = nodeById.get(nodeId);
            if (!node) return [];
            const configTargetId = firstConfigTargetBySourceId.get(nodeId);
            const resolveInputNodes = (targetId: string) =>
                (resourceInputIdsByTargetId.get(targetId) || [])
                    .map((inputId) => nodeById.get(inputId))
                    .filter((input): input is CanvasNodeData => Boolean(input && isResourceNode(input)));
            const configInputs = configTargetId ? resolveInputNodes(configTargetId).filter((input) => input.id !== nodeId) : [];
            const ownInputs = resolveInputNodes(nodeId);
            const resources = configInputs.length ? configInputs : ownInputs.length ? ownInputs : isResourceNode(node) ? [node] : [];
            const references = labelResourceNodes(resources, true);
            if (cached && sameReferences(cached, references)) return cached;
            referencesByNodeId.set(nodeId, references);
            return references;
        },
    };
}

export function buildNodeMentionReferencesByNodeId(nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const index = createCanvasMentionReferenceIndex(nodes, connections);
    return new Map(nodes.map((node) => [node.id, index.get(node.id)]));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    const node = nodes.find((item) => item.id === nodeId);
    return node && isResourceNode(node) ? [node] : [];
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceNodes(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceNodes(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    return [];
}

function getContextResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return connections
        .filter((connection) => connection.toNodeId === nodeId)
        .map((connection) => nodes.find((node) => node.id === connection.fromNodeId))
        .filter((node): node is CanvasNodeData => Boolean(node && isResourceNode(node)));
}

function getConnectedConfigResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((node) => node.id === connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextResourceNodes(configConnection.toNodeId, nodes, connections).filter((node) => node.id !== nodeId);
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return nodes.flatMap((node): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const index = counts[kind]++;
        return [createResourceReference(node, kind, index, active)];
    });
}

function createResourceReference(node: CanvasNodeData, kind: CanvasResourceKind, index: number, active: boolean): CanvasResourceReference {
    const label = labelForKind(kind, index);
    return {
        id: node.id,
        nodeId: node.id,
        kind,
        label,
        title: node.title || label,
        previewUrl: node.metadata?.content,
        text: node.type === CanvasNodeType.Text ? node.metadata?.content || node.metadata?.prompt : undefined,
        active,
    };
}

function sameReferences(first: CanvasResourceReference[], second: CanvasResourceReference[]) {
    return first.length === second.length && first.every((reference, index) => sameReference(reference, second[index]));
}

function sameReference(first: CanvasResourceReference, second: CanvasResourceReference) {
    return (
        first.id === second.id &&
        first.nodeId === second.nodeId &&
        first.kind === second.kind &&
        first.label === second.label &&
        first.title === second.title &&
        first.previewUrl === second.previewUrl &&
        first.text === second.text &&
        first.active === second.active
    );
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return seedanceReferenceLabel("video", index);
    if (kind === "audio") return seedanceReferenceLabel("audio", index);
    return `文本${index + 1}`;
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    return null;
}
