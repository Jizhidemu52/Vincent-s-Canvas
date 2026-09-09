export type CanvasQuickGeneratePanelRenderState = {
    embedded: boolean;
    open: boolean;
    prompt: string;
    model: string;
    size: string;
    quality: string;
    count: number;
    references: readonly unknown[];
    running: boolean;
    positioned?: boolean;
    onClearPosition?: () => void;
    estimateCredits: number;
    estimateRmb: number;
    remainingCredits?: number;
    config: object;
    onClose: () => void;
    onPromptChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onSizeChange: (value: string) => void;
    onQualityChange: (value: string) => void;
    onCountChange: (value: number) => void;
    onPickReferences: () => void;
    onRemoveReference: (id: string) => void;
    onClearReferences: () => void;
    onMoveReference: (id: string, targetId: string) => void;
    onMissingConfig: () => void;
    onGenerate: () => void;
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
        previous.prompt === next.prompt &&
        previous.model === next.model &&
        previous.size === next.size &&
        previous.quality === next.quality &&
        previous.count === next.count &&
        previous.references === next.references &&
        previous.running === next.running &&
        previous.positioned === next.positioned &&
        previous.onClearPosition === next.onClearPosition &&
        previous.estimateCredits === next.estimateCredits &&
        previous.estimateRmb === next.estimateRmb &&
        previous.remainingCredits === next.remainingCredits &&
        previous.config === next.config &&
        previous.onClose === next.onClose &&
        previous.onPromptChange === next.onPromptChange &&
        previous.onModelChange === next.onModelChange &&
        previous.onSizeChange === next.onSizeChange &&
        previous.onQualityChange === next.onQualityChange &&
        previous.onCountChange === next.onCountChange &&
        previous.onPickReferences === next.onPickReferences &&
        previous.onRemoveReference === next.onRemoveReference &&
        previous.onClearReferences === next.onClearReferences &&
        previous.onMoveReference === next.onMoveReference &&
        previous.onMissingConfig === next.onMissingConfig &&
        previous.onGenerate === next.onGenerate
    );
}
