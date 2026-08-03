import type {
    CanvasAgentMediaIntent,
    CanvasAgentMediaWorkflow,
    CanvasAgentMediaWorkflowCandidate,
    CanvasAgentMediaWorkflowStageStatus,
} from "@/types/canvas";

export type {
    CanvasAgentMediaIntent,
    CanvasAgentMediaWorkflow,
    CanvasAgentMediaWorkflowCandidate,
    CanvasAgentMediaWorkflowStageStatus,
} from "@/types/canvas";

export type AgentMediaIntent = CanvasAgentMediaIntent;

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

export function selectWorkflowCandidate(workflow: CanvasAgentMediaWorkflow, nodeId: string): CanvasAgentMediaWorkflow {
    if (!workflow.candidates.some((candidate) => candidate.nodeId === nodeId && candidate.status === "success")) return workflow;
    return { ...workflow, selectedCandidateNodeId: nodeId };
}

export function canGenerateWorkflowVideo(workflow: CanvasAgentMediaWorkflow) {
    if (workflow.intent === "video") return true;
    return workflow.intent === "image_to_video" && workflow.candidates.some((candidate) => candidate.nodeId === workflow.selectedCandidateNodeId && candidate.status === "success");
}
