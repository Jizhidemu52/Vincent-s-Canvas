import type { ParsedChatAttachment } from "@/lib/chat-attachments";
import type { CreativeImageLineage } from "@/lib/creative-chat";
import type { PendingChatImageTask } from "@/services/api/chat-image-recovery";

export type ChatAttachment = Omit<ParsedChatAttachment, "kind"> & {
    id: string;
    kind?: ParsedChatAttachment["kind"];
    storageKey?: string;
};
export type ChatGeneratedImage = {
    id: string; dataUrl: string; storageKey?: string; mimeType?: string;
    width?: number; height?: number; bytes?: number;
    prompt?: string; modelId?: string; quality?: string; resolution?: string; lineage?: CreativeImageLineage;
};
export type ChatMessage = {
    id: string; parentMessageId?: string; editTargetImageId?: string;
    role: "user" | "assistant" | "error"; content: string;
    attachments?: ChatAttachment[]; generatedImages?: ChatGeneratedImage[];
    pendingImageTask?: PendingChatImageTask; stopped?: boolean; createdAt: string;
};
export type ChatSession = {
    id: string; title: string; messages: ChatMessage[]; updatedAt: string;
    chatModelId?: string; imageModelId?: string; imageQuality?: string; imageResolution?: string;
    editTargetImageId?: string; canvasProjectId?: string; branchOf?: { sessionId: string; messageId: string };
};
