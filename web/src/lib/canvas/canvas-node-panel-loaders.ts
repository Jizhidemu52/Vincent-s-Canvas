export function loadCanvasConfigComposer() {
    return import("@/components/canvas/canvas-config-composer").then(({ CanvasConfigComposer }) => ({ default: CanvasConfigComposer }));
}

export function loadCanvasNodePromptPanel() {
    return import("@/components/canvas/canvas-node-prompt-panel").then(({ CanvasNodePromptPanel }) => ({ default: CanvasNodePromptPanel }));
}

export function loadCanvasQuickGeneratePanel() {
    return import("@/components/canvas/canvas-quick-generate-panel").then(({ CanvasQuickGeneratePanel }) => ({ default: CanvasQuickGeneratePanel }));
}

export function loadCanvasInspectorPanel() {
    return import("@/components/canvas/canvas-inspector-panel").then(({ CanvasInspectorPanel }) => ({ default: CanvasInspectorPanel }));
}
