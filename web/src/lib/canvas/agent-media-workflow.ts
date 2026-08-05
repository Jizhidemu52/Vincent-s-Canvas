import type { CanvasAgentMediaIntent, CanvasAgentMediaWorkflow, CanvasAgentMediaWorkflowCandidate, CanvasAgentMediaWorkflowStageStatus } from "@/types/canvas";

export type { CanvasAgentMediaIntent, CanvasAgentMediaWorkflow, CanvasAgentMediaWorkflowCandidate, CanvasAgentMediaWorkflowStageStatus } from "@/types/canvas";

export type AgentMediaIntent = CanvasAgentMediaIntent;

export type AgentMediaWorkflowModels = Pick<CanvasAgentMediaWorkflow, "imageModel" | "videoModel">;
export type AgentMediaToolDispatchInput = {
    userPrompt: string;
    toolName: string;
    toolPrompt: string;
    requestedMode?: string;
    targetGenerationMode?: string;
    autoRun?: boolean;
    ops?: Array<{ type?: unknown; mode?: unknown; prompt?: unknown }>;
    models: AgentMediaWorkflowModels;
};
export type AgentMediaToolDispatch = { kind: "workflow"; workflow: CanvasAgentMediaWorkflow } | { kind: "generation"; mode: "image" | "video" };
export type CompleteAgentMediaWorkflowStageInput = {
    status: CanvasAgentMediaWorkflowStageStatus;
    error?: unknown;
    candidates?: CanvasAgentMediaWorkflowCandidate[];
};

export const AGENT_MEDIA_CERTIFICATE_ERROR = "连接证书校验失败，请检查 API 地址、证书链或网络代理后重试。";

export type CreateAgentMediaWorkflowInput = Omit<CanvasAgentMediaWorkflow, "id" | "candidates" | "selectedCandidateNodeId" | "imageStatus" | "videoStatus"> & {
    id?: string;
    candidates?: CanvasAgentMediaWorkflowCandidate[];
    imageStatus?: CanvasAgentMediaWorkflowStageStatus;
    videoStatus?: CanvasAgentMediaWorkflowStageStatus;
};

export function classifyAgentMediaIntent(prompt: string): AgentMediaIntent {
    const normalized = prompt.toLowerCase();
    if (/\bimage[\s_-]*to[\s_-]*video\b/.test(normalized)) return "image_to_video";
    if (/(先|first)[\s\S]{0,40}(出图|生成图片|生成图像|image)[\s\S]{0,80}(再|然后|then)[\s\S]{0,40}(视频|走秀|动画|video|runway|motion|animation)/.test(normalized)) return "image_to_video";
    if (/(视频|走秀|运镜|镜头|动态|动画|短片|动作|video|runway|motion|camera|animation|clip|action)/.test(normalized)) return "video";
    return "image";
}

export function createAgentMediaWorkflow(input: CreateAgentMediaWorkflowInput): CanvasAgentMediaWorkflow {
    return {
        id: input.id || crypto.randomUUID(),
        intent: input.intent,
        prompt: input.prompt,
        imageModel: input.imageModel,
        videoModel: input.videoModel,
        candidates: input.candidates || [],
        imageStatus: input.imageStatus || (input.candidates?.some((candidate) => candidate.status === "success") ? "success" : "idle"),
        videoStatus: input.videoStatus || "idle",
        ...(input.error ? { error: input.error } : {}),
    };
}

export function createAgentMediaWorkflowForPrompt(prompt: string, models: AgentMediaWorkflowModels): CanvasAgentMediaWorkflow {
    return createAgentMediaWorkflow({ intent: classifyAgentMediaIntent(prompt), prompt, ...models });
}

export function resolveAgentMediaToolDispatch(input: AgentMediaToolDispatchInput): AgentMediaToolDispatch | null {
    const generationPrompts = generationPromptsFromOps(input.ops);
    const intent = classifyAgentMediaIntent([input.userPrompt, input.toolPrompt, ...generationPrompts].join("\n"));
    if (!isAgentMediaTool(input) && !(intent === "video" && hasModeOmittedBatchGeneration(input))) return null;
    if (intent === "image_to_video") {
        return {
            kind: "workflow",
            workflow: createAgentMediaWorkflow({ intent, prompt: input.toolPrompt || generationPrompts[0] || input.userPrompt, ...input.models }),
        };
    }
    return {
        kind: "generation",
        mode: input.toolName === "canvas_generate_video" || input.requestedMode === "video" || intent === "video" ? "video" : "image",
    };
}

