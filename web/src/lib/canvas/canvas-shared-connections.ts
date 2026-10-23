import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

/** Incoming images can be independent jobs; never infer jobs from generated output edges. */
export function getConfigImageInputs(configId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): CanvasNodeData[] {
    const byId = new Map(nodes.map(node => [node.id, node]));
    const config = byId.get(configId);
    if (config?.type !== CanvasNodeType.Config) return [];
    const excluded = new Set(config.metadata?.excludedConnectedImageReferenceKeys || []);
    const ids = new Set(connections.filter(edge => edge.toNodeId === configId && edge.kind !== "generation-output").map(edge => edge.fromNodeId));
    return [...ids].flatMap(id => {
        const node = byId.get(id);
        return node?.type === CanvasNodeType.Image && (node.metadata?.content || node.metadata?.storageKey) && !excluded.has(`node:${id}`) ? [node] : [];
    });
}

export function configUsesSeparateImageInputs(node: CanvasNodeData, imageCount: number, linkedTaskCount: number, requiresPrompt: boolean) {
    return (node.metadata?.generationMode || "image") === "image" && requiresPrompt && !linkedTaskCount && imageCount > 1 && node.metadata?.configImageInputMode !== "combined";
}

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
    if (first.id === second.id) return null;
    const [source, target] = firstHandleType === "source" ? [first, second] : [second, first];
    if (source.type === CanvasNodeType.Config && target.type === CanvasNodeType.Config) {
        if ((source.metadata?.generationMode || "image") !== "image" || (target.metadata?.generationMode || "image") !== "image") return null;
        return { fromNodeId: source.id, toNodeId: target.id, kind: "config-sequence" };
    }
    return { fromNodeId: source.id, toNodeId: target.id, ...(source.type === CanvasNodeType.Config ? { kind: "config-target" as const } : {}) };
}

export function imageWorkflowConnectionError(edge: Omit<CanvasConnection, "id">, connections: CanvasConnection[]) {
    if (edge.kind !== "config-sequence") return undefined;
    const dependencies = connections.filter(item => item.kind === "config-sequence");
    if (dependencies.some(item => item.toNodeId === edge.toNodeId && item.fromNodeId !== edge.fromNodeId)) return "一个改图节点只能连接一个上游步骤，请先断开原来的输入连线";
    const pending = [edge.toNodeId], seen = new Set<string>();
    while (pending.length) {
        const id = pending.pop()!;
        if (id === edge.fromNodeId) return "这条连线会形成循环，请保持从原图到结果的单向流程";
        if (seen.has(id)) continue;
        seen.add(id);
        pending.push(...dependencies.filter(item => item.fromNodeId === id).map(item => item.toNodeId));
    }
    return undefined;
}
