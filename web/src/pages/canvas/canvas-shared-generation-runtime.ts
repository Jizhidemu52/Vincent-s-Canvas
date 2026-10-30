import { uiText } from "@/lib/i18n";
import type { Dispatch, SetStateAction } from "react";
import { nanoid } from "nanoid";
import { canvasToolKey, currentToolConfig } from "@/hooks/use-tool-config";
import { imageModelProfile } from "@/lib/image-model-settings";
import { validateImageReferences } from "@/lib/image-reference-policy";
import { configUsesSeparateImageInputs, getConfigImageInputs, getSharedConfigForTarget, getSharedConfigTargets } from "@/lib/canvas/canvas-shared-connections";
import { resolveSharedGenerationPlan, type SharedGenerationPlan } from "@/lib/canvas/canvas-shared-generation";
import { resolveCanvasImageConfig } from "@/lib/canvas/canvas-generation-model";
import { useBusinessConfigStore } from "@/stores/use-business-config-store";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData } from "@/types/canvas";
import type { ToolKey } from "../../../../shared/feature-catalog";

export type CanvasGenerationOutput = { nodeId: string; status: "success" | "failed"; url?: string; storageKey?: string; error?: string };
export type CanvasGenerationResult = { mode: CanvasGenerationMode; outputs: CanvasGenerationOutput[] };
export type SharedGenerationExecution = { plan: SharedGenerationPlan; config: AiConfig; toolKey: ToolKey; controller: AbortController; runningId: string; runId: string };
type Snapshot = { nodes: CanvasNodeData[]; connections: CanvasConnection[] };
type Runtime = {
    snapshot: Snapshot;
    getSnapshot: () => Snapshot;
    buildConfig: (node: CanvasNodeData, mode: CanvasGenerationMode) => AiConfig;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    execute: (nodeId: string, mode: CanvasGenerationMode, prompt: string, onResult?: (result: CanvasGenerationResult) => void, shared?: SharedGenerationExecution) => Promise<void>;
    recover: (nodeId: string) => Promise<CanvasGenerationOutput[] | null>;
    start: (targetNodeId: string, originNodeId: string, runningId: string) => AbortController;
    finish: (nodeId: string, controller: AbortController) => void;
    setRunning: Dispatch<SetStateAction<string | null>>;
    setNodes: Dispatch<SetStateAction<CanvasNodeData[]>>;
    message: { info: (text: string) => unknown; error: (text: string) => unknown };
};
/** Loaded on execution; all targets are validated before the first paid request. */
export async function runCanvasGeneration(
    nodeId: string, mode: CanvasGenerationMode, prompt: string,
    onResult: ((result: CanvasGenerationResult) => void) | undefined,
    { snapshot, getSnapshot, buildConfig, isAiConfigReady, execute: executeGenerateNode, recover: recoverPending, start: startGenerationRequest, finish: finishGenerationRequest, setRunning: setRunningNodeId, message }: Runtime,
) {
        let controller: AbortController | undefined;
        try {
            const source = snapshot.nodes.find((node) => node.id === nodeId);
            if (source?.metadata?.mediaTask || source?.metadata?.generationSubmissionUncertain || snapshot.nodes.some(node => node.metadata?.mediaTask && node.metadata.generationOrigin?.sourceNodeId === nodeId)) throw new Error("该结果仍有关联的未决任务，请先使用结果节点的重试处理原任务，勿重复生成");
            const inherited = source?.type === CanvasNodeType.Config ? source : getSharedConfigForTarget(nodeId, snapshot.nodes, snapshot.connections);
            if (inherited) {
                // Inspect the original run before deriving today's targets. Changing
                // mode, exclusions or wiring must not bypass an unresolved submission.
                const directOutputIds = new Set(source?.type === CanvasNodeType.Config
                    ? snapshot.connections.filter(edge => edge.kind === "generation-output" && edge.fromNodeId === inherited.id).map(edge => edge.toNodeId)
                    : []);
                const previousOutputs = snapshot.nodes.filter(node => directOutputIds.has(node.id)
                    || (node.metadata?.generationOrigin?.configNodeId === inherited.id
                        && (source?.type === CanvasNodeType.Config || node.metadata.generationOrigin.sourceNodeId === nodeId)));
                const pending = previousOutputs.filter(node => node.metadata?.imageTask);
                if (pending.length) {
                    message.info(uiText("先查询这组尚未完成的原图片任务，本次不会重复提交"));
                    const recovered = (await Promise.all(pending.map(node => recoverPending(node.id)))).flatMap(items => items || []);
                    onResult?.({ mode: inherited.metadata?.generationMode || "image", outputs: recovered });
                    return;
                }
                const unresolvedMedia = previousOutputs.some(node => node.metadata?.mediaTask || node.metadata?.generationSubmissionUncertain
                    || (node.metadata?.status !== "success" && (node.metadata?.videoTaskCanRecover || (node.metadata?.status === "loading" && node.metadata.generationOrigin?.mode !== "image"))));
                if (unresolvedMedia) throw new Error("这组仍有未完成的音视频/文本结果，请先检查原任务或结果节点，避免重复提交");
            }
            let targets = inherited ? source?.type === CanvasNodeType.Config ? getSharedConfigTargets(inherited.id, snapshot.nodes, snapshot.connections) : source ? [source] : [] : [];
            let inputTasks = false;
            let planSnapshot = snapshot;
            if (source?.type === CanvasNodeType.Config && !targets.length && (source.metadata?.generationMode || "image") === "image") {
                const images = getConfigImageInputs(source.id, snapshot.nodes, snapshot.connections);
                const base = buildConfig(source, "image");
                const { config } = resolveCanvasImageConfig(base, useBusinessConfigStore.getState(), images.length > 0);
                inputTasks = configUsesSeparateImageInputs(source, images.length, 0, imageModelProfile(config.model).requiresPrompt);
                if (inputTasks) {
                    targets = images;
                    const imageIds = new Set(images.map(image => image.id));
                    // Execution-only graph: each input becomes its own target, not another task's reference.
                    planSnapshot = { nodes: snapshot.nodes, connections: [
                        ...snapshot.connections.filter(edge => edge.toNodeId !== source.id || !imageIds.has(edge.fromNodeId)),
                        ...images.map(image => ({ id: `input-task:${source.id}:${image.id}`, fromNodeId: source.id, toNodeId: image.id, kind: "config-target" as const })),
                    ] };
                }
            }
            if (!inherited || !targets.length) {
                await executeGenerateNode(nodeId, mode, prompt, onResult);
                return;
            }
            // Resolve every input and model before starting: edits during execution affect only the next run.
            const plans = await Promise.all(targets.map(async (target) => {
                const plan = resolveSharedGenerationPlan(target.id, inherited.id, planSnapshot);
                let config = buildConfig(plan.configNode, plan.mode);
                let toolKey = canvasToolKey(plan.mode, plan.context.imageCount > 0);
                if (plan.mode === "image") ({ config, toolKey } = resolveCanvasImageConfig(config, useBusinessConfigStore.getState(), plan.context.imageCount > 0));
                else config = currentToolConfig(config, toolKey);
                config = { ...config, count: "1", canvasImageCount: "1" };
                if (!isAiConfigReady(config, config.model)) throw new Error("公共配置的模型不可用，请先检查模型设置");
                if (plan.mode === "image") {
                    const profile = imageModelProfile(config.model);
                    const validation = validateImageReferences(modelOptionName(config.model), plan.context.referenceImages, profile);
                    if (!validation.valid) throw new Error(`${target.title}：${validation.message}`);
                    if (profile.requiresPrompt && !plan.prompt.trim()) throw new Error("请先填写公共配置的提示词");
                } else if (plan.mode === "video") {
                    const { videoReferenceError } = await import("@/lib/video-model-parameters");
                    const error = videoReferenceError(config, plan.context.referenceImages, plan.context.referenceVideos, plan.context.referenceAudios);
                    if (error) throw new Error(`${target.title}：${error}`);
                } else if (!plan.prompt.trim()) throw new Error(`${target.title}：缺少输入文本或提示词`);
                return { plan, config, toolKey };
            }));
            const imageRoutes = new Set(plans.filter(item => item.plan.mode === "image").map(item => `${item.toolKey}:${item.config.model}`));
            if (imageRoutes.size > 1) throw new Error("这些任务对应的生成/编辑板块模型不一致，请拆成两套配置或补齐公共参考");
            const runId = nanoid();
            controller = startGenerationRequest(nodeId, nodeId, nodeId);
            setRunningNodeId(nodeId);
            const outputs: CanvasGenerationOutput[] = [];
            // Serial dispatch keeps stop behavior deterministic and bounds provider concurrency.
            for (const { plan, config, toolKey } of plans) {
                if (controller.signal.aborted) break;
                const current = getSnapshot();
                const stillConnected = inputTasks
                    ? getConfigImageInputs(inherited.id, current.nodes, current.connections).some(node => node.id === plan.targetNode.id)
                    : current.connections.some(edge => edge.kind === "config-target" && edge.fromNodeId === inherited.id && edge.toNodeId === plan.targetNode.id);
                if (!current.nodes.some(node => node.id === inherited.id) || !current.nodes.some(node => node.id === plan.targetNode.id) || !stillConnected) {
                    outputs.push({ nodeId: plan.targetNode.id, status: "failed", error: "目标或连线已删除" });
                    continue;
                }
                await executeGenerateNode(plan.targetNode.id, plan.mode, plan.prompt, (result) => outputs.push(...result.outputs), { plan, config, toolKey, controller, runningId: nodeId, runId });
            }
            const successes = outputs.filter((output) => output.status === "success").length;
            const failures = outputs.filter((output) => output.status === "failed").length;
            const canceled = controller.signal.aborted;
            if (!canceled) message.info(uiText("公共配置执行完成：{value1}/{value2} 个成功{value3}", { value1: successes, value2: plans.length, value3: failures ? uiText("，{value1} 个失败", { value1: failures }) : "" }));
            onResult?.({ mode: inherited.metadata?.generationMode || "image", outputs });
        } catch (error) {
            const detail = error instanceof Error ? error.message : "共享配置执行失败";
            message.error(detail);
            onResult?.({ mode, outputs: [{ nodeId, status: "failed", error: detail }] });
        } finally {
            if (controller) finishGenerationRequest(nodeId, controller);
            setRunningNodeId((current) => current === nodeId ? null : current);
        }
}