export function buildWorkflowVideoStageDispatch(workflow: CanvasAgentMediaWorkflow) {
    const referenceNodeIds = videoReferenceNodeIds(workflow);
    return referenceNodeIds.length === 1 ? { mode: "video" as const, referenceNodeIds } : null;
}

export function videoReferenceNodeIds(input: Pick<CanvasAgentMediaWorkflow, "candidates" | "selectedCandidateNodeId">) {
    const selectedNodeId = input.selectedCandidateNodeId;
    return selectedNodeId && input.candidates.some((candidate) => candidate.nodeId === selectedNodeId && candidate.status === "success") ? [selectedNodeId] : [];
}

export function completeAgentMediaWorkflowStage(workflow: CanvasAgentMediaWorkflow, stage: "image" | "video", result: CompleteAgentMediaWorkflowStageInput): CanvasAgentMediaWorkflow {
    const { error: _previousError, ...withoutPreviousError } = workflow;
    if (stage === "image" && result.status === "running") {
        return { ...withoutPreviousError, candidates: [], selectedCandidateNodeId: undefined, imageStatus: "running", videoStatus: "idle" };
    }
    const candidates = result.candidates ? mergeWorkflowCandidates(workflow.candidates, result.candidates) : workflow.candidates;
    const next = {
        ...withoutPreviousError,
        candidates,
        [stage === "image" ? "imageStatus" : "videoStatus"]: result.status,
    };
    return result.status === "failed" ? { ...next, error: workflowGenerationErrorMessage(result.error) } : next;
}

export function workflowGenerationErrorMessage(error: unknown) {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "生成失败，请重试。";
    return /(?:certificate|cert|证书|tls|ssl)/i.test(message) ? AGENT_MEDIA_CERTIFICATE_ERROR : message;
}

function mergeWorkflowCandidates(current: CanvasAgentMediaWorkflowCandidate[], incoming: CanvasAgentMediaWorkflowCandidate[]) {
    const candidates = new Map(current.map((candidate) => [candidate.nodeId, candidate]));
    incoming.forEach((candidate) => candidates.set(candidate.nodeId, candidate));
    return Array.from(candidates.values());
}

function isAgentMediaTool(input: AgentMediaToolDispatchInput) {
    const { toolName: name, requestedMode, targetGenerationMode, autoRun, ops } = input;
    if (name === "canvas_generate_image" || name === "canvas_generate_video" || name === "canvas_create_image_prompt_flow") return true;
    if (name === "canvas_create_generation_flow") return requestedMode === "image" || requestedMode === "video";
    if (name === "canvas_create_config_node") return autoRun === true && isVisualGenerationMode(requestedMode);
    if (name === "canvas_run_generation") return isVisualGenerationMode(requestedMode) || isVisualGenerationMode(targetGenerationMode);
    return name === "canvas_apply_ops" && Boolean(ops?.some((op) => op.type === "run_generation" && isVisualGenerationMode(op.mode)));
}

function isVisualGenerationMode(mode: unknown) {
    return mode === "image" || mode === "video";
}

function generationPromptsFromOps(ops?: AgentMediaToolDispatchInput["ops"]): string[] {
    return ops?.flatMap((op) => (op.type === "run_generation" && typeof op.prompt === "string" ? [op.prompt] : [])) || [];
}

function hasModeOmittedBatchGeneration(input: AgentMediaToolDispatchInput) {
    return input.toolName === "canvas_apply_ops" && Boolean(input.ops?.some((op) => op.type === "run_generation" && op.mode === undefined));
}

export function selectWorkflowCandidate(workflow: CanvasAgentMediaWorkflow, nodeId: string): CanvasAgentMediaWorkflow {
    if (!workflow.candidates.some((candidate) => candidate.nodeId === nodeId && candidate.status === "success")) return workflow;
    return { ...workflow, selectedCandidateNodeId: nodeId };
}

export function canGenerateWorkflowVideo(workflow: CanvasAgentMediaWorkflow) {
    if (workflow.intent === "video") return true;
    return workflow.intent === "image_to_video" && workflow.imageStatus === "success" && workflow.candidates.some((candidate) => candidate.nodeId === workflow.selectedCandidateNodeId && candidate.status === "success");
}
