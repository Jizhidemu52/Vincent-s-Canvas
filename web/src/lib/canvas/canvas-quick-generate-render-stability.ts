export type CanvasQuickGeneratePanelRenderState = {
    embedded: boolean;
    open: boolean;
    prompt: string;
    model: string;
    size: string;
    count: number;
    references: readonly unknown[];
    running: boolean;
    estimateCredits: number;
    estimateRmb: number;
    remainingCredits?: number;
    config: object;
    onClose: () => void;
    onPromptChange: (value: string) => void;
    onModelChange: (value: string) => void;
    onSizeChange: (value: string) => void;
    onCountChange: (value: number) => void;
    onPickReferences: () => void;
    onRemoveReference: (id: string) => void;
    onClearReferences: () => void;
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
        previous.count === next.count &&
        previous.references === next.references &&
        previous.running === next.running &&
        previous.estimateCredits === next.estimateCredits &&
        previous.estimateRmb === next.estimateRmb &&
        previous.remainingCredits === next.remainingCredits &&
        previous.config === next.config &&
        previous.onClose === next.onClose &&
        previous.onPromptChange === next.onPromptChange &&
        previous.onModelChange === next.onModelChange &&
        previous.onSizeChange === next.onSizeChange &&
        previous.onCountChange === next.onCountChange &&
        previous.onPickReferences === next.onPickReferences &&
        previous.onRemoveReference === next.onRemoveReference &&
        previous.onClearReferences === next.onClearReferences &&
        previous.onMissingConfig === next.onMissingConfig &&
        previous.onGenerate === next.onGenerate
    );
}
