import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import type { CanvasConfigRenderSnapshot } from "@/lib/canvas/canvas-config-render-cache";
import type { CanvasGenerationMode, CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";
import { memo } from "react";
import type { useCanvasImageSequence } from "./use-canvas-image-sequence";

export type CanvasConfigContentActions = {
    handleConfigNodeChange: (id: string, patch: Partial<CanvasNodeMetadata>) => void;
    confirmStopGeneration: (id: string) => void;
    handleGenerateNode: (id: string, mode: CanvasGenerationMode, prompt: string) => Promise<void>;
    handleRetryFailedTargets?: (id: string) => Promise<void> | undefined;
    imageSequence: Pick<ReturnType<typeof useCanvasImageSequence>, "runFromNode" | "rerunStep" | "stop">;
};

/** Resolve panel state from one React graph snapshot, never last render's mutable refs. */
export const CanvasConfigNodeContent = memo(function CanvasConfigNodeContent({ node, snapshot, isRunning, actions }: {
    node: CanvasNodeData; snapshot: CanvasConfigRenderSnapshot;
    isRunning: boolean;
    actions: CanvasConfigContentActions;
}) {
    return <CanvasConfigNodePanel node={node}
        isRunning={isRunning || snapshot.workflowRunning}
        workflow={snapshot.workflow ? { status: snapshot.workflow.status, stepStatus: snapshot.workflow.stepStatus,
            onRun: () => { void actions.imageSequence.runFromNode(node.id); }, onRunStep: (onlyStep) => { void actions.imageSequence.rerunStep(node.id, onlyStep); }, onStop: actions.imageSequence.stop } : undefined}
        inputSummary={snapshot.inputSummary} inputs={snapshot.inputs}
        imageReferences={snapshot.imageReferences}
        inputImageTaskCount={snapshot.inputImageTaskCount}
        linkedTaskCount={snapshot.linkedTaskCount} linkedTaskHasImages={snapshot.linkedTaskHasImages}
        onConfigChange={actions.handleConfigNodeChange} onStop={actions.confirmStopGeneration}
        onRetryFailed={actions.handleRetryFailedTargets ? id => void actions.handleRetryFailedTargets?.(id) : undefined}
        onGenerate={() => { void actions.handleGenerateNode(node.id, node.metadata?.generationMode || "image", node.metadata?.composerContent ?? node.metadata?.prompt ?? ""); }} />;
});
