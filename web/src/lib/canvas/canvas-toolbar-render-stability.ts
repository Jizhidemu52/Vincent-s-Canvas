import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { ReactNode } from "react";

export type CanvasToolbarRenderState = {
    interactionMode?: "select" | "hand";
    onInteractionModeChange?: (mode: "select" | "hand") => void;
    children?: ReactNode;
    selectedCount: number;
    canUndo: boolean;
    canRedo: boolean;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    onAddImage: () => void;
    onAddVideo: () => void;
    onAddAudio: () => void;
    onAddText: () => void;
    onAddConfig: () => void;
    onOpenQuickGenerate: () => void;
    onOpenBatchEdit: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    onDelete: () => void;
    onClear: () => void;
    onDeselect: () => void;
    onBackgroundModeChange: (mode: CanvasBackgroundMode) => void;
    onShowImageInfoChange: (show: boolean) => void;
    onOpenMyAssets: () => void;
};

/**
 * Node drag and resize previews re-render the parent at frame rate. The
 * toolbar has no preview-dependent visuals, so it can keep its DOM intact
 * until one of its inputs or action closures actually changes.
 */
export function canvasToolbarPropsEqual(previous: CanvasToolbarRenderState, next: CanvasToolbarRenderState) {
    return (
        previous.interactionMode === next.interactionMode &&
        previous.onInteractionModeChange === next.onInteractionModeChange &&
        previous.children === next.children &&
        previous.selectedCount === next.selectedCount &&
        previous.canUndo === next.canUndo &&
        previous.canRedo === next.canRedo &&
        previous.backgroundMode === next.backgroundMode &&
        previous.showImageInfo === next.showImageInfo &&
        previous.onAddImage === next.onAddImage &&
        previous.onAddVideo === next.onAddVideo &&
        previous.onAddAudio === next.onAddAudio &&
        previous.onAddText === next.onAddText &&
        previous.onAddConfig === next.onAddConfig &&
        previous.onOpenQuickGenerate === next.onOpenQuickGenerate &&
        previous.onOpenBatchEdit === next.onOpenBatchEdit &&
        previous.onUndo === next.onUndo &&
        previous.onRedo === next.onRedo &&
        previous.onUpload === next.onUpload &&
        previous.onDelete === next.onDelete &&
        previous.onClear === next.onClear &&
        previous.onDeselect === next.onDeselect &&
        previous.onBackgroundModeChange === next.onBackgroundModeChange &&
        previous.onShowImageInfoChange === next.onShowImageInfoChange &&
        previous.onOpenMyAssets === next.onOpenMyAssets
    );
}
