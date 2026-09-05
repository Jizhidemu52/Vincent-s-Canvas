export function loadCanvasAssistantPanel() {
    return import("@/components/canvas/canvas-assistant-panel").then(({ CanvasAssistantPanel }) => ({ default: CanvasAssistantPanel }));
}

export function loadCanvasLocalAgentPanel() {
    return import("@/components/canvas/canvas-local-agent-panel").then(({ CanvasLocalAgentPanel }) => ({ default: CanvasLocalAgentPanel }));
}
