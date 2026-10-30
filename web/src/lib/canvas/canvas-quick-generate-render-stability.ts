export type CanvasQuickGenerateSettings = {
    model: string;
    size: string;
    quality: string;
    count: number;
    imageOptions: string;
};

export type CanvasQuickGeneratePanelRenderState = {
    embedded: boolean;
    open: boolean;
    promptRef: { current: string };
    promptRevision: number;
    model: string;
    size: string;
    quality: string;
    count: number;
    imageOptions: string;
    references: readonly unknown[];
    visibleReferences?: readonly unknown[];
    sourceNode?: import("@/types/canvas").CanvasNodeData;
    derivatives?: readonly import("@/types/canvas").CanvasNodeData[];
    onPromptChange?: (value: string) => void;
    onRestorePrompt?: () => void;
    onContinue?: () => void;
    onRegenerate?: () => void;
    onRestoreGeneration?: () => void;
    onLocateDerivative?: (nodeId: string) => void;
    running: boolean;
    positioned?: boolean;
    onClearPosition?: () => void;
    estimateCredits: number;
    estimateRmb: number;
    remainingCredits?: number;
    config: object;
    onClose: () => void;
    onModelChange: (value: string) => void;
    onSizeChange: (value: string) => void;
    onQualityChange: (value: string) => void;
    onCountChange: (value: number) => void;
    onImageOptionsChange: (value: string) => void;
    onSettingsNormalize?: (settings: Partial<CanvasQuickGenerateSettings>) => void;
    onPickReferences: () => void;
    referenceScopeKey?: string;
    referencesLoading?: boolean;
    onAddReferenceFiles?: (files: File[]) => void | Promise<void>;
    onRemoveReference: (id: string) => void;
    onClearReferences: () => void;
    onMoveReference: (id: string, targetId: string) => void;
    onMissingConfig: () => void;
    onGenerate: () => void;
    onOptimizedPrompt?: (prompt: string, input: import("../../../../shared/prompt-contracts").PromptInputData, references: import("@/types/image").ReferenceImage[]) => void;
};

/**
 * The quick-generation form is independent of a node's transient drag or
 * resize position. Keeping this surface stable prevents a full Ant Design
 * form reconciliation for every canvas preview frame.
 */
export function canvasQuickGeneratePanelPropsEqual(previous: CanvasQuickGeneratePanelRenderState, next: CanvasQuickGeneratePanelRenderState) {
    return (
        previous.embedded === next.embedded &&
        previous.open === next.open &&
        previous.promptRef === next.promptRef &&
        previous.promptRevision === next.promptRevision &&
        previous.model === next.model &&
        previous.size === next.size &&
        previous.quality === next.quality &&
        previous.count === next.count &&
        previous.imageOptions === next.imageOptions &&
        previous.references === next.references &&
        (previous.visibleReferences === next.visibleReferences || (previous.visibleReferences?.length === next.visibleReferences?.length && (previous.visibleReferences || []).every((item, index) => item === next.visibleReferences?.[index]))) &&
        previous.sourceNode?.id === next.sourceNode?.id && previous.sourceNode?.metadata === next.sourceNode?.metadata &&
        previous.sourceNode?.title === next.sourceNode?.title &&
        (previous.derivatives === next.derivatives || (previous.derivatives?.length === next.derivatives?.length && (previous.derivatives || []).every((item, index) => item.id === next.derivatives?.[index].id && item.title === next.derivatives[index].title && item.metadata === next.derivatives[index].metadata))) &&
        previous.onPromptChange === next.onPromptChange && previous.onRestorePrompt === next.onRestorePrompt &&
        previous.onContinue === next.onContinue && previous.onRegenerate === next.onRegenerate && previous.onRestoreGeneration === next.onRestoreGeneration && previous.onLocateDerivative === next.onLocateDerivative &&
        previous.running === next.running &&
        previous.positioned === next.positioned &&
        previous.onClearPosition === next.onClearPosition &&
        previous.estimateCredits === next.estimateCredits &&
        previous.estimateRmb === next.estimateRmb &&
        previous.remainingCredits === next.remainingCredits &&
        previous.config === next.config &&
        previous.onClose === next.onClose &&
        previous.onModelChange === next.onModelChange &&
        previous.onSizeChange === next.onSizeChange &&
        previous.onQualityChange === next.onQualityChange &&
        previous.onCountChange === next.onCountChange &&
        previous.onImageOptionsChange === next.onImageOptionsChange &&
        previous.onSettingsNormalize === next.onSettingsNormalize &&
        previous.onPickReferences === next.onPickReferences &&
        previous.referenceScopeKey === next.referenceScopeKey &&
        previous.referencesLoading === next.referencesLoading &&
        previous.onAddReferenceFiles === next.onAddReferenceFiles &&
        previous.onRemoveReference === next.onRemoveReference &&
        previous.onClearReferences === next.onClearReferences &&
        previous.onMoveReference === next.onMoveReference &&
        previous.onMissingConfig === next.onMissingConfig &&
        previous.onGenerate === next.onGenerate && previous.onOptimizedPrompt === next.onOptimizedPrompt
    );
}
