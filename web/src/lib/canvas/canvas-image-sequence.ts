import { nanoid } from "nanoid";
import { NODE_DEFAULT_SIZE } from "@/constant/canvas";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData, type CanvasNodeGroup, type Position } from "@/types/canvas";
import type { CanvasGenerationResult } from "@/pages/canvas/canvas-shared-generation-runtime";
import { resolveImageWorkflow } from "./canvas-image-workflow";

export type WorkflowStepType = "white_bg" | "recolor" | "on_model" | "detail_shot" | "scene" | "custom";
export type ImageSequenceStep = [title: string, instruction: string, stepType?: WorkflowStepType];
export const imageSequenceStepTypes: { value: WorkflowStepType; label: string }[] = [
    { value: "white_bg", label: "白底图" }, { value: "recolor", label: "换色" }, { value: "on_model", label: "模特上身" },
    { value: "detail_shot", label: "细节图" }, { value: "scene", label: "场景展示" }, { value: "custom", label: "自定义" },
];
export const defaultImageSequenceSteps: ImageSequenceStep[] = [
    ["抠成白底", "服装白底产品图", "white_bg"], ["改成紫色", "服装主体改成紫色", "recolor"], ["模特上身", "成人模特，正面全身，摄影棚", "on_model"],
];
type Graph = { nodes: CanvasNodeData[]; connections: CanvasConnection[] };
type Sequence = NonNullable<CanvasNodeGroup["imageSequence"]>;
const hasImage = (node?: CanvasNodeData) => node?.type === CanvasNodeType.Image && Boolean(node.metadata?.content || node.metadata?.storageKey) && node.metadata?.status !== "loading" && node.metadata?.status !== "error";
export const imageSequencePrompt = (node: CanvasNodeData) => (node.metadata?.composerContent ?? node.metadata?.prompt ?? "").replace(/@\[node:[^\]]+\]/g, "").trim();

/** A shortcut for building the same ordinary nodes and wires that users can draw manually. */
export function createImageSequence(source: CanvasNodeData, steps: readonly Readonly<ImageSequenceStep>[], position: Position, model?: string, makeId = nanoid) {
    if (!hasImage(source)) throw new Error("请选择一张已加载的图片");
    if (!steps.length || steps.length > 10 || steps.some(([title, prompt]) => !title.trim() || !prompt.trim())) throw new Error("请填写 1–10 个步骤的名称和提示词");
    const nodes: CanvasNodeData[] = steps.map(([title, prompt, stepType = "custom"], index) => ({
        ...NODE_DEFAULT_SIZE[CanvasNodeType.Config], id: makeId(), type: CanvasNodeType.Config,
        title: `${index + 1}. ${title.trim()}`, position: { x: position.x + index * (NODE_DEFAULT_SIZE[CanvasNodeType.Config].width + 160), y: position.y },
        metadata: { status: "idle", generationMode: "image", generationType: "edit", configImageInputMode: "combined", model, count: 1, promptInput: { scene: "workflow-step", fields: { step_type: stepType, instruction: prompt.trim() }, userText: prompt.trim(), referenceRoles: ["上游步骤输出图"], mode: "edit" }, prompt: prompt.trim(), composerContent: prompt.trim() },
    }));
    const group: CanvasNodeGroup = { id: `group-${makeId()}`, title: "连续改图", nodeIds: nodes.map(node => node.id), collapsed: false,
        imageSequence: { sourceNodeId: source.id, status: "idle", steps: nodes.map((node, index) => ({ configNodeId: node.id, inputConfigId: nodes[index - 1]?.id, status: "idle" })) } };
    const connections: CanvasConnection[] = [{ id: `workflow-source:${nodes[0]!.id}`, fromNodeId: source.id, toNodeId: nodes[0]!.id },
        ...nodes.slice(1).map((node, index) => ({ id: `workflow:${node.id}`, fromNodeId: nodes[index]!.id, toNodeId: node.id, kind: "config-sequence" as const }))];
    return { nodes, connections, group };
}

/** Bind a result without destroying any user-authored dependency wires. */
export function prepareImageSequenceStep(graph: Graph, configId: string, inputId: string): Graph {
    return {
        nodes: graph.nodes.map(node => node.id !== configId ? node : { ...node, metadata: { ...node.metadata,
            composerContent: `@[node:${inputId}]\n${imageSequencePrompt(node)}`, generationMode: "image", generationType: "edit", count: 1, configImageInputMode: "combined",
            excludedConnectedImageReferenceKeys: [], imageReferenceOrder: [],
        } }),
        connections: [...graph.connections.filter(edge => !(edge.toNodeId === configId && edge.kind === "sequence-input")),
            ...(graph.connections.some(edge => edge.fromNodeId === inputId && edge.toNodeId === configId && edge.kind !== "sequence-input") ? [] : [{ id: `sequence-input:${configId}`, fromNodeId: inputId, toNodeId: configId, kind: "sequence-input" as const }])],
    };
}

type Runtime = {
    signal: AbortSignal;
    getGraph: () => Graph;
    getGroup: () => CanvasNodeGroup | undefined;
    update: (group: CanvasNodeGroup) => void;
    prepare: (configId: string, inputId: string) => void;
    generate: (configId: string) => Promise<CanvasGenerationResult | undefined>;
};

