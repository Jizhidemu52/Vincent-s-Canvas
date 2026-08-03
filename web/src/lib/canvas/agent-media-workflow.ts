export type AgentMediaIntent = "image" | "video" | "image_to_video";

export type CanvasAgentMediaWorkflowCandidate = {
    nodeId: string;
    status: string;
};

export type CanvasAgentMediaWorkflow = {
    intent: AgentMediaIntent;
    prompt: string;
    imageModel?: string;
    videoModel?: string;
    candidates: CanvasAgentMediaWorkflowCandidate[];
    selectedCandidateNodeId?: string;
};

export type CreateAgentMediaWorkflowInput = Omit<CanvasAgentMediaWorkflow, "candidates" | "selectedCandidateNodeId"> & {
    candidates?: CanvasAgentMediaWorkflowCandidate[];
};

export function classifyAgentMediaIntent(prompt: string): AgentMediaIntent {
    const normalized = prompt.toLowerCase();
    if (/(先|first)[\s\S]{0,40}(出图|生成图片|生成图像|image)[\s\S]{0,80}(再|然后|then)[\s\S]{0,40}(视频|走秀|动画|video|runway|motion|animation)/.test(normalized)) return "image_to_video";
    if (/(视频|走秀|运镜|镜头|动态|动画|短片|动作|video|runway|motion|camera|animation|clip|action)/.test(normalized)) return "video";
    return "image";
}

export function createAgentMediaWorkflow(input: CreateAgentMediaWorkflowInput): CanvasAgentMediaWorkflow {
    return { ...input, candidates: input.candidates || [] };
}

export function selectWorkflowCandidate(workflow: CanvasAgentMediaWorkflow, nodeId: string): CanvasAgentMediaWorkflow {
    if (!workflow.candidates.some((candidate) => candidate.nodeId === nodeId && candidate.status === "success")) return workflow;
    return { ...workflow, selectedCandidateNodeId: nodeId };
}

export function canGenerateWorkflowVideo(workflow: CanvasAgentMediaWorkflow) {
    if (workflow.intent === "video") return true;
    return workflow.intent === "image_to_video" && workflow.candidates.some((candidate) => candidate.nodeId === workflow.selectedCandidateNodeId && candidate.status === "success");
}
