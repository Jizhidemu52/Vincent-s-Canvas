import type { Dispatch, RefObject, SetStateAction } from "react";
import { createImageSequence, hasPendingImageSequenceAttempt, prepareImageSequenceStep, runImageSequence } from "@/lib/canvas/canvas-image-sequence";
import type { CanvasConnection, CanvasNodeData, CanvasNodeGroup } from "@/types/canvas";
import type { CanvasGenerationResult } from "./canvas-shared-generation-runtime";
import { imageWorkflowDefinitionKey, imageWorkflowPlanStepKey, resolveImageWorkflow } from "@/lib/canvas/canvas-image-workflow";
import { placeCanvasImageOutputs } from "@/lib/canvas/canvas-image-output-placement";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { CanvasNodeType } from "@/types/canvas";
import { nanoid } from "nanoid";
import { stopCanvasObservation } from "@/lib/canvas/canvas-project-async-lifecycle";

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
    waitForWriteAccess?: () => Promise<boolean>;
    isObservationCurrent?: () => boolean;
};
export type ImageSequenceSession = { groupId: string; nodeId?: string; controller: AbortController; configId?: string; configNodeIds?: ReadonlySet<string>; lockKey?: string; releaseLocks?: () => void; rerunStepId?: string; onlyStep?: boolean };

function readGraph(options: ImageSequenceOptions) {
    // Zustand setters are synchronous; capture async generation results without waiting for a React effect.
    options.setNodes(value => { options.nodes.current = value; return value; });
    options.setConnections(value => { options.connections.current = value; return value; });
    return { nodes: options.nodes.current, connections: options.connections.current };
}

export function addCanvasImageSequence(options: ImageSequenceOptions, sourceId: string, steps: import("@/lib/canvas/canvas-image-sequence").ImageSequenceStep[], model?: string) {
    const graph = readGraph(options);
    const source = graph.nodes.find(node => node.id === sourceId);
    if (!source) throw new Error("原图已移除，请重新选择");
    const configSize = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
    const position = placeCanvasImageOutputs(graph.nodes, [source], { width: steps.length * (configSize.width + 160) - 160, height: configSize.height }, source.position, 120);
    const created = createImageSequence(source, steps, position, model);
    options.nodes.current = [...graph.nodes, ...created.nodes]; options.setNodes(options.nodes.current);
    options.connections.current = [...graph.connections, ...created.connections]; options.setConnections(options.connections.current);
    options.groups.current = [...options.groups.current, created.group]; options.setGroups(options.groups.current);
    return created;
}

/** Groups retain progress only; they never supply the execution order. */
export function prepareCanvasImageWorkflow(options: ImageSequenceOptions, nodeId: string, rerunStepId?: string) {
    const graph = readGraph(options);
    const plan = resolveImageWorkflow(graph, nodeId);
    const definitionKey = imageWorkflowDefinitionKey(plan, graph.nodes, graph.connections);
    const ids = new Set(plan.steps.map(step => step.configNodeId));
    const existing = options.groups.current.find(group => group.imageSequence?.steps.some(step => ids.has(step.configNodeId)));
    const previous = existing?.imageSequence;
    const samePlan = previous && previous.sourceNodeId === plan.sourceNodeId && previous.steps.length === plan.steps.length
        && previous.steps.every((step, index) => step.configNodeId === plan.steps[index]?.configNodeId && step.inputConfigId === plan.steps[index]?.inputConfigId)
        && (!previous.definitionKey || previous.definitionKey === definitionKey);
    // A graph edit must not conceal an unresolved paid attempt from the previous run.
    if (!samePlan && previous?.steps.some(step => ids.has(step.configNodeId) && (step.status === "running" || hasPendingImageSequenceAttempt(graph, step.configNodeId)))) throw new Error("原工作流仍有待核查任务，请先恢复原来的连线并核查结果，不能重新提交");
    const invalidated = new Set<string>();
    let legacyKeys: unknown[] = [];
    try { if (previous?.definitionKey) legacyKeys = JSON.parse(previous.definitionKey)[1]; } catch { /* An unrecognized archive is not reusable evidence. */ }
    const steps = plan.steps.map(step => {
        const saved = previous?.steps.find(item => item.configNodeId === step.configNodeId && item.inputConfigId === step.inputConfigId);
        const key = imageWorkflowPlanStepKey(plan, step, graph);
        const legacyKey = legacyKeys[previous?.steps.findIndex(item => item.configNodeId === step.configNodeId) ?? -1];
        const matchesLegacy = Array.isArray(legacyKey) && JSON.stringify(legacyKey) === JSON.stringify(JSON.parse(key).slice(0, 7)) && !graph.nodes.find(node => node.id === step.configNodeId)?.metadata?.manualImageReferences?.length;
        const unchanged = saved && (saved.definitionKey === key || (!saved.definitionKey && (samePlan || matchesLegacy))) && previous?.sourceNodeId === plan.sourceNodeId;
        const changed = !unchanged || step.configNodeId === rerunStepId || Boolean(step.inputConfigId && invalidated.has(step.inputConfigId));
        if (changed) invalidated.add(step.configNodeId);
        if (changed && (saved?.status === "running" || hasPendingImageSequenceAttempt(graph, step.configNodeId))) throw new Error("此步骤的原任务尚未确认，请先查询原结果；未重新提交。");
        return changed ? { ...step, definitionKey: key, status: saved?.outputNodeId ? "stale" as const : "idle" as const, previousOutputIds: graph.connections.filter(edge => edge.kind === "generation-output" && edge.fromNodeId === step.configNodeId).map(edge => edge.toNodeId) } : { ...saved!, definitionKey: key };
    });
    const group: CanvasNodeGroup = {
        id: existing?.id || `workflow-${nanoid()}`, title: existing?.title || "图片工作流", collapsed: false,
        nodeIds: [...new Set([...(existing?.nodeIds || []), ...ids])],
        imageSequence: { ...plan, definitionKey, status: "idle", steps },
    };
    options.groups.current = [...options.groups.current.filter(item => item.id !== group.id).map(item => item.imageSequence?.steps.some(step => ids.has(step.configNodeId)) ? { ...item, imageSequence: undefined } : item), group];
    options.setGroups(options.groups.current);
    return group;
}

