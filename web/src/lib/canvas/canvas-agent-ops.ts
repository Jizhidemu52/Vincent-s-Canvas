import { nanoid } from "nanoid";

import { getNodeSpec } from "@/constant/canvas";
import { imageWorkflowConnectionError, normalizeCanvasConnection } from "@/lib/canvas/canvas-shared-connections";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeMetadata, type ViewportTransform } from "@/types/canvas";

export type CanvasAgentOp =
    | { type: "add_node"; id?: string; nodeType?: CanvasNodeType; title?: string; position?: { x: number; y: number }; x?: number; y?: number; width?: number; height?: number; metadata?: CanvasNodeMetadata }
    | { type: "update_node"; id: string; patch?: Partial<CanvasNodeData>; metadata?: CanvasNodeMetadata }
    | { type: "delete_node"; id?: string; ids?: string[]; nodeType?: CanvasNodeType }
    | { type: "delete_connections"; id?: string; ids?: string[]; all?: boolean }
    | { type: "connect_nodes"; id?: string; fromNodeId: string; toNodeId: string }
    | { type: "set_viewport"; viewport: ViewportTransform }
    | { type: "select_nodes"; ids: string[] }
    | { type: "run_generation"; nodeId: string; mode?: "text" | "image" | "video" | "audio"; prompt?: string };

export type CanvasAgentUndoReport = { applied: number; conflicts: Array<{ location: string; reason: string }>; retryable: boolean };

export type CanvasAgentSnapshot = {
    projectId: string;
    title: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    selectedNodeIds: string[];
    viewport: ViewportTransform;
    viewportSize?: { width: number; height: number };
    viewportOcclusions?: Array<{ x: number; y: number; width: number; height: number }>;
    previewNodeId?: string | null;
    hiddenNodeIds?: string[];
    undoReport?: CanvasAgentUndoReport;
};

export function summarizeCanvasAgentOps(ops?: CanvasAgentOp[]) {
    const counts = (Array.isArray(ops) ? ops : []).reduce<Record<string, number>>((acc, op) => {
        if (!op?.type) return acc;
        acc[op.type] = (acc[op.type] || 0) + 1;
        return acc;
    }, {});
    return Object.entries(counts)
        .map(([type, count]) => `${opLabel(type)} ${count}`)
        .join("，");
}

export function applyCanvasAgentOps(snapshot: CanvasAgentSnapshot, ops?: CanvasAgentOp[]) {
    let nodes = snapshot.nodes;
    let connections = snapshot.connections;
    let selectedNodeIds = snapshot.selectedNodeIds;
    let viewport = snapshot.viewport;

    (Array.isArray(ops) ? ops : []).forEach((op, index) => {
        if (!op?.type) return;
        if (op.type === "add_node") {
            const nodeType = Object.values(CanvasNodeType).includes(op.nodeType as CanvasNodeType) ? op.nodeType! : CanvasNodeType.Text;
            const spec = getNodeSpec(nodeType);
            const node: CanvasNodeData = {
                id: op.id || `${nodeType}-${Date.now()}-${index}`,
                type: nodeType,
                title: op.title || spec.title,
                position: op.position || { x: op.x ?? index * 36, y: op.y ?? index * 36 },
                width: op.width || spec.width,
                height: op.height || spec.height,
                metadata: { ...spec.metadata, ...op.metadata },
            };
            nodes = [...nodes, node];
            selectedNodeIds = [node.id];
        }
        if (op.type === "update_node") {
            if (!op.id) return;
            nodes = nodes.map((node) => {
                if (node.id !== op.id) return node;
                const metadata = { ...node.metadata, ...op.patch?.metadata, ...op.metadata };
                let patch = op.patch;
                if (node.type === CanvasNodeType.Image && !metadata.freeResize && (patch?.width !== undefined || patch?.height !== undefined)) {
                    const width = metadata.naturalWidth || node.width, height = metadata.naturalHeight || node.height;
                    const scale = Math.min(patch.width === undefined ? Infinity : patch.width / width, patch.height === undefined ? Infinity : patch.height / height);
                    if (!Number.isFinite(scale) || scale <= 0) throw new Error("图片节点尺寸必须大于 0");
                    patch = { ...patch, width: width * scale, height: height * scale };
                }
                return { ...node, ...patch, metadata };
            });
        }
        if (op.type === "delete_node") {
            const ids = new Set(op.ids || (op.id ? [op.id] : op.nodeType ? nodes.filter((node) => node.type === op.nodeType).map((node) => node.id) : []));
            nodes = nodes.filter((node) => !ids.has(node.id));
            connections = connections.filter((conn) => !ids.has(conn.fromNodeId) && !ids.has(conn.toNodeId));
            selectedNodeIds = selectedNodeIds.filter((id) => !ids.has(id));
        }
        if (op.type === "delete_connections") {
            const ids = new Set(op.ids || (op.id ? [op.id] : []));
            connections = op.all ? [] : connections.filter((conn) => !ids.has(conn.id));
        }
        if (op.type === "connect_nodes") {
            if (!op.fromNodeId || !op.toNodeId) return;
            const from = nodes.find(node => node.id === op.fromNodeId);
            const to = nodes.find(node => node.id === op.toNodeId);
            if (!from || !to) return;
            const edge = normalizeCanvasConnection(from, to, "source");
            if (!edge) return;
            if (imageWorkflowConnectionError(edge, connections)) return;
            if (edge.kind === "config-target" && connections.some(conn => conn.kind === "config-target" && conn.toNodeId === to.id && conn.fromNodeId !== from.id)) return;
            const existing = connections.find(conn => conn.fromNodeId === edge.fromNodeId && conn.toNodeId === edge.toNodeId);
            if (!existing) connections = [...connections, { id: op.id || nanoid(), ...edge }];
            else if (edge.kind && existing.kind !== edge.kind) connections = connections.map(conn => conn === existing ? { ...conn, kind: edge.kind } : conn);
        }
        if (op.type === "set_viewport" && op.viewport) viewport = op.viewport;
        if (op.type === "select_nodes") selectedNodeIds = (op.ids || []).filter((id) => nodes.some((node) => node.id === id));
    });

    return { ...snapshot, nodes, connections, selectedNodeIds, viewport };
}

function opLabel(type: string) {
    if (type === "add_node") return "新增节点";
    if (type === "update_node") return "更新节点";
    if (type === "delete_node") return "删除节点";
    if (type === "delete_connections") return "删除连线";
    if (type === "connect_nodes") return "连接";
    if (type === "set_viewport") return "调整视图";
    if (type === "select_nodes") return "选择节点";
    if (type === "run_generation") return "触发生成";
    return type;
}
