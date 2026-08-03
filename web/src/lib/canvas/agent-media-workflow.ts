import type { CanvasAgentMediaIntent, CanvasAgentMediaWorkflow, CanvasAgentMediaWorkflowCandidate, CanvasAgentMediaWorkflowStageStatus } from "@/types/canvas";

export type { CanvasAgentMediaIntent, CanvasAgentMediaWorkflow, CanvasAgentMediaWorkflowCandidate, CanvasAgentMediaWorkflowStageStatus } from "@/types/canvas";

export type AgentMediaIntent = CanvasAgentMediaIntent;

export type AgentMediaWorkflowModels = Pick<CanvasAgentMediaWorkflow, "imageModel" | "videoModel">;
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
        imageStatus: input.imageStatus || "idle",
        videoStatus: input.videoStatus || "idle",
        ...(input.error ? { error: input.error } : {}),
    };
}

export function createAgentMediaWorkflowForPrompt(prompt: string, models: AgentMediaWorkflowModels): CanvasAgentMediaWorkflow {
    return createAgentMediaWorkflow({ intent: classifyAgentMediaIntent(prompt), prompt, ...models });
}

export function videoReferenceNodeIds(input: Pick<CanvasAgentMediaWorkflow, "candidates" | "selectedCandidateNodeId">) {
    const selectedNodeId = input.selectedCandidateNodeId;
    return selectedNodeId && input.candidates.some((candidate) => candidate.nodeId === selectedNodeId && candidate.status === "success") ? [selectedNodeId] : [];
}

export function completeAgentMediaWorkflowStage(workflow: CanvasAgentMediaWorkflow, stage: "image" | "video", result: CompleteAgentMediaWorkflowStageInput): CanvasAgentMediaWorkflow {
    const { error: _previousError, ...withoutPreviousError } = workflow;
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

export function selectWorkflowCandidate(workflow: CanvasAgentMediaWorkflow, nodeId: string): CanvasAgentMediaWorkflow {
    if (!workflow.candidates.some((candidate) => candidate.nodeId === nodeId && candidate.status === "success")) return workflow;
    return { ...workflow, selectedCandidateNodeId: nodeId };
}

export function canGenerateWorkflowVideo(workflow: CanvasAgentMediaWorkflow) {
    if (workflow.intent === "video") return true;
    return workflow.intent === "image_to_video" && workflow.candidates.some((candidate) => candidate.nodeId === workflow.selectedCandidateNodeId && candidate.status === "success");
}
