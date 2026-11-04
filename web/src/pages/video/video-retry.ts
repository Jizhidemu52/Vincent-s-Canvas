import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { PromptInputData } from "../../../../shared/prompt-contracts";

export type VideoRequestSnapshot = { text: string; promptInput?: PromptInputData; config: AiConfig; references: ReferenceImage[]; videoReferences: ReferenceVideo[]; audioReferences: ReferenceAudio[] };

/** Retrying a known failure uses the immutable original input, never the editable form. */
export function snapshotVideoRequest(input: VideoRequestSnapshot): VideoRequestSnapshot {
    return { text: input.text, ...(input.promptInput ? { promptInput: structuredClone(input.promptInput) } : {}), config: { ...input.config }, references: input.references.map(item => ({ ...item })), videoReferences: input.videoReferences.map(item => ({ ...item })), audioReferences: input.audioReferences.map(item => ({ ...item })) };
}
