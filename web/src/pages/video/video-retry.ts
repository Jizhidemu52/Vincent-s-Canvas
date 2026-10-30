import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

export type VideoRequestSnapshot = { text: string; config: AiConfig; references: ReferenceImage[]; videoReferences: ReferenceVideo[]; audioReferences: ReferenceAudio[] };

/** Retrying a known failure uses the immutable original input, never the editable form. */
export function snapshotVideoRequest(input: VideoRequestSnapshot): VideoRequestSnapshot {
    return { text: input.text, config: { ...input.config }, references: input.references.map(item => ({ ...item })), videoReferences: input.videoReferences.map(item => ({ ...item })), audioReferences: input.audioReferences.map(item => ({ ...item })) };
}