/** No timer, automatic retry or background resumption: one awaited request per step. */
export async function runImageSequence(runtime: Runtime) {
    const { getGraph, getGroup, signal, update, prepare, generate } = runtime;
    const original = getGroup();
    if (!original?.imageSequence) return;
    let sequence: Sequence = structuredClone(original.imageSequence);
    const publish = () => {
        const current = getGroup();
        if (current) update({ ...current, nodeIds: [...new Set([...current.nodeIds, ...sequence.steps.flatMap(step => step.outputNodeId ? [step.outputNodeId] : [])])], imageSequence: structuredClone(sequence) });
    };
    let activeIndex = -1;
    try {
        const initial = getGraph();
        if (!hasImage(initial.nodes.find(node => node.id === sequence.sourceNodeId))) throw new Error("原图已移除或尚未加载，请恢复原图后继续");
        for (const step of sequence.steps) {
            const node = initial.nodes.find(item => item.id === step.configNodeId);
            if (node?.type !== CanvasNodeType.Config) throw new Error("流程配置已移除，请检查连线");
            if ((node.metadata?.generationMode || "image") !== "image" || !imageSequencePrompt(node)) throw new Error(`${node.title}：请使用图片模式并填写提示词`);
        }
        const topology = JSON.stringify({ sourceNodeId: sequence.sourceNodeId, steps: sequence.steps.map(({ configNodeId, inputConfigId }) => ({ configNodeId, ...(inputConfigId ? { inputConfigId } : {}) })) });
        sequence.status = "running"; sequence.error = undefined; publish();
        for (const [index, step] of sequence.steps.entries()) {
            activeIndex = index;
            if (signal.aborted || !getGroup()) break;
            const graph = getGraph();
            if (JSON.stringify(resolveImageWorkflow(graph, sequence.steps[0]!.configNodeId)) !== topology) throw new Error("工作流连线已改变，后续步骤已停止，请按新连线重新运行");
            const inputId = step.inputConfigId ? sequence.steps.find(item => item.configNodeId === step.inputConfigId)?.outputNodeId : sequence.sourceNodeId;
            if (!inputId) throw new Error("上游节点尚未产出图片，后续步骤未提交");
            if (!hasImage(graph.nodes.find(node => node.id === inputId))) throw new Error("上一步图片已移除或不可用，无法继续");
            if (step.status === "success") {
                if (!hasImage(graph.nodes.find(node => node.id === step.outputNodeId))) throw new Error("已完成的结果图已移除，请恢复图片或创建新流程");
                continue;
            }
            // An interrupted attempt may already have completed on the server. Prefer its output.
            const outputs = graph.connections.filter(edge => edge.kind === "generation-output" && edge.fromNodeId === step.configNodeId).map(edge => edge.toNodeId);
            const attemptOutputs = graph.nodes.filter(node => outputs.includes(node.id) && !step.previousOutputIds?.includes(node.id));
            const recovered = step.status !== "idle" ? attemptOutputs.find(node => node.metadata?.status === "success" && hasImage(node)) : undefined;
            if (recovered) {
                step.outputNodeId = recovered.id; step.status = "success"; publish(); continue;
            }
            if (step.status === "running" && !attemptOutputs.some(node => node.metadata?.imageTask)) throw new Error("上次请求状态尚未确认，已阻止重复提交。请先检查该步骤的结果或任务记录");
            if (step.status !== "running" && !attemptOutputs.some(node => node.metadata?.imageTask)) step.previousOutputIds = outputs;
            step.status = "running"; sequence.error = undefined; publish();
            prepare(step.configNodeId, inputId);
            if (signal.aborted) break;
            const result = await generate(step.configNodeId);
            const success = result?.mode === "image" && result.outputs.length === 1 && result.outputs[0]?.status === "success" ? result.outputs[0] : undefined;
            if (success && hasImage(getGraph().nodes.find(node => node.id === success.nodeId))) {
                step.outputNodeId = success.nodeId; step.status = "success"; publish();
            } else if (!signal.aborted) {
                throw new Error(result?.outputs.find(output => output.status === "failed")?.error || "本步未得到唯一的可用图片，后续步骤未提交");
            } else {
                // The normal generator creates its output node before submitting. If none was
                // created, cancellation happened before dispatch (for example during lazy loading).
                const dispatched = getGraph().connections.some(edge => edge.kind === "generation-output" && edge.fromNodeId === step.configNodeId && !step.previousOutputIds?.includes(edge.toNodeId));
                if (!dispatched) step.status = "idle";
            }
        }
        sequence.status = signal.aborted ? "stopped" : "success";
    } catch (error) {
        sequence.status = signal.aborted ? "stopped" : "failed";
        sequence.error = error instanceof Error ? error.message : "连续改图失败";
        // Keep unresolved requests marked running so a future continuation cannot blindly resubmit.
        const step = sequence.steps[activeIndex];
        if (step && step.status !== "success" && !sequence.error.includes("上次请求状态尚未确认")) step.status = "failed";
    }
    publish();
}
