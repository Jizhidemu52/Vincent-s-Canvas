import { create } from "zustand";
import { persist } from "zustand/middleware";
import { canvasPanelWidths, canvasPromptHeight, clampCanvasPanelWidth, clampCanvasPromptHeight, type CanvasPanelKind } from "@/lib/canvas/canvas-panel-width";

type CanvasPanelStore = {
    createWidth: number;
    chatWidth: number;
    promptHeight: number;
    setWidth: (kind: CanvasPanelKind, width: number) => void;
    setPromptHeight: (height: number) => void;
};

// Only small layout preferences; no project data or images are stored here.
export const useCanvasPanelStore = create<CanvasPanelStore>()(persist((set) => ({
    createWidth: canvasPanelWidths.create.default,
    chatWidth: canvasPanelWidths.chat.default,
    promptHeight: canvasPromptHeight.default,
    setWidth: (kind, width) => set({ [kind + "Width"]: clampCanvasPanelWidth(kind, width) }),
    setPromptHeight: (height) => set({ promptHeight: clampCanvasPromptHeight(height) }),
}), { name: "wireless-canvas:panel-widths" }));
