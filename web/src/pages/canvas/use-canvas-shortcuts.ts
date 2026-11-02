import { useEffect, useLayoutEffect, useRef } from "react";
import { shouldIgnoreCanvasShortcut } from "@/lib/canvas/canvas-keyboard";
import { matchCanvasActionShortcut } from "@/lib/canvas/canvas-actions";

export type CanvasShortcutActions = {
    duplicate: () => void; group: () => void; undo: () => void; redo: () => void;
    selectAll: () => void; deleteSelection: () => void; escape: () => void;
    commands?: () => void;
    continueFromImage?: () => void;
    select?: () => void; pan?: () => void;
    ungroup?: () => void; lock?: () => void; bringFront?: () => void; sendBack?: () => void; rename?: () => void;
    nudge?: (delta: { x: number; y: number }, repeat: boolean) => void;
    resetView?: () => void; fitSelection?: () => void; zoomIn?: () => void; zoomOut?: () => void; zoomActual?: () => void;
};
export function handleCanvasShortcut(event: KeyboardEvent, actions: CanvasShortcutActions) {
    if (typeof document !== "undefined" && document.querySelector('[data-canvas-edit-blocked="true"]')) return;
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const zoomId = matchCanvasActionShortcut(event);
    if (zoomId === "zoomIn" || zoomId === "zoomOut" || zoomId === "zoomActual") {
        event.preventDefault();
        const target = event.target as Element | null;
        if (!target?.closest?.(".ant-modal,[role='dialog'],[data-canvas-local-zoom]")) actions[zoomId]?.();
        return;
    }
    if (shouldIgnoreCanvasShortcut(event, event.target, true)) return;
    if (!event.ctrlKey && !event.metaKey && !event.altKey && /^Arrow(Left|Right|Up|Down)$/.test(event.key) && actions.nudge) {
        const step = event.shiftKey ? 10 : 1;
        event.preventDefault();
        actions.nudge({ x: event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, y: event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0 }, event.repeat);
        return;
    }
    const key = event.key.toLowerCase();
    const modifier = (event.metaKey || event.ctrlKey) && !event.altKey;
    // Native clipboard events carry both screenshots and browser copy semantics.
    if (modifier && ["c", "x", "v"].includes(key)) return;
    const id = matchCanvasActionShortcut(event);
    const action = id === "delete" ? actions.deleteSelection : id && id in actions ? actions[id as Exclude<keyof CanvasShortcutActions, "nudge">] : undefined;
    if (action) {
        event.preventDefault();
        if (!event.repeat || id === "undo" || id === "redo") action();
    }
    if (event.key === "Escape") actions.escape();
}
export function useCanvasShortcuts(actions: CanvasShortcutActions) {
    const latest = useRef(actions);
    useLayoutEffect(() => { latest.current = actions; });
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => handleCanvasShortcut(event, latest.current);
        const onZoomKeyDown = (event: KeyboardEvent) => {
            const id = matchCanvasActionShortcut(event);
            if (id === "zoomIn" || id === "zoomOut" || id === "zoomActual") onKeyDown(event);
        };
        window.addEventListener("keydown", onZoomKeyDown, true);
        window.addEventListener("keydown", onKeyDown);
        return () => {
            window.removeEventListener("keydown", onZoomKeyDown, true);
            window.removeEventListener("keydown", onKeyDown);
        };
    }, []);
}
