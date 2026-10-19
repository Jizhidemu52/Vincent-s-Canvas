import { useEffect, useLayoutEffect, useRef } from "react";
import { shouldIgnoreCanvasShortcut } from "@/lib/canvas/canvas-keyboard";

export type CanvasShortcutActions = {
    duplicate: () => void; group: () => void; undo: () => void; redo: () => void;
    selectAll: () => void; deleteSelection: () => void; escape: () => void;
};
export function handleCanvasShortcut(event: KeyboardEvent, actions: CanvasShortcutActions) {
    if (shouldIgnoreCanvasShortcut(event, event.target, true)) return;
    const key = event.key.toLowerCase();
    const modifier = (event.metaKey || event.ctrlKey) && !event.altKey;
    // Native clipboard events carry both screenshots and browser copy semantics.
    if (modifier && ["c", "x", "v"].includes(key)) return;
    if (modifier && !event.shiftKey && (key === "d" || key === "g")) {
        event.preventDefault();
        if (!event.repeat) (key === "d" ? actions.duplicate : actions.group)();
        return;
    }
    if (modifier && ["z", "y", "a"].includes(key)) {
        event.preventDefault();
        if (key === "a") actions.selectAll();
        else if (key === "y" || event.shiftKey) actions.redo();
        else actions.undo();
        return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        actions.deleteSelection();
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
