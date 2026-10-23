import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { getConfigImageInputs, getSharedConfigTargets } from "@/lib/canvas/canvas-shared-connections";
import { resolveCanvasNodeImageReferences } from "@/lib/canvas/canvas-image-references";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData, type CanvasNodeGroup, type CanvasNodeMetadata } from "@/types/canvas";
import type { useCanvasImageSequence } from "./use-canvas-image-sequence";

export type CanvasConfigContentActions = {
    handleConfigNodeChange: (id: string, patch: Partial<CanvasNodeMetadata>) => void;
    confirmStopGeneration: (id: string) => void;
    handleGenerateNode: (id: string, mode: CanvasGenerationMode, prompt: string) => Promise<void>;
    configGenerationInputIndex: { get: (id: string) => NodeGenerationInput[] };
    imageSequence: Pick<ReturnType<typeof useCanvasImageSequence>, "activeGroupId" | "runFromNode" | "stop">;
};

/** Resolve panel state from one React graph snapshot, never last render's mutable refs. */
export function CanvasConfigNodeContent({ node, nodes, connections, groups, isRunning, inputSummary, actions }: {
    node: CanvasNodeData; nodes: CanvasNodeData[]; connections: CanvasConnection[]; groups: CanvasNodeGroup[];
    isRunning: boolean; inputSummary: { textCount: number; imageCount: number; videoCount: number; audioCount: number };
    actions: CanvasConfigContentActions;
}) {
    const targets = getSharedConfigTargets(node.id, nodes, connections);
    const group = groups.find(item => item.imageSequence?.steps.some(step => step.configNodeId === node.id));
    const connected = connections.some(edge => edge.kind === "config-sequence" && (edge.fromNodeId === node.id || edge.toNodeId === node.id));
    return <CanvasConfigNodePanel node={node}
        isRunning={isRunning || Boolean(group && actions.imageSequence.activeGroupId === group.id)}
        workflow={connected ? { status: group?.imageSequence?.status, stepStatus: group?.imageSequence?.steps.find(step => step.configNodeId === node.id)?.status,
            onRun: () => { void actions.imageSequence.runFromNode(node.id); }, onStop: actions.imageSequence.stop } : undefined}
        inputSummary={inputSummary} inputs={actions.configGenerationInputIndex.get(node.id)}
        imageReferences={resolveCanvasNodeImageReferences(node, nodes, connections)}
        inputImageTaskCount={getConfigImageInputs(node.id, nodes, connections).length}
        linkedTaskCount={targets.length} linkedTaskHasImages={targets.some(item => item.type === CanvasNodeType.Image && Boolean(item.metadata?.content || item.metadata?.storageKey))}
        onConfigChange={actions.handleConfigNodeChange} onStop={actions.confirmStopGeneration}
        onGenerate={() => { void actions.handleGenerateNode(node.id, node.metadata?.generationMode || "image", node.metadata?.composerContent ?? node.metadata?.prompt ?? ""); }} />;
}
