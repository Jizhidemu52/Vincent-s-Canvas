import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { CanvasRenderQuality } from "@/lib/canvas/canvas-render-quality";
import type { CanvasNodeData } from "@/types/canvas";

export type CanvasNodeRenderState = {
    data: CanvasNodeData;
    renderQuality: CanvasRenderQuality;
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    editRequestNonce: number;
    showPanel: boolean;
    showImageInfo: boolean;
    resourceLabel?: CanvasResourceReference;
    mentionReferences: CanvasResourceReference[];
    batchCount: number;
    batchExpanded: boolean;
    batchClosing: boolean;
    batchOpening: boolean;
    batchRecovering: boolean;
    batchMotion?: { x: number; y: number; index: number };
};

export function canvasNodeRenderStateEqual(previous: CanvasNodeRenderState, next: CanvasNodeRenderState) {
    return (
        previous.data === next.data &&
        previous.renderQuality === next.renderQuality &&
        previous.scale === next.scale &&
        previous.isSelected === next.isSelected &&
        previous.isRelated === next.isRelated &&
        previous.isFocusRelated === next.isFocusRelated &&
        previous.isConnectionTarget === next.isConnectionTarget &&
        previous.isConnecting === next.isConnecting &&
        previous.editRequestNonce === next.editRequestNonce &&
        previous.showPanel === next.showPanel &&
        previous.showImageInfo === next.showImageInfo &&
        previous.batchCount === next.batchCount &&
        previous.batchExpanded === next.batchExpanded &&
        previous.batchClosing === next.batchClosing &&
        previous.batchOpening === next.batchOpening &&
        previous.batchRecovering === next.batchRecovering &&
        sameMotion(previous.batchMotion, next.batchMotion) &&
        sameReference(previous.resourceLabel, next.resourceLabel) &&
        sameReferences(previous.mentionReferences, next.mentionReferences)
    );
}

function sameMotion(previous?: CanvasNodeRenderState["batchMotion"], next?: CanvasNodeRenderState["batchMotion"]) {
    return previous?.x === next?.x && previous?.y === next?.y && previous?.index === next?.index;
}

function sameReferences(previous: CanvasResourceReference[], next: CanvasResourceReference[]) {
    return previous.length === next.length && previous.every((reference, index) => sameReference(reference, next[index]));
}

function sameReference(previous?: CanvasResourceReference, next?: CanvasResourceReference) {
    return (
        previous?.id === next?.id &&
        previous?.nodeId === next?.nodeId &&
        previous?.kind === next?.kind &&
        previous?.label === next?.label &&
        previous?.title === next?.title &&
        previous?.previewUrl === next?.previewUrl &&
        previous?.text === next?.text &&
        previous?.active === next?.active
    );
}
