export type CanvasPanelKind = "create" | "chat";

export const canvasPanelWidths = {
    create: { default: 480, min: 320, max: 680, cssVar: "--cw-create-width" },
    chat: { default: 480, min: 360, max: 680, cssVar: "--cw-chat-width" },
} as const;

export const canvasPromptHeight = { default: 240, min: 140, max: 480 } as const;

function clampDimension(value: number, limits: { default: number; min: number; max: number }) {
    return Number.isFinite(value) ? Math.round(Math.min(limits.max, Math.max(limits.min, value))) : limits.default;
}

export function clampCanvasPromptHeight(height: number) {
    return clampDimension(height, canvasPromptHeight);
}

export function clampCanvasPanelWidth(kind: CanvasPanelKind, width: number) {
    return clampDimension(width, canvasPanelWidths[kind]);
}
