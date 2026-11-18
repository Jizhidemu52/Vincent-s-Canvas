import { create } from "zustand";
import { persist } from "zustand/middleware";
import { canvasDiscussionFontSize, canvasPanelWidths, canvasPromptHeight, clampCanvasDiscussionFontSize, clampCanvasPanelWidth, clampCanvasPromptHeight, type CanvasPanelKind } from "@/lib/canvas/canvas-panel-width";

type CanvasPanelStore = {
    createWidth: number;
    chatWidth: number;
    discussionWidth: number;
    discussionFontSize: number;
    promptHeight: number;
    creationOpen: boolean;
    setCreationOpen: (open: boolean) => void;
    setWidth: (kind: CanvasPanelKind, width: number) => void;
    setPromptHeight: (height: number) => void;
    setDiscussionFontSize: (size: number) => void;
};

// Only small layout preferences; no project data or images are stored here.
export const useCanvasPanelStore = create<CanvasPanelStore>()(persist((set) => ({
    createWidth: canvasPanelWidths.create.default,
    chatWidth: canvasPanelWidths.chat.default,
    discussionWidth: canvasPanelWidths.discussion.default,
    discussionFontSize: canvasDiscussionFontSize.default,
    promptHeight: canvasPromptHeight.default,
    creationOpen: false,
    setCreationOpen: (creationOpen) => set({ creationOpen }),
    setWidth: (kind, width) => set({ [kind + "Width"]: clampCanvasPanelWidth(kind, width) }),
    setPromptHeight: (height) => set({ promptHeight: clampCanvasPromptHeight(height) }),
    setDiscussionFontSize: (size) => set({ discussionFontSize: clampCanvasDiscussionFontSize(size) }),
}), { name: "wireless-canvas:panel-widths" }));
