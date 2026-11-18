export type CanvasPanelKind = "create" | "chat" | "discussion";

export const canvasPanelWidths = {
    create: { default: 480, min: 320, max: 680, cssVar: "--cw-create-width" },
    chat: { default: 480, min: 360, max: 680, cssVar: "--cw-chat-width" },
    discussion: { default: 480, min: 380, max: 680, cssVar: "--panel-width" },
} as const;

export const canvasPromptHeight = { default: 240, min: 140, max: 480 } as const;
export const canvasDiscussionFontSize = { default: 16, min: 14, max: 20 } as const;

function clampDimension(value: number, limits: { default: number; min: number; max: number }) {
    return Number.isFinite(value) ? Math.round(Math.min(limits.max, Math.max(limits.min, value))) : limits.default;
}

export function clampCanvasPromptHeight(height: number) {
    return clampDimension(height, canvasPromptHeight);
}

export function clampCanvasDiscussionFontSize(size: number) {
    return clampDimension(size, canvasDiscussionFontSize);
}

export function clampCanvasPanelWidth(kind: CanvasPanelKind, width: number) {
    return clampDimension(width, canvasPanelWidths[kind]);
}
