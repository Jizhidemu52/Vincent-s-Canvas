export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
}

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";

export type CanvasStoredImageReference = {
    referenceKey: string;
    id: string;
    name: string;
    type: string;
    content: string;
    storageKey?: string;
    sourceNodeId?: string;
    origin: "upload" | "asset" | "canvas";
};

export type CanvasNodeMetadata = {
    originalFileName?: string;
    content?: string;
    composerContent?: string;
    prompt?: string;
    draftPrompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    videoTaskId?: string;
    videoTaskCanRecover?: boolean;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    size?: string;
    quality?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    manualImageReferences?: CanvasStoredImageReference[];
    excludedConnectedImageReferenceKeys?: string[];
    imageReferenceOrder?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    isBatchRoot?: boolean;
    batchRootId?: string;
    batchChildIds?: string[];
    batchUsesReferenceImages?: boolean;
    primaryImageId?: string;
    imageBatchExpanded?: boolean;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeType;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeType;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAgentMediaIntent = "image" | "video" | "image_to_video";
export type CanvasAgentMediaWorkflowCandidateStatus = "pending" | "success" | "failed";
export type CanvasAgentMediaWorkflowStageStatus = "idle" | "running" | "success" | "failed";

export type CanvasAgentMediaWorkflowCandidate = {
    nodeId: string;
    status: CanvasAgentMediaWorkflowCandidateStatus;
    url?: string;
    storageKey?: string;
};

export type CanvasAgentMediaWorkflowVideoResult = {
    nodeId: string;
    url: string;
    storageKey?: string;
};

export type CanvasAgentMediaWorkflow = {
    id: string;
    intent: CanvasAgentMediaIntent;
    prompt: string;
    imageModel: string;
    videoModel: string;
    imageCount: number;
    videoSeconds: string;
    aspectRatio: string;
    referenceNodeIds: string[];
    candidates: CanvasAgentMediaWorkflowCandidate[];
    selectedCandidateNodeId?: string;
    imageStatus: CanvasAgentMediaWorkflowStageStatus;
    videoStatus: CanvasAgentMediaWorkflowStageStatus;
    videoResult?: CanvasAgentMediaWorkflowVideoResult;
    error?: string;
};

export type CanvasAssistantMessageDetail = {
    mediaWorkflow?: CanvasAgentMediaWorkflow;
    [key: string]: unknown;
};

export type CanvasAssistantAttachment = {
    id: string;
    name: string;
    url: string;
    storageKey?: string;
    serverAssetId?: string;
    width?: number;
    height?: number;
    mediaType: "image" | "video";
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: CanvasAssistantMessageDetail;
    references?: CanvasAssistantReference[];
    attachments?: CanvasAssistantAttachment[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };
