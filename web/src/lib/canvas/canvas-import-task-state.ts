import type { CanvasNodeData } from "@/types/canvas";

/** A backup is a new project, never authority to observe another project/owner's task. */
export function clearImportedCanvasTasks(nodes: CanvasNodeData[]) {
    return nodes.map(node => {
        const metadata = node.metadata;
        if (!metadata || !(metadata.imageTask || metadata.mediaTask || metadata.videoTaskId || metadata.generationSubmissionUncertain || metadata.status === "loading")) return node;
        const { imageTask, mediaTask, videoTaskId, videoTaskCanRecover, generationSubmissionUncertain, sourceTaskId, ...rest } = metadata;
        return { ...node, metadata: { ...rest, optimizingPrompt: false, status: rest.content ? "success" as const : "idle" as const, errorDetails: undefined } };
    });
}
