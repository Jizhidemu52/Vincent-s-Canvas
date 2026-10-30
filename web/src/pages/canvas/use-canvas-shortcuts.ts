import { useEffect, useLayoutEffect, useRef } from "react";
import { shouldIgnoreCanvasShortcut } from "@/lib/canvas/canvas-keyboard";
import { matchCanvasActionShortcut } from "@/lib/canvas/canvas-actions";

export type CanvasShortcutActions = {
    duplicate: () => void; group: () => void; undo: () => void; redo: () => void;
    selectAll: () => void; deleteSelection: () => void; escape: () => void;
    commands?: () => void;
    continueFromImage?: () => void;
    resetView?: () => void; fitSelection?: () => void; zoomIn?: () => void; zoomOut?: () => void; zoomActual?: () => void;
};
export function handleCanvasShortcut(event: KeyboardEvent, actions: CanvasShortcutActions) {
    if (shouldIgnoreCanvasShortcut(event, event.target, true)) return;
    const key = event.key.toLowerCase();
    const modifier = (event.metaKey || event.ctrlKey) && !event.altKey;
    // Native clipboard events carry both screenshots and browser copy semantics.
    if (modifier && ["c", "x", "v"].includes(key)) return;
    const id = matchCanvasActionShortcut(event);
    const action = id === "delete" ? actions.deleteSelection : id && id in actions ? actions[id as keyof CanvasShortcutActions] : undefined;
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
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, []);
}
