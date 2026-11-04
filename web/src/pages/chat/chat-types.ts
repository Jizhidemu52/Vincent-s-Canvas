import type { ParsedChatAttachment } from "@/lib/chat-attachments";
import type { CreativeImageLineage, CreativeImageWork } from "@/lib/creative-chat";
import type { ChatRegionComposite, ImageAgentRegionSelection } from "@/lib/image-agent/mask";
import type { PendingChatImageTask } from "@/services/api/chat-image-recovery";

export type ChatAttachment = Omit<ParsedChatAttachment, "kind"> & {
    id: string;
    kind?: ParsedChatAttachment["kind"];
    storageKey?: string;
};
export type ChatGeneratedImage = CreativeImageWork & {
    id: string; dataUrl: string; storageKey?: string; mimeType?: string;
    width?: number; height?: number; bytes?: number;
    prompt?: string; modelId?: string; quality?: string; resolution?: string; size?: string; lineage?: CreativeImageLineage;
    sourceTaskId?: string; sourceResultUrl?: string; regionComposite?: ChatRegionComposite;
};
export type ChatMessage = {
    id: string; parentMessageId?: string; editTargetImageId?: string;
    role: "user" | "assistant" | "error"; content: string;
    attachments?: ChatAttachment[]; generatedImages?: ChatGeneratedImage[];
    pendingImageTask?: PendingChatImageTask; stopped?: boolean; createdAt: string;
    focusImageId?: string; focusLocked?: boolean; newCreation?: boolean;
    candidateImageIds?: string[];
    /** Durable selection for explicit regenerate/edit branches; image bytes stay in storage. */
    regionSelection?: ImageAgentRegionSelection;
};
export type ChatRegionSelection = ImageAgentRegionSelection;
export type ChatSession = {
    id: string; title: string; messages: ChatMessage[]; updatedAt: string;
    chatModelId?: string; imageModelId?: string; imageQuality?: string; imageResolution?: string;
    /** Unset follows the edit base's aspect; generation keeps the existing default. */
    imageSize?: string;
    editTargetImageId?: string; canvasProjectId?: string; branchOf?: { sessionId: string; messageId: string };
    focusImageId?: string; focusLocked?: boolean; newCreation?: boolean; focusRevision?: number;
};
