import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { resolveCanvasNodeImageReferences } from "@/lib/canvas/canvas-image-references";
import { getConfigImageInputs, getSharedConfigTargets } from "@/lib/canvas/canvas-shared-connections";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup } from "@/types/canvas";
import type { ImageReferenceItem } from "@/types/image";

export type CanvasConfigInputSummary = { textCount: number; imageCount: number; videoCount: number; audioCount: number };
export type CanvasConfigRenderGraph = { nodes: CanvasNodeData[]; connections: CanvasConnection[]; groups: CanvasNodeGroup[] };
export type CanvasConfigRenderSnapshot = {
    inputSummary: CanvasConfigInputSummary;
    inputs: NodeGenerationInput[];
    imageReferences: ImageReferenceItem[];
    inputImageTaskCount: number;
    linkedTaskCount: number;
    linkedTaskHasImages: boolean;
    workflowRunning: boolean;
    workflow?: { groupId?: string; status?: string; stepStatus?: string };
};

function sameFields(first: object | undefined, second: object | undefined) {
    if (first === second) return true;
    if (!first || !second) return false;
    const keys = Object.keys(first), left = first as Record<string, unknown>, right = second as Record<string, unknown>;
    return keys.length === Object.keys(second).length && keys.every(key => left[key] === right[key]);
}
function sameItems<T>(first: T[], second: T[], same: (a: T, b: T) => boolean = Object.is) {
    return first.length === second.length && first.every((item, index) => same(item, second[index]!));
}
function sameInput(first: NodeGenerationInput, second: NodeGenerationInput) {
    return first.nodeId === second.nodeId && first.type === second.type && first.title === second.title && first.text === second.text
        && sameFields(first.image, second.image) && sameFields(first.video, second.video) && sameFields(first.audio, second.audio);
}
function sameSnapshot(first: CanvasConfigRenderSnapshot, second: CanvasConfigRenderSnapshot) {
    return sameFields(first.inputSummary, second.inputSummary) && sameItems(first.inputs, second.inputs, sameInput)
        && sameItems(first.imageReferences, second.imageReferences, sameFields)
        && first.inputImageTaskCount === second.inputImageTaskCount && first.linkedTaskCount === second.linkedTaskCount
        && first.linkedTaskHasImages === second.linkedTaskHasImages && first.workflowRunning === second.workflowRunning
        && sameFields(first.workflow, second.workflow);
}

/** Each selection is derived from the supplied React graph, not mutable page refs.
 * Graph indexes are rebuilt once per changed array; unrelated node edits retain
 * a config's snapshot and renderer identity. Media strings are never serialized.
 */
export function createCanvasConfigRenderCache() {
    let indexedNodes: CanvasNodeData[] | undefined, indexedConnections: CanvasConnection[] | undefined, indexedGroups: CanvasNodeGroup[] | undefined;
    let nodeById = new Map<string, CanvasNodeData>();
    const edgesByNode = new Map<string, CanvasConnection[]>();
    const groupByConfig = new Map<string, CanvasNodeGroup>();
    const entries = new Map<string, { metadata: CanvasNodeData["metadata"]; nodes: CanvasNodeData[]; edges: CanvasConnection[]; snapshot: CanvasConfigRenderSnapshot }>();
    return {
        select(node: CanvasNodeData, graph: CanvasConfigRenderGraph, inputSummary: CanvasConfigInputSummary, inputs: NodeGenerationInput[], activeGroupIds: ReadonlySet<string>): CanvasConfigRenderSnapshot {
            if (indexedNodes !== graph.nodes) {
                indexedNodes = graph.nodes;
                nodeById = new Map(graph.nodes.map(item => [item.id, item]));
                for (const id of entries.keys()) if (nodeById.get(id)?.type !== CanvasNodeType.Config) entries.delete(id);
            }
            if (indexedConnections !== graph.connections) {
                indexedConnections = graph.connections;
                edgesByNode.clear();
                for (const edge of graph.connections) {
                    for (const id of new Set([edge.fromNodeId, edge.toNodeId])) {
                        const list = edgesByNode.get(id) || [];
                        list.push(edge); edgesByNode.set(id, list);
                    }
                }
            }
            if (indexedGroups !== graph.groups) {
                indexedGroups = graph.groups;
                groupByConfig.clear();
                for (const group of graph.groups) for (const step of group.imageSequence?.steps || []) {
                    if (!groupByConfig.has(step.configNodeId)) groupByConfig.set(step.configNodeId, group);
                }
            }
            const edges = edgesByNode.get(node.id) || [];
            const relatedIds = new Set(edges.flatMap(edge => [edge.fromNodeId, edge.toNodeId]));
            relatedIds.delete(node.id);
            const relatedNodes = [...relatedIds].flatMap(id => nodeById.get(id) ? [nodeById.get(id)!] : []);
            const group = groupByConfig.get(node.id);
            const workflow = edges.some(edge => edge.kind === "config-sequence")
                ? { groupId: group?.id, status: group?.imageSequence?.status, stepStatus: group?.imageSequence?.steps.find(step => step.configNodeId === node.id)?.status }
                : undefined;
            const workflowRunning = Boolean(group && activeGroupIds.has(group.id));
            const previous = entries.get(node.id);
            if (previous && previous.metadata === node.metadata && sameItems(previous.nodes, relatedNodes) && sameItems(previous.edges, edges)
                && sameFields(previous.snapshot.inputSummary, inputSummary) && sameItems(previous.snapshot.inputs, inputs, sameInput)
                && previous.snapshot.workflowRunning === workflowRunning && sameFields(previous.snapshot.workflow, workflow)) return previous.snapshot;

            // Config reference resolution is one hop. Keep current connection order
            // but exclude every unrelated node so existing resolvers stay cheap.
            const nodes = [node, ...relatedNodes];
            const targets = getSharedConfigTargets(node.id, nodes, edges);
            const candidate: CanvasConfigRenderSnapshot = {
                inputSummary: { ...inputSummary }, inputs,
                imageReferences: resolveCanvasNodeImageReferences(node, nodes, edges),
                inputImageTaskCount: getConfigImageInputs(node.id, nodes, edges).length,
                linkedTaskCount: targets.length,
                linkedTaskHasImages: targets.some(item => item.type === CanvasNodeType.Image && Boolean(item.metadata?.content || item.metadata?.storageKey)),
                workflowRunning, workflow,
            };
            const snapshot = previous && sameSnapshot(previous.snapshot, candidate) ? previous.snapshot : candidate;
            entries.set(node.id, { metadata: node.metadata, nodes: relatedNodes, edges, snapshot });
            return snapshot;
        },
        clear() { entries.clear(); indexedNodes = indexedConnections = indexedGroups = undefined; nodeById.clear(); edgesByNode.clear(); groupByConfig.clear(); },
    };
}
