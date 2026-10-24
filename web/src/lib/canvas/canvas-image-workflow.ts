import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type ImageWorkflowGraph = { nodes: CanvasNodeData[]; connections: CanvasConnection[] };
export type ImageWorkflowPlan = { sourceNodeId: string; steps: { configNodeId: string; inputConfigId?: string }[] };

/** A dependency is distinct from a shared-config task or a historical result. */
export { imageWorkflowConnectionError } from "./canvas-shared-connections";

/** The live wires, not a group's stored list or node positions, define execution. */
export function resolveImageWorkflow(graph: ImageWorkflowGraph, nodeId: string): ImageWorkflowPlan {
    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    const edges = graph.connections.filter(edge => edge.kind === "config-sequence");
    const component = new Set<string>(), pending = [nodeId];
    while (pending.length) {
        const id = pending.pop()!;
        if (component.has(id)) continue;
        component.add(id);
        for (const edge of edges) {
            if (edge.fromNodeId === id) pending.push(edge.toNodeId);
            if (edge.toNodeId === id) pending.push(edge.fromNodeId);
        }
    }
    const parent = new Map<string, string>();
    for (const edge of edges.filter(item => component.has(item.toNodeId))) {
        if (parent.has(edge.toNodeId) && parent.get(edge.toNodeId) !== edge.fromNodeId) throw new Error("一个改图节点只能有一个上游步骤");
        parent.set(edge.toNodeId, edge.fromNodeId);
    }
    for (const id of component) {
        const node = byId.get(id);
        if (node?.type !== CanvasNodeType.Config || (node.metadata?.generationMode || "image") !== "image") throw new Error("图片工作流的步骤必须是生图配置节点");
        if (!(node.metadata?.composerContent || node.metadata?.prompt || "").replace(/@\[node:[^\]]+\]/g, "").trim()) throw new Error(`${node.title}：请先填写提示词`);
        if (graph.connections.some(edge => edge.fromNodeId === id && edge.kind === "config-target")) throw new Error(`${node.title}：请断开共享任务连线，只保留通往下一步配置的工作流连线`);
        if (node.metadata?.manualImageReferences?.length) throw new Error(`${node.title}：当前改图工作流每步使用一张上游图片，请移除额外的手动参考图`);
    }
    const roots = [...component].filter(id => !parent.has(id));
    if (roots.length !== 1) throw new Error("工作流存在循环或缺少起点，请检查连线");
    const root = roots[0]!;
    for (const id of component) {
        if (id !== root && graph.connections.some(edge => edge.toNodeId === id && edge.kind !== "sequence-input" && byId.get(edge.fromNodeId)?.type === CanvasNodeType.Image)) throw new Error(`${byId.get(id)!.title}：已接上一步输出，请移除额外的图片输入连线`);
    }
    const inputIds = new Set(graph.connections.filter(edge => edge.toNodeId === root && edge.kind !== "sequence-input" && edge.kind !== "generation-output").map(edge => edge.fromNodeId));
    const sources = [...inputIds].map(id => byId.get(id)).filter(node => node?.type === CanvasNodeType.Image);
    if (sources.length !== 1 || !(sources[0]?.metadata?.content || sources[0]?.metadata?.storageKey) || ["loading", "error"].includes(sources[0]?.metadata?.status || "")) throw new Error("请把一张已加载的原图连接到工作流第一个配置节点的左侧");
    const steps: ImageWorkflowPlan["steps"] = [], visited = new Set<string>(), ready = [root];
    while (ready.length) {
        const id = ready.shift()!;
        if (visited.has(id)) continue;
        visited.add(id); steps.push({ configNodeId: id, ...(parent.has(id) ? { inputConfigId: parent.get(id)! } : {}) });
        ready.push(...edges.filter(edge => edge.fromNodeId === id).map(edge => edge.toNodeId));
    }
    if (visited.size !== component.size) throw new Error("工作流包含循环，无法执行");
    return { sourceNodeId: sources[0]!.id, steps };
}

export function imageWorkflowDefinitionKey(plan: ImageWorkflowPlan, nodes: CanvasNodeData[]) {
    return JSON.stringify([plan, plan.steps.map(step => {
        const metadata = nodes.find(node => node.id === step.configNodeId)?.metadata;
        return [(metadata?.composerContent || metadata?.prompt || "").replace(/@\[node:[^\]]+\]/g, "").trim(), metadata?.model, metadata?.size, metadata?.quality, metadata?.imageOptions, metadata?.systemPrompt, metadata?.promptInput];
    })]);
}
