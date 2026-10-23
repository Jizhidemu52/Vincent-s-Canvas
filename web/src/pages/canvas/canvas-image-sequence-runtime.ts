import type { Dispatch, RefObject, SetStateAction } from "react";
import { createImageSequence, prepareImageSequenceStep, runImageSequence } from "@/lib/canvas/canvas-image-sequence";
import type { CanvasConnection, CanvasNodeData, CanvasNodeGroup } from "@/types/canvas";
import type { CanvasGenerationResult } from "./canvas-shared-generation-runtime";
import { imageWorkflowDefinitionKey, resolveImageWorkflow } from "@/lib/canvas/canvas-image-workflow";
import { nanoid } from "nanoid";

export type ImageSequenceOptions = {
    projectId: string;
    nodes: RefObject<CanvasNodeData[]>;
    connections: RefObject<CanvasConnection[]>;
    groups: RefObject<CanvasNodeGroup[]>;
    locks: RefObject<Set<string>>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    setConnections: Dispatch<SetStateAction<CanvasConnection[]>>;
    setGroups: Dispatch<SetStateAction<CanvasNodeGroup[]>>;
    generate: (configId: string, lockKey: string, signal: AbortSignal) => Promise<CanvasGenerationResult | undefined>;
    stopGeneration: (configId: string) => void;
};
export type ImageSequenceSession = { groupId: string; nodeId?: string; controller: AbortController; configId?: string };

function readGraph(options: ImageSequenceOptions) {
    // Zustand setters are synchronous; capture async generation results without waiting for a React effect.
    options.setNodes(value => { options.nodes.current = value; return value; });
    options.setConnections(value => { options.connections.current = value; return value; });
    return { nodes: options.nodes.current, connections: options.connections.current };
}

export function addCanvasImageSequence(options: ImageSequenceOptions, sourceId: string, steps: [string, string][], model?: string) {
    const graph = readGraph(options);
    const source = graph.nodes.find(node => node.id === sourceId);
    if (!source) throw new Error("原图已移除，请重新选择");
    const position = { x: Math.max(...graph.nodes.map(node => node.position.x + node.width)) + 120, y: source.position.y };
    const created = createImageSequence(source, steps, position, model);
    options.nodes.current = [...graph.nodes, ...created.nodes]; options.setNodes(options.nodes.current);
    options.connections.current = [...graph.connections, ...created.connections]; options.setConnections(options.connections.current);
    options.groups.current = [...options.groups.current, created.group]; options.setGroups(options.groups.current);
    return created;
}

/** Groups retain progress only; they never supply the execution order. */
export function prepareCanvasImageWorkflow(options: ImageSequenceOptions, nodeId: string) {
    const graph = readGraph(options);
    const plan = resolveImageWorkflow(graph, nodeId);
    const definitionKey = imageWorkflowDefinitionKey(plan, graph.nodes);
    const ids = new Set(plan.steps.map(step => step.configNodeId));
    const existing = options.groups.current.find(group => group.imageSequence?.steps.some(step => ids.has(step.configNodeId)));
    const previous = existing?.imageSequence;
    const samePlan = previous && previous.sourceNodeId === plan.sourceNodeId && previous.steps.length === plan.steps.length
        && previous.steps.every((step, index) => step.configNodeId === plan.steps[index]?.configNodeId && step.inputConfigId === plan.steps[index]?.inputConfigId)
        && (!previous.definitionKey || previous.definitionKey === definitionKey);
    // A graph edit must not conceal an unresolved paid attempt from the previous run.
    if (!samePlan && previous?.steps.some(step => step.status === "running" && ids.has(step.configNodeId))) throw new Error("原工作流仍有待核查任务，请先恢复原来的连线并核查结果，不能重新提交");
    const keepProgress = samePlan && previous.status !== "success";
    const group: CanvasNodeGroup = {
        id: existing?.id || `workflow-${nanoid()}`, title: existing?.title || "图片工作流", collapsed: false,
        nodeIds: [...new Set([...(existing?.nodeIds || []), ...ids])],
        imageSequence: keepProgress ? { ...previous, definitionKey } : { ...plan, definitionKey, status: "idle", steps: plan.steps.map(step => ({ ...step, status: "idle" })) },
    };
    options.groups.current = [...options.groups.current.filter(item => item.id !== group.id).map(item => item.imageSequence?.steps.some(step => ids.has(step.configNodeId)) ? { ...item, imageSequence: undefined } : item), group];
    options.setGroups(options.groups.current);
    return group;
}

/** Lazily loaded alongside generation; the editor entry only owns UI state and the dispatch lock. */
export async function runCanvasImageSequence(current: () => ImageSequenceOptions, session: ImageSequenceSession, lockKey: string, isCurrent: () => boolean, onStart?: (groupId: string) => void) {
    if (!isCurrent() || session.controller.signal.aborted) return;
    const options = current();
    const startId = session.nodeId || options.groups.current.find(group => group.id === session.groupId)?.imageSequence?.steps[0]?.configNodeId;
    if (!startId) throw new Error("请先连接图片与配置节点");
    session.groupId = prepareCanvasImageWorkflow(options, startId).id;
    onStart?.(session.groupId);
    await runImageSequence({
        signal: session.controller.signal,
        getGraph: () => readGraph(current()),
        getGroup: () => isCurrent() ? current().groups.current.find(group => group.id === session.groupId) : undefined,
        update: group => {
            if (!isCurrent()) return;
            const options = current();
            options.groups.current = options.groups.current.map(item => item.id === group.id ? group : item);
            options.setGroups(options.groups.current);
        },
        prepare: (configId, inputId) => {
            if (!isCurrent()) { session.controller.abort(); return; }
            const options = current();
            const graph = prepareImageSequenceStep(readGraph(options), configId, inputId);
            options.nodes.current = graph.nodes; options.setNodes(graph.nodes);
            options.connections.current = graph.connections; options.setConnections(graph.connections);
        },
        generate: async configId => {
            if (!isCurrent() || session.controller.signal.aborted) return;
            session.configId = configId;
            return current().generate(configId, lockKey, session.controller.signal);
        },
    });
    const error = isCurrent() && current().groups.current.find(group => group.id === session.groupId)?.imageSequence?.error;
    if (error) throw new Error(error);
}