/** Lazily loaded alongside generation; the editor entry only owns UI state and the dispatch lock. */
export async function runCanvasImageSequence(current: () => ImageSequenceOptions, session: ImageSequenceSession, lockKey: string, isCurrent: () => boolean, onStart?: (groupId: string) => void, activeSessions: Iterable<ImageSequenceSession> = []) {
    if (!isCurrent() || session.controller.signal.aborted) return;
    const options = current();
    const writable = async () => {
        if (!isCurrent()) { stopCanvasObservation(session.controller); return false; }
        if (session.controller.signal.aborted) return false;
        const allowed = !options.waitForWriteAccess || await options.waitForWriteAccess();
        if (!allowed || !isCurrent() || !(options.isObservationCurrent?.() ?? true)) { stopCanvasObservation(session.controller); return false; }
        return !session.controller.signal.aborted;
    };
    if (!await writable()) return;
    const startId = session.nodeId || options.groups.current.find(group => group.id === session.groupId)?.imageSequence?.steps[0]?.configNodeId;
    if (!startId) throw new Error("请先连接图片与配置节点");
    // Claim the complete connected plan before preparing its progress record.
    // This synchronous reservation also covers clicks during the lazy import.
    const plan = resolveImageWorkflow(readGraph(options), startId);
    const ids = new Set(plan.steps.map(step => step.configNodeId));
    const groupId = options.groups.current.find(group => group.imageSequence?.steps.some(step => ids.has(step.configNodeId)))?.id;
    for (const other of activeSessions) {
        if (other !== session && other.configNodeIds && ((groupId && other.groupId === groupId) || [...ids].some(id => other.configNodeIds!.has(id)))) {
            throw new Error("此工作流或交叉节点仍在运行，请等待完成或只停止该工作流；其他独立工作流可继续运行");
        }
    }
    if ([...ids].some(id => options.locks.current.has(id))) throw new Error("此工作流的节点正在生成或提交，请等待该节点完成；其他独立工作流可继续运行");
    const locks = options.locks.current;
    for (const id of ids) locks.add(id);
    let released = false;
    session.releaseLocks = () => {
        if (released) return;
        released = true;
        for (const id of ids) locks.delete(id);
    };
    session.configNodeIds = ids;
    try {
        session.groupId = prepareCanvasImageWorkflow(options, startId, session.rerunStepId).id;
        onStart?.(session.groupId);
        await runImageSequence({
            signal: session.controller.signal,
            onlyStepId: session.onlyStep ? session.rerunStepId : undefined,
            // A late provider completion must not even refresh refs in a new canvas.
            getGraph: () => isCurrent() ? readGraph(current()) : { nodes: options.nodes.current, connections: options.connections.current },
            getGroup: () => isCurrent() ? current().groups.current.find(group => group.id === session.groupId) : undefined,
            update: group => {
                if (!isCurrent()) return;
                const options = current();
                options.groups.current = options.groups.current.map(item => item.id === group.id ? group : item);
                options.setGroups(options.groups.current);
            },
            prepare: (configId, inputId) => {
                if (!isCurrent()) { stopCanvasObservation(session.controller); return; }
                const options = current();
                const graph = prepareImageSequenceStep(readGraph(options), configId, inputId);
                options.nodes.current = graph.nodes; options.setNodes(graph.nodes);
                options.connections.current = graph.connections; options.setConnections(graph.connections);
            },
            generate: async configId => {
                if (!await writable()) return;
                if (!current().groups.current.some(group => group.id === session.groupId && group.imageSequence)) { stopCanvasObservation(session.controller); return; }
                if (JSON.stringify(resolveImageWorkflow(readGraph(current()), startId)) !== JSON.stringify(plan)) throw new Error("工作流连线已改变，后续步骤已停止，请按新连线重新运行");
                session.configId = configId;
                const result = await current().generate(configId, lockKey, session.controller.signal);
                if (!await writable()) return;
                return result;
            },
        });
        const error = isCurrent() && current().groups.current.find(group => group.id === session.groupId)?.imageSequence?.error;
        if (error) throw new Error(error);
    } finally { session.releaseLocks(); }
}
