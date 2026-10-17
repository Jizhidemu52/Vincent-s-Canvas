import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/** Only explicit user-created target edges participate; historical result edges never fan out. */
export function getSharedConfigTargets(configId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    const byId = new Map(nodes.map(node => [node.id, node]));
    if (byId.get(configId)?.type !== CanvasNodeType.Config) return [];
    const ids = new Set(connections.filter(edge => edge.kind === "config-target" && edge.fromNodeId === configId).map(edge => edge.toNodeId));
    return [...ids].flatMap(id => {
        const node = byId.get(id);
        return node && node.type !== CanvasNodeType.Config ? [node] : [];
    });
}

export function getSharedConfigForTarget(targetId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData | undefined {
    const byId = new Map(nodes.map(node => [node.id, node]));
    if (!byId.has(targetId)) return undefined;
    const ids = new Set(connections.filter(edge => edge.kind === "config-target" && edge.toNodeId === targetId && byId.get(edge.fromNodeId)?.type === CanvasNodeType.Config).map(edge => edge.fromNodeId));
    if (ids.size > 1) throw new Error("此任务连接了多个共享配置，请只保留一个配置连接后再执行。");
    const id = ids.values().next().value;
    return id ? byId.get(id) : undefined;
}

export function normalizeCanvasConnection(first: CanvasNodeData, second: CanvasNodeData, firstHandleType: "source" | "target"): Omit<CanvasConnection, "id"> | null {
    if (first.id === second.id || (first.type === CanvasNodeType.Config && second.type === CanvasNodeType.Config)) return null;
    const [source, target] = firstHandleType === "source" ? [first, second] : [second, first];
    return { fromNodeId: source.id, toNodeId: target.id, ...(source.type === CanvasNodeType.Config ? { kind: "config-target" as const } : {}) };
}
